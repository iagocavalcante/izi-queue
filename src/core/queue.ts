import type { DatabaseAdapter, Job, QueueConfig } from '../types.js';
import { formatError } from './job.js';
import { executeWorker, getBackoffDelay, hasWorker, getWorker, terminateIsolatedJob } from './worker.js';
import { telemetry } from './telemetry.js';

type QueueState = 'running' | 'paused' | 'stopped';

export class Queue {
  private config: QueueConfig;
  private database: DatabaseAdapter;
  private state: QueueState = 'stopped';
  private running: Map<number, Promise<void>> = new Map();
  private isolatedJobs: Set<number> = new Set();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private polling = false;
  private pollInFlight?: Promise<void>;
  private node: string;

  constructor(config: QueueConfig, database: DatabaseAdapter, node: string) {
    this.config = config;
    this.database = database;
    this.node = node;
  }

  get name(): string {
    return this.config.name;
  }

  get limit(): number {
    return this.config.limit;
  }

  get currentState(): QueueState {
    return this.state;
  }

  get runningCount(): number {
    return this.running.size;
  }

  async start(): Promise<void> {
    if (this.state === 'running') return;

    this.state = this.config.paused ? 'paused' : 'running';
    telemetry.emit('queue:start', { queue: this.name });

    if (this.state === 'running') {
      this.schedulePoll();
    }
  }

  async stop(gracePeriod = 15000): Promise<void> {
    if (this.state === 'stopped') return;

    this.state = 'stopped';
    telemetry.emit('queue:stop', { queue: this.name });

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }

    // A poll may already have claimed jobs in the database. Let it finish
    // handing them to `running` so they are covered by the grace period below,
    // rather than starting after shutdown against a closing connection.
    if (this.pollInFlight) {
      await this.pollInFlight.catch(() => {});
    }

    if (this.running.size > 0) {
      const timeout = new Promise<'timeout' | 'done'>((resolve) =>
        setTimeout(() => resolve('timeout'), gracePeriod)
      );

      const result = await Promise.race([
        Promise.all(this.running.values()).then(() => 'done' as const),
        timeout
      ]);

      if (result === 'timeout' && this.isolatedJobs.size > 0) {
        const terminatePromises = Array.from(this.isolatedJobs).map(jobId =>
          terminateIsolatedJob(jobId).catch(() => {})
        );
        await Promise.all(terminatePromises);
      }
    }

