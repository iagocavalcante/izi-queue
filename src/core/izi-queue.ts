import type {
  DatabaseAdapter,
  IziQueueConfig,
  IsolationConfig,
  Job,
  JobInsertOptions,
  JobState,
  QueueConfig,
  TelemetryEvent,
  TelemetryHandler,
  WorkerDefinition
} from '../types.js';
import type { Plugin, PluginContext } from '../plugins/plugin.js';
import { createJob } from './job.js';
import { Queue } from './queue.js';
import { telemetry } from './telemetry.js';
import {
  registerWorker,
  clearWorkers,
  getWorker,
  initializeIsolatedWorkers,
  shutdownIsolatedWorkers,
  getIsolationStats
} from './worker.js';
import { randomUUID } from 'crypto';

export interface IziQueueFullConfig extends IziQueueConfig {
  plugins?: Plugin[];
}

export interface InsertResult<T = Record<string, unknown>> {
  job: Job<T>;
  conflict: boolean;
}

export class IziQueue {
  private config: Required<Omit<IziQueueFullConfig, 'queues' | 'plugins' | 'isolation'>> & {
    queues: QueueConfig[];
    plugins: Plugin[];
    isolation?: IsolationConfig;
  };
  private queues: Map<string, Queue> = new Map();
  private stageTimer?: ReturnType<typeof setInterval>;
  private started = false;

  constructor(config: IziQueueFullConfig) {
    const queues = Array.isArray(config.queues)
      ? config.queues
      : Object.entries(config.queues).map(([name, limit]) => ({
          name,
          limit,
          paused: false,
          pollInterval: config.pollInterval ?? 1000
        }));

    this.config = {
      database: config.database,
      queues,
      plugins: config.plugins ?? [],
      node: config.node ?? `node-${randomUUID().slice(0, 8)}`,
      stageInterval: config.stageInterval ?? 1000,
      shutdownGracePeriod: config.shutdownGracePeriod ?? 15000,
      pollInterval: config.pollInterval ?? 1000,
      isolation: config.isolation
    };

    if (this.config.isolation) {
      initializeIsolatedWorkers(this.config.isolation);
    }

    for (const plugin of this.config.plugins) {
      if (plugin.validate) {
        const errors = plugin.validate();
        if (errors.length > 0) {
          throw new Error(`Plugin "${plugin.name}" validation failed: ${errors.join(', ')}`);
        }
      }
    }
  }

  get database(): DatabaseAdapter {
    return this.config.database;
  }

  get node(): string {
    return this.config.node;
  }

  get isStarted(): boolean {
    return this.started;
  }

  async migrate(): Promise<void> {
    await this.config.database.migrate();
  }

  register<T = Record<string, unknown>>(worker: WorkerDefinition<T>): this {
    registerWorker(worker);
    return this;
  }

  async start(): Promise<void> {
    if (this.started) return;

    for (const queueConfig of this.config.queues) {
      const queue = new Queue(queueConfig, this.config.database, this.config.node);
      this.queues.set(queueConfig.name, queue);
    }

    this.stageTimer = setInterval(
      () => this.stageJobs(),
      this.config.stageInterval
    );

    await Promise.all(
      Array.from(this.queues.values()).map(q => q.start())
    );

    if (this.config.database.listen) {
      await this.config.database.listen(({ queue }) => {
        this.queues.get(queue)?.dispatch();
      });
    }

    const pluginContext: PluginContext = {
      database: this.config.database,
      node: this.config.node,
      queues: Array.from(this.queues.keys())
    };

    for (const plugin of this.config.plugins) {
      await plugin.start(pluginContext);
    }

    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;

    for (const plugin of this.config.plugins) {
      await plugin.stop();
    }

    if (this.stageTimer) {
      clearInterval(this.stageTimer);
      this.stageTimer = undefined;
    }

    await Promise.all(
      Array.from(this.queues.values()).map(q =>
        q.stop(this.config.shutdownGracePeriod)
      )
    );

    this.started = false;
  }

  async shutdown(): Promise<void> {
    await this.stop();
    await shutdownIsolatedWorkers();
    await this.config.database.close();
    clearWorkers();
  }

  getIsolationStats(): {
    totalWorkers: number;
    busyWorkers: number;
    idleWorkers: number;
    pendingJobs: number;
  } | null {
    return getIsolationStats();
  }

