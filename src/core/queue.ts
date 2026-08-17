import type { DatabaseAdapter, DrainOutcome, Job, Logger, QueueConfig } from '../types.js';
import { formatError, sourceStatesFor } from './job.js';
import { executeWorker, getBackoffDelay, hasWorker, getWorker, terminateIsolatedJob } from './worker.js';
import { telemetry } from './telemetry.js';
import { consoleLogger } from './logger.js';

type QueueState = 'running' | 'paused' | 'stopped';

export class Queue {
  private config: QueueConfig;
  private database: DatabaseAdapter;
  private state: QueueState = 'stopped';
  private running: Map<number, Promise<void>> = new Map();
  private isolatedJobs: Set<number> = new Set();
  private abortControllers: Map<number, AbortController> = new Map();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private polling = false;
  private pollInFlight?: Promise<void>;
  private node: string;
  private logger: Logger;

  constructor(config: QueueConfig, database: DatabaseAdapter, node: string, logger: Logger = consoleLogger) {
    this.config = config;
    this.database = database;
    this.node = node;
    this.logger = logger;
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
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout' | 'done'>((resolve) => {
        graceTimer = setTimeout(() => resolve('timeout'), gracePeriod);
      });

      let result: 'timeout' | 'done';
      try {
        result = await Promise.race([
          Promise.all(this.running.values()).then(() => 'done' as const),
          timeout
        ]);
      } finally {
        // The jobs usually win the race, and the losing timer would otherwise
        // keep the event loop alive for the whole grace period -- so a process
        // that drained in a second still takes 15 to exit.
        if (graceTimer) clearTimeout(graceTimer);
      }

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
   * Resolves once any poll currently in flight has finished fetching.
   * `IziQueue.drain()` calls this right after pausing so a fetch the live
   * poller already started cannot still be claiming jobs from this queue's
   * backlog when the inline executor starts claiming its own.
   */
  async awaitInFlightPoll(): Promise<void> {
    if (this.pollInFlight) {
      await this.pollInFlight.catch(() => {});
    }
  }

  /**
   * Executes `job` synchronously through the same worker-execution path the
   * live poller uses -- `executeWorker`, then the ordinary state-machine
   * transition for whatever it returns -- and reports the outcome instead of
   * discarding it. This is the inline executor behind `IziQueue.drain()`; the
   * caller is responsible for having fetched `job` (which already marked it
   * `executing` and incremented its attempt) and for keeping the live poller
   * from fetching the same backlog concurrently.
   */
  async executeInline(job: Job): Promise<DrainOutcome> {
    return this.runJob(job);
  }

  /**
   * Interrupts `jobId` if it is currently executing on this node: fires its
   * `AbortSignal` for an in-process worker, or pre-emptively kills its
   * worker thread for an isolated one. Returns whether the job was actually
   * found running here.
   *
   * This is necessarily local. A job executing on another node cannot be
   * reached from here -- there is no signal to fire and no thread to kill --
   * so `IziQueue.cancelJob` calls this on every queue on every node's own
   * `IziQueue` instance, and each one is a no-op except on the node that
   * actually has the job. The database row is cancelled regardless (by the
   * caller, before this runs); the #35 state-transition guard is what stops
   * the other node's worker from resurrecting it once it finishes on its own.
   * Building a cross-node "stop now" signal (e.g. over LISTEN/NOTIFY) is
   * future work, not attempted here.
   */
  async cancelRunning(jobId: number): Promise<boolean> {
    const controller = this.abortControllers.get(jobId);
    if (controller) {
      if (!controller.signal.aborted) {
        controller.abort(new Error('Job cancelled'));
      }
      return true;
    }

    if (this.isolatedJobs.has(jobId)) {
      // Only kills a thread already running the job. If the pool is
      // saturated and the job is still queued waiting for one (added to
      // `isolatedJobs` before that wait begins), `ThreadPool.terminate` finds
      // nothing to kill and this is a no-op -- the job runs once a thread
      // frees up, same as before this feature, and the state-transition
      // guard still keeps it from resurrecting the cancelled row. Reaching
      // into the pool's wait queue to pre-empt a not-yet-started job would
      // need `Waiter` to carry a jobId; left as a follow-up.
      return terminateIsolatedJob(jobId, { status: 'cancel', reason: 'Job cancelled' });
    }

    return false;
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
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Error fetching jobs for queue "${this.name}"`, { error: err, queue: this.name });
      telemetry.emit('queue:fetch_error', { queue: this.name, error: err });
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
      this.logger.error(`Failed to record outcome for job ${job.id}`, { error, jobId: job.id, queue: this.name });
    }
  }

  private async runJob(job: Job): Promise<DrainOutcome> {
    const startTime = Date.now();

    telemetry.emit('job:start', { job, queue: this.name });

    if (!hasWorker(job.worker)) {
      // Deterministic: no number of retries will make the worker appear on this
      // node, so retrying only occupies fetch slots for hours before the job is
      // discarded anyway.
      await this.handleUnknownWorker(job, startTime);
      return 'discarded';
    }

    const worker = getWorker(job.worker);
    const isIsolated = worker?.isolation?.isolated === true;

    let controller: AbortController | undefined;
    if (isIsolated) {
      this.isolatedJobs.add(job.id);
    } else {
      controller = new AbortController();
      this.abortControllers.set(job.id, controller);
    }

    try {
      const result = await executeWorker(job, controller);
      const duration = Date.now() - startTime;

      switch (result.status) {
        case 'ok':
          await this.handleSuccess(job, result.value, duration);
          return 'success';
        case 'error':
          return await this.handleError(
            job,
            result.error instanceof Error ? result.error : new Error(String(result.error)),
            startTime
          );
        case 'cancel':
          await this.handleCancel(job, result.reason, duration);
          return 'cancelled';
        case 'snooze':
          await this.handleSnooze(job, result.seconds, duration);
          return 'snoozed';
      }
    } catch (error) {
      return await this.handleError(
        job,
        error instanceof Error ? error : new Error(String(error)),
        startTime
      );
    } finally {
      this.isolatedJobs.delete(job.id);
      this.abortControllers.delete(job.id);
    }
  }

  /**
   * Applies a terminal or scheduling update, letting the database refuse it if
   * the job has moved on -- cancelled by an operator, or rescued onto another
   * node. Returns whether the write landed.
   */
  private async transition(
    job: Job,
    to: Job['state'],
    updates: Partial<Job>
  ): Promise<boolean> {
    const updated = await this.database.updateJob(
      job.id,
      { state: to, ...updates },
      sourceStatesFor(to)
    );

    if (!updated) {
      telemetry.emit('job:transition_refused', {
        job,
        queue: this.name,
        result: { to }
      });
      return false;
    }

    return true;
  }

  private async handleUnknownWorker(job: Job, startTime: number): Promise<void> {
    const error = new Error(`Worker "${job.worker}" not registered`);
    const errors = [...job.errors, formatError(error, job.attempt)];

    await this.transition(job, 'discarded', {
      errors,
      discardedAt: new Date()
    });

    telemetry.emit('job:unknown_worker', {
      job: { ...job, state: 'discarded', errors },
      queue: this.name,
      duration: Date.now() - startTime,
      error
    });
  }

  private async handleSuccess(job: Job, result: unknown, duration: number): Promise<void> {
    const applied = await this.transition(job, 'completed', { completedAt: new Date() });
    if (!applied) return;

    telemetry.emit('job:complete', {
      job: { ...job, state: 'completed' },
      queue: this.name,
      duration,
      result
    });
  }

  private async handleError(
    job: Job,
    error: Error,
    startTime: number
  ): Promise<'failure' | 'discarded'> {
    const duration = Date.now() - startTime;
    const newErrors = [...job.errors, formatError(error, job.attempt)];

    if (job.attempt >= job.maxAttempts) {
      const applied = await this.transition(job, 'discarded', {
        errors: newErrors,
        discardedAt: new Date()
      });
      if (!applied) return 'discarded';

      telemetry.emit('job:error', {
        job: { ...job, state: 'discarded', errors: newErrors },
        queue: this.name,
        duration,
        error
      });
      return 'discarded';
    } else {
      const backoffMs = getBackoffDelay(job);
      const scheduledAt = new Date(Date.now() + backoffMs);

      const applied = await this.transition(job, 'retryable', {
        errors: newErrors,
        scheduledAt
      });
      if (!applied) return 'failure';

      telemetry.emit('job:error', {
        job: { ...job, state: 'retryable', errors: newErrors },
        queue: this.name,
        duration,
        error
      });
      return 'failure';
    }
  }

  private async handleCancel(job: Job, reason: string, duration: number): Promise<void> {
    const newErrors = [...job.errors, formatError(new Error(reason), job.attempt)];

    const applied = await this.transition(job, 'cancelled', {
      errors: newErrors,
      cancelledAt: new Date()
    });
    if (!applied) return;

    telemetry.emit('job:cancel', {
      job: { ...job, state: 'cancelled', errors: newErrors },
      queue: this.name,
      duration
    });
  }

  private async handleSnooze(job: Job, seconds: number, duration: number): Promise<void> {
    const scheduledAt = new Date(Date.now() + seconds * 1000);

    // The attempt was already consumed by the fetch, but a snooze is not a
    // failure: without compensating, a job that snoozes while waiting on some
    // external condition is eventually discarded having never failed once.
    const applied = await this.transition(job, 'scheduled', {
      scheduledAt,
      maxAttempts: job.maxAttempts + 1,
      meta: { ...job.meta, snoozedAt: new Date().toISOString() }
    });
    if (!applied) return;

    telemetry.emit('job:snooze', {
      job: { ...job, state: 'scheduled' },
      queue: this.name,
      duration
    });
  }
}
