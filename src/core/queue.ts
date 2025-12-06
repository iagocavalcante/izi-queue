import type { DatabaseAdapter, Job, QueueConfig } from '../types.js';
import { formatError } from './job.js';
import { executeWorker, getBackoffDelay, hasWorker } from './worker.js';
import { telemetry } from './telemetry.js';

type QueueState = 'running' | 'paused' | 'stopped';

export class Queue {
  private config: QueueConfig;
  private database: DatabaseAdapter;
  private state: QueueState = 'stopped';
  private running: Map<number, Promise<void>> = new Map();
  private pollTimer?: ReturnType<typeof setTimeout>;
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

    if (this.running.size > 0) {
      const timeout = new Promise<void>((resolve) =>
        setTimeout(resolve, gracePeriod)
      );

      await Promise.race([
        Promise.all(this.running.values()),
        timeout
      ]);
    }
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

  private schedulePoll(): void {
    if (this.state !== 'running') return;

    const interval = this.config.pollInterval ?? 1000;
    this.pollTimer = setTimeout(() => this.poll(), interval);
  }

  private async poll(): Promise<void> {
    if (this.state !== 'running') return;

    const available = this.config.limit - this.running.size;
    if (available <= 0) {
      this.schedulePoll();
      return;
    }

    try {
      const jobs = await this.database.fetchJobs(this.name, available);

      for (const job of jobs) {
        const promise = this.execute(job);
        this.running.set(job.id, promise);
        promise.finally(() => this.running.delete(job.id));
      }
    } catch (error) {
      console.error(`[izi-queue] Error fetching jobs for queue "${this.name}":`, error);
    }

    this.schedulePoll();
  }

  private async execute(job: Job): Promise<void> {
    const startTime = Date.now();

    telemetry.emit('job:start', { job, queue: this.name });

    if (!hasWorker(job.worker)) {
      const error = new Error(`Worker "${job.worker}" not registered`);
      await this.handleError(job, error, startTime);
      return;
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