  async insert<T = Record<string, unknown>>(
    worker: string | WorkerDefinition<T>,
    options: JobInsertOptions<T>
  ): Promise<Job<T>> {
    const result = await this.insertWithResult(worker, options);
    return result.job;
  }

  async insertWithResult<T = Record<string, unknown>>(
    worker: string | WorkerDefinition<T>,
    options: JobInsertOptions<T>
  ): Promise<InsertResult<T>> {
    const workerName = typeof worker === 'string' ? worker : worker.name;

    const workerDef = getWorker(workerName);
    const jobData = createJob(workerName, {
      ...options,
      queue: options.queue ?? workerDef?.queue ?? 'default',
      maxAttempts: options.maxAttempts ?? workerDef?.maxAttempts ?? 20,
      priority: options.priority ?? workerDef?.priority ?? 0
    });

    if (options.unique && this.config.database.checkUnique) {
      const existingJob = await this.config.database.checkUnique(
        options.unique,
        jobData as Omit<Job, 'id' | 'insertedAt'>
      );

      if (existingJob) {
        telemetry.emit('job:unique_conflict', {
          job: existingJob,
          queue: existingJob.queue
        });
        return { job: existingJob as Job<T>, conflict: true };
      }
    }

    const job = await this.config.database.insertJob(jobData as Omit<Job, 'id' | 'insertedAt'>);

    if (this.started && this.config.database.notify) {
      await this.config.database.notify(job.queue);
    }

    return { job: job as Job<T>, conflict: false };
  }

  async insertAll<T = Record<string, unknown>>(
    worker: string | WorkerDefinition<T>,
    jobs: JobInsertOptions<T>[]
  ): Promise<Job<T>[]> {
    return Promise.all(jobs.map(options => this.insert(worker, options)));
  }

  async getJob(id: number): Promise<Job | null> {
    return this.config.database.getJob(id);
  }

  async cancelJobs(criteria: {
    queue?: string;
    worker?: string;
    state?: JobState[];
  }): Promise<number> {
    return this.config.database.cancelJobs(criteria);
  }

  async pruneJobs(maxAgeSeconds = 86400 * 7): Promise<number> {
    return this.config.database.pruneJobs(maxAgeSeconds);
  }

  async rescueStuckJobs(rescueAfterSeconds = 300): Promise<number> {
    return this.config.database.rescueStuckJobs(rescueAfterSeconds);
  }

  pauseQueue(name: string): void {
    this.queues.get(name)?.pause();
  }

  resumeQueue(name: string): void {
    this.queues.get(name)?.resume();
  }

  scaleQueue(name: string, limit: number): void {
    this.queues.get(name)?.scale(limit);
  }

  getQueueStatus(name: string): {
    name: string;
    state: string;
    limit: number;
    running: number;
  } | null {
    const queue = this.queues.get(name);
    if (!queue) return null;

    return {
      name: queue.name,
      state: queue.currentState,
      limit: queue.limit,
      running: queue.runningCount
    };
  }

  getAllQueueStatus(): Array<{
    name: string;
    state: string;
    limit: number;
    running: number;
  }> {
    return Array.from(this.queues.values()).map(queue => ({
      name: queue.name,
      state: queue.currentState,
      limit: queue.limit,
      running: queue.runningCount
    }));
  }

  on(event: TelemetryEvent | '*', handler: TelemetryHandler): () => void {
    return telemetry.on(event, handler);
  }

  private async stageJobs(): Promise<void> {
    try {
      const staged = await this.config.database.stageJobs();
      if (staged > 0) {
        this.queues.forEach(queue => queue.dispatch());
      }
    } catch (error) {
      console.error('[izi-queue] Error staging jobs:', error);
    }
  }

  async drain(queueName?: string): Promise<void> {
    const queuesToDrain = queueName
      ? [this.queues.get(queueName)].filter(Boolean)
      : Array.from(this.queues.values());

    await this.stageJobs();

    let hasJobs = true;
    while (hasJobs) {
      hasJobs = false;
      for (const queue of queuesToDrain) {
        if (!queue) continue;
        const jobs = await this.config.database.fetchJobs(queue.name, queue.limit);
        if (jobs.length > 0) {
          hasJobs = true;
          for (const job of jobs) {
            await this.config.database.updateJob(job.id, { state: 'available' });
          }
          queue.dispatch();
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
  }
}

export function createIziQueue(config: IziQueueFullConfig): IziQueue {
  return new IziQueue(config);
}
