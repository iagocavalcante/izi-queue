import { BasePlugin } from './plugin.js';
import { telemetry } from '../core/telemetry.js';
import { hasWorker } from '../core/worker.js';
import { JOB_STATES } from '../database/adapter.js';
import {
  assertTimezone,
  fieldsInTimezone,
  matchesCron,
  parseCron,
  type CronSchedule
} from './cron-expression.js';
import type { WorkerDefinition } from '../types.js';

/** One line of the crontab. */
export interface CronEntry<T = Record<string, unknown>> {
  /** A five-field cron expression, or one of `@hourly`/`@daily`/`@midnight`/`@weekly`/`@monthly`/`@yearly`/`@annually`. */
  expression: string;
  /** The worker to run, by name or by definition. */
  worker: string | WorkerDefinition<T>;
  /** Args for every run. Defaults to `{}`. */
  args?: T;
  /** Overrides the worker's queue. */
  queue?: string;
  /** Overrides the worker's priority. */
  priority?: number;
  /** Overrides the worker's `maxAttempts`. */
  maxAttempts?: number;
  tags?: string[];
  /** IANA timezone the expression is evaluated in. Defaults to the plugin's. */
  timezone?: string;
}

export interface CronConfig {
  crontab: CronEntry[];
  /**
   * How often the schedule is evaluated, in ms. Defaults to 60000 -- cron's
   * granularity is a minute, and evaluating more often is harmless (a minute
   * is only ever evaluated once) but buys nothing.
   */
  interval?: number;
  /** Default timezone for entries that do not set one. Defaults to `'UTC'`. */
  timezone?: string;
  /**
   * How many missed minutes a single evaluation will catch up on, at most.
   *
   * A tick delayed past its minute -- a stalled event loop, a long GC pause --
   * would otherwise drop that minute's runs on the floor. Catching up is safe
   * because every insert is keyed on the minute it belongs to, so a minute
   * another node already ran collapses into that job rather than duplicating
   * it. Bounded so that a long stall cannot produce an unbounded burst, and
   * capped at 60 so it can never reach past the pruner's default retention,
   * beyond which the deduplicating rows no longer exist.
   *
   * Defaults to 5. Set to 0 to only ever evaluate the current minute.
   */
  maxCatchUpMinutes?: number;
}

const MINUTE_MS = 60_000;
const MAX_CATCH_UP_MINUTES = 60;

/** The UTC minute an instant falls in, as `2026-08-23T14:05Z`. */
function minuteKey(instant: number): string {
  return `${new Date(Math.floor(instant / MINUTE_MS) * MINUTE_MS).toISOString().slice(0, 16)}Z`;
}

interface CompiledEntry {
  entry: CronEntry;
  schedule: CronSchedule;
  timezone: string;
  worker: string;
}

/**
 * Runs jobs on a schedule, the equivalent of `Oban.Plugins.Cron`.
 *
 * Evaluation is per whole minute and leader-only, and every insert is unique
 * on `(entry, minute)` -- belt and braces, in that order. Leadership keeps the
 * cluster from evaluating the crontab N times over; the unique key is what
 * makes the result *correct* rather than merely usually correct, since a
 * leadership handover can legitimately have two nodes evaluate the same minute.
 * Neither mechanism alone is enough: without the key, a handover duplicates
 * runs; without leadership, every node pays for an insert that all but one of
 * them will lose.
 */
export class CronPlugin extends BasePlugin {
  readonly name = 'cron';
  private config: Required<CronConfig>;
  private compiled: CompiledEntry[] = [];
  private compileErrors: string[] = [];
  /** The last minute fully evaluated, as an epoch-ms minute boundary. */
  private lastEvaluated: number | null = null;

  constructor(config: CronConfig) {
    super();
    this.config = {
      crontab: config.crontab ?? [],
      interval: config.interval ?? 60_000,
      timezone: config.timezone ?? 'UTC',
      maxCatchUpMinutes: config.maxCatchUpMinutes ?? 5
    };

    this.compile();
  }

  /**
   * Parses every entry up front so a typo surfaces through `validate()` at
   * construction -- where `IziQueue` refuses to start -- rather than as a job
   * that quietly never runs.
   */
  private compile(): void {
    this.config.crontab.forEach((entry, index) => {
      const label = `crontab[${index}]`;
      const worker = typeof entry.worker === 'string' ? entry.worker : entry.worker?.name;

      if (!worker) {
        this.compileErrors.push(`${label} has no worker`);
        return;
      }

      const timezone = entry.timezone ?? this.config.timezone;

      try {
        assertTimezone(timezone);
      } catch (error) {
        this.compileErrors.push(`${label}: ${(error as Error).message}`);
        return;
      }

      try {
        this.compiled.push({
          entry,
          schedule: parseCron(entry.expression),
          timezone,
          worker
        });
      } catch (error) {
        this.compileErrors.push(`${label}: ${(error as Error).message}`);
      }
    });
  }