    this.isolatedJobs.clear();
  }

  pause(): void {
    if (this.state !== 'running') return;

    this.state = 'paused';
    telemetry.emit('queue:pause', { queue: this.name });

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  resume(): void {
    if (this.state !== 'paused') return;

    this.state = 'running';
    telemetry.emit('queue:resume', { queue: this.name });
    this.schedulePoll();
  }

  scale(limit: number): void {
    this.config.limit = limit;
  }

  dispatch(): void {
    if (this.state !== 'running') return;
    this.poll();
  }

  /**
   * Schedules the next poll, replacing any pending one.
   *
   * Always clearing first is what keeps a single poll loop per queue: `dispatch()`
   * can be called arbitrarily often (once per NOTIFY, i.e. once per insert) and
   * each call must move the existing loop rather than start a new one.
   */
  private schedulePoll(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }

    if (this.state !== 'running') return;

    const interval = this.config.pollInterval ?? 1000;
    this.pollTimer = setTimeout(() => this.poll(), interval);
  }

  private async poll(): Promise<void> {
    if (this.state !== 'running') return;

    // A fetch is already in flight. Returning here is safe: the in-flight poll
    // reschedules when it finishes, and it is fetching current work anyway.
    // Without this guard, concurrent polls each size their fetch from a stale
    // `running.size` and together overshoot the queue's concurrency limit.
    if (this.polling) return;
    this.polling = true;
    this.pollInFlight = this.fetchAndStart();

    try {
      await this.pollInFlight;
    } finally {
      this.pollInFlight = undefined;
      this.polling = false;
      this.schedulePoll();
    }
  }

  private async fetchAndStart(): Promise<void> {
    try {
      const available = this.config.limit - this.running.size;
      if (available <= 0) return;

      const jobs = await this.database.fetchJobs(this.name, available, this.node);

      for (const job of jobs) {
        const promise = this.execute(job);
        this.running.set(job.id, promise);
        promise.finally(() => this.running.delete(job.id));
      }
    } catch (error) {
      console.error(`[izi-queue] Error fetching jobs for queue "${this.name}":`, error);
    }
  }

  private async execute(job: Job): Promise<void> {
    try {
      await this.runJob(job);
    } catch (error) {
      // Recording the outcome failed (a dropped connection, a closing pool).
      // The job stays `executing` in the database and the Lifeline plugin
      // returns it to the queue once this node stops heartbeating. What must
      // not happen is rejecting: nothing awaits this promise, so it would
      // surface as an unhandled rejection and take the process down.
      console.error(`[izi-queue] Failed to record outcome for job ${job.id}:`, error);
    }
  }

  private async runJob(job: Job): Promise<void> {
    const startTime = Date.now();

    telemetry.emit('job:start', { job, queue: this.name });

    if (!hasWorker(job.worker)) {
      const error = new Error(`Worker "${job.worker}" not registered`);
      await this.handleError(job, error, startTime);
      return;
    }

    const worker = getWorker(job.worker);
    const isIsolated = worker?.isolation?.isolated === true;

    if (isIsolated) {
      this.isolatedJobs.add(job.id);
    }

    try {
      const result = await executeWorker(job);
      const duration = Date.now() - startTime;

      switch (result.status) {
        case 'ok':
          await this.handleSuccess(job, result.value, duration);
          break;
        case 'error':
          await this.handleError(
            job,
            result.error instanceof Error ? result.error : new Error(String(result.error)),
            startTime
          );
          break;
        case 'cancel':
          await this.handleCancel(job, result.reason, duration);
          break;
        case 'snooze':
          await this.handleSnooze(job, result.seconds, duration);
          break;
      }
    } catch (error) {
      await this.handleError(
        job,
        error instanceof Error ? error : new Error(String(error)),
        startTime
      );
    } finally {
      this.isolatedJobs.delete(job.id);
    }
  }

  private async handleSuccess(job: Job, result: unknown, duration: number): Promise<void> {
    await this.database.updateJob(job.id, {
      state: 'completed',
      completedAt: new Date()
    });

    telemetry.emit('job:complete', {
      job: { ...job, state: 'completed' },
      queue: this.name,
      duration,
      result
    });
  }

  private async handleError(job: Job, error: Error, startTime: number): Promise<void> {
    const duration = Date.now() - startTime;
    const newErrors = [...job.errors, formatError(error, job.attempt)];

    if (job.attempt >= job.maxAttempts) {
      await this.database.updateJob(job.id, {
        state: 'discarded',
        errors: newErrors,
        discardedAt: new Date()
      });

      telemetry.emit('job:error', {
        job: { ...job, state: 'discarded', errors: newErrors },
        queue: this.name,
        duration,
        error
      });
    } else {
      const backoffMs = getBackoffDelay(job);
      const scheduledAt = new Date(Date.now() + backoffMs);

      await this.database.updateJob(job.id, {
        state: 'retryable',
        errors: newErrors,
        scheduledAt
      });

      telemetry.emit('job:error', {
        job: { ...job, state: 'retryable', errors: newErrors },
        queue: this.name,
        duration,
        error
      });
    }
  }

  private async handleCancel(job: Job, reason: string, duration: number): Promise<void> {
    const newErrors = [...job.errors, formatError(new Error(reason), job.attempt)];

    await this.database.updateJob(job.id, {
      state: 'cancelled',
      errors: newErrors,
      cancelledAt: new Date()
    });

    telemetry.emit('job:cancel', {
      job: { ...job, state: 'cancelled', errors: newErrors },
      queue: this.name,
      duration
    });
  }

  private async handleSnooze(job: Job, seconds: number, duration: number): Promise<void> {
    const scheduledAt = new Date(Date.now() + seconds * 1000);

    await this.database.updateJob(job.id, {
      state: 'scheduled',
      scheduledAt,
      meta: { ...job.meta, snoozedAt: new Date().toISOString() }
    });

    telemetry.emit('job:snooze', {
      job: { ...job, state: 'scheduled' },
      queue: this.name,
      duration
    });
  }
}