  validate(): string[] {
    const errors = [...this.compileErrors];

    if (this.config.interval < 1000) {
      errors.push('Cron interval must be at least 1000ms');
    }

    // A gap longer than a minute between evaluations relies entirely on
    // catch-up to not drop minutes, which is a worse default than simply
    // ticking often enough.
    if (this.config.interval > 60_000) {
      errors.push('Cron interval must be at most 60000ms, or whole minutes would be skipped');
    }

    if (
      !Number.isInteger(this.config.maxCatchUpMinutes) ||
      this.config.maxCatchUpMinutes < 0 ||
      this.config.maxCatchUpMinutes > MAX_CATCH_UP_MINUTES
    ) {
      errors.push(`Cron maxCatchUpMinutes must be an integer between 0 and ${MAX_CATCH_UP_MINUTES}`);
    }

    return errors;
  }

  protected async onStart(): Promise<void> {
    if (!this.context) return;

    if (!this.context.insert) {
      throw new Error(
        'izi-queue: the cron plugin needs a plugin context that can insert jobs. ' +
          'IziQueue supplies one; a hand-built context must too.'
      );
    }

    // Registration normally happens before start, so an unknown worker here is
    // a real mistake -- but it is not fatal, since `register` may legitimately
    // come later.
    for (const { worker } of this.compiled) {
      if (!hasWorker(worker)) {
        this.log.warn('Cron entry references an unregistered worker', { worker });
      }
    }

    telemetry.emit('plugin:start', { queue: this.name });

    await this.tick();
    this.timer = setInterval(() => this.tick(), this.config.interval);
  }

  protected async onStop(): Promise<void> {
    this.lastEvaluated = null;
    telemetry.emit('plugin:stop', { queue: this.name });
  }

  private async tick(): Promise<void> {
    if (!this.context || !this.running) return;

    // A follower that later takes over should start from the minute it was
    // elected in, not replay everything it missed while the previous leader
    // was handling those minutes perfectly well.
    if (!this.isLeader()) {
      this.lastEvaluated = null;
      return;
    }

    try {
      for (const minute of this.minutesToEvaluate(Date.now())) {
        await this.evaluate(minute);
        this.lastEvaluated = minute;
      }
    } catch (error) {
      telemetry.emit('plugin:error', {
        queue: this.name,
        error: error instanceof Error ? error : new Error(String(error))
      });
    }
  }

  /**
   * The minute boundaries this evaluation is responsible for: the current one,
   * plus up to `maxCatchUpMinutes` that a delayed tick skipped over. Empty
   * when the current minute has already been evaluated, which is what makes a
   * sub-minute `interval` idempotent rather than a source of duplicate work.
   */
  private minutesToEvaluate(now: number): number[] {
    const current = Math.floor(now / MINUTE_MS) * MINUTE_MS;

    if (this.lastEvaluated === null) return [current];
    // Also covers a clock stepping backwards: there is nothing to replay.
    if (current <= this.lastEvaluated) return [];

    const missed = (current - this.lastEvaluated) / MINUTE_MS - 1;
    const catchUp = Math.min(missed, this.config.maxCatchUpMinutes);

    const minutes: number[] = [];
    for (let i = catchUp; i >= 0; i--) {
      minutes.push(current - i * MINUTE_MS);
    }
    return minutes;
  }

  private async evaluate(minute: number): Promise<void> {
    const key = minuteKey(minute);
    const at = new Date(minute);

    for (const compiled of this.compiled) {
      if (!matchesCron(compiled.schedule, fieldsInTimezone(at, compiled.timezone))) continue;
      await this.enqueue(compiled, key);
    }
  }

  private async enqueue(compiled: CompiledEntry, minute: string): Promise<void> {
    const { entry, schedule, timezone, worker } = compiled;

    const insert = this.context?.insert;
    if (!insert) return;

    await insert(worker, {
      args: entry.args ?? {},
      queue: entry.queue,
      priority: entry.priority,
      maxAttempts: entry.maxAttempts,
      tags: entry.tags,
      meta: { cron: true, cronExpression: schedule.expression, cronMinute: minute },
      // Scoped on the entry and the minute, so every node evaluating this
      // minute converges on one job, while the next minute's run is never
      // mistaken for a duplicate of this one -- which a time-window `period`
      // cannot promise, since two runs a minute apart can land milliseconds
      // apart in wall-clock terms.
      //
      // Every state, and no period, because the guard has to hold even once
      // the job has finished: a cron job that completes in 10ms would
      // otherwise be reinserted by the next node to evaluate the same minute.
      unique: {
        scope: `cron:${timezone}:${schedule.expression}:${minute}`,
        states: JOB_STATES,
        period: 'infinity'
      }
    });
  }
}

export function createCronPlugin(config: CronConfig): CronPlugin {
  return new CronPlugin(config);
}
