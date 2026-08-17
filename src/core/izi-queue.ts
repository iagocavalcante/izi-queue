import type {
  DatabaseAdapter,
  DrainResult,
  IziQueueConfig,
  IsolationConfig,
  Job,
  JobCriteria,
  JobInsertOptions,
  TransactionHandle,
  QueueConfig,
  TelemetryEvent,
  TelemetryHandler,
  WorkerDefinition
} from '../types.js';
import type { Plugin, PluginContext } from '../plugins/plugin.js';
import { createJob } from './job.js';
import { computeUniqueKey } from './unique.js';
import { Queue } from './queue.js';
import { telemetry } from './telemetry.js';
import { consoleLogger } from './logger.js';
import {
  registerWorker,
  clearWorkers,
  getWorker,
  initializeIsolatedWorkers,
  shutdownIsolatedWorkers,
  getIsolationStats
} from './worker.js';
import { randomUUID } from 'crypto';
import { DEFAULT_BATCH_SIZE, DEFAULT_NODE_TTL, runInBatches } from '../database/adapter.js';

export interface IziQueueFullConfig extends IziQueueConfig {
  plugins?: Plugin[];
}

/**
 * Bulk operations must be scoped. An HTTP handler that forwards optional
 * filters would otherwise act on every job in the database when called with
 * none of them.
 */
function assertScoped(criteria: JobCriteria, operation: string): void {
  if (criteria.all) return;

  const scoped =
    (criteria.ids && criteria.ids.length > 0) ||
    criteria.queue ||
    criteria.worker ||
    (criteria.state && criteria.state.length > 0);

  if (!scoped) {
    throw new Error(
      `${operation} requires at least one criterion. Pass { all: true } to act on every job.`
    );
  }
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
  private heartbeatTimer?: ReturnType<typeof setInterval>;
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
      stageBatchSize: config.stageBatchSize ?? DEFAULT_BATCH_SIZE,
      shutdownGracePeriod: config.shutdownGracePeriod ?? 15000,
      heartbeatInterval: config.heartbeatInterval ?? 15000,
      pollInterval: config.pollInterval ?? 1000,
      isolation: config.isolation,
      logger: config.logger ?? consoleLogger
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

  /**
   * Seconds without a heartbeat after which this node is presumed dead. Derived
   * from the heartbeat interval so a slow heartbeat can never make a live node
   * look dead and get its running jobs rescued out from under it.
   */
  private get nodeTtl(): number {
    return Math.max(DEFAULT_NODE_TTL, Math.ceil((this.config.heartbeatInterval * 4) / 1000));
  }

  async start(): Promise<void> {
    if (this.started) return;

    // Register before any job can be claimed, otherwise this node's first jobs
    // are owned by a node that the rescuer has never heard of.
    await this.recordHeartbeat();
    this.heartbeatTimer = setInterval(
      () => this.recordHeartbeat(),
      this.config.heartbeatInterval
    );

    for (const queueConfig of this.config.queues) {
      const queue = new Queue(queueConfig, this.config.database, this.config.node, this.config.logger);
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
      queues: Array.from(this.queues.keys()),
      nodeTtl: this.nodeTtl
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

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    await Promise.all(
      Array.from(this.queues.values()).map(q =>
        q.stop(this.config.shutdownGracePeriod)
      )
    );

    // Deregister only after the grace period: anything still executing at this
    // point really has been abandoned and should become rescuable promptly.
    await this.removeNodeRecord();

    this.started = false;
  }

  private async recordHeartbeat(): Promise<void> {
    try {
      await this.config.database.heartbeat?.(this.config.node);
    } catch (error) {
      this.config.logger.error('Error recording node heartbeat', { error, node: this.config.node });
    }
  }

  private async removeNodeRecord(): Promise<void> {
    try {
      await this.config.database.removeNode?.(this.config.node);
    } catch (error) {
      this.config.logger.error('Error removing node record', { error, node: this.config.node });
    }
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

    if (options.unique) {
      const data = {
        ...jobData,
        uniqueKey: computeUniqueKey(jobData, options.unique)
      } as Omit<Job, 'id' | 'insertedAt'>;

      const result = this.config.database.insertUnique
        ? await this.config.database.insertUnique(data, options.unique, options.tx)
        : await this.insertUniqueUnsafely(data, options.unique, options.tx);

      if (result.conflict) {
        telemetry.emit('job:unique_conflict', {
          job: result.job,
          queue: result.job.queue
        });
      } else {
        await this.wake(result.job.queue, options.tx);
      }

      return { job: result.job as Job<T>, conflict: result.conflict };
    }

    const job = await this.config.database.insertJob(
      jobData as Omit<Job, 'id' | 'insertedAt'>,
      options.tx
    );

    await this.wake(job.queue, options.tx);

    return { job: job as Job<T>, conflict: false };
  }

  /**
   * Nudges a queue to poll now rather than at its next interval. Passing the
   * transaction through matters: the notification must not be observable
   * before the caller commits, or a worker looks for a row that is not there
   * yet -- and must never fire at all if they roll back.
   */
  private async wake(queue: string, tx?: TransactionHandle): Promise<void> {
    if (!this.started || !this.config.database.notify) return;
    await this.config.database.notify(queue, tx);
  }

  /**
   * Fallback for adapters predating `insertUnique`. The check and the insert are
   * separate statements, so two callers racing on the same unique job can both
   * observe "no conflict" and both insert.
   */
  private async insertUniqueUnsafely(
    data: Omit<Job, 'id' | 'insertedAt'>,
    unique: NonNullable<JobInsertOptions['unique']>,
    tx?: TransactionHandle
  ): Promise<{ job: Job; conflict: boolean }> {
    if (this.config.database.checkUnique) {
      const existing = await this.config.database.checkUnique(unique, data);
      if (existing) return { job: existing, conflict: true };
    }

    return { job: await this.config.database.insertJob(data, tx), conflict: false };
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

  async cancelJobs(criteria: JobCriteria): Promise<number> {
    assertScoped(criteria, 'cancelJobs');
    const count = await this.config.database.cancelJobs(criteria);

    // Best-effort local interruption, only possible when the caller told us
    // which ids were targeted. `cancelJobs` reports how many rows it
    // changed, not which ones, so a queue/worker/state-scoped call has no
    // way to know which jobs to interrupt without an extra query -- out of
    // scope here. Every queue on this node is asked regardless of which one
    // (if any) actually has the job; each is a no-op unless it does.
    if (count > 0 && criteria.ids && criteria.ids.length > 0) {
      await Promise.all(
        criteria.ids.flatMap(id =>
          Array.from(this.queues.values()).map(queue => queue.cancelRunning(id))
        )
      );
    }

    return count;
  }

  /** Cancels one job. Returns false if it was already in a terminal state. */
  async cancelJob(id: number): Promise<boolean> {
    return (await this.cancelJobs({ ids: [id] })) > 0;
  }

  /**
   * Returns discarded or cancelled jobs to the queue. Jobs that had exhausted
   * their attempts are given headroom, otherwise they would be discarded again
   * on the very next fetch.
   */
  async retryJobs(criteria: JobCriteria): Promise<number> {
    assertScoped(criteria, 'retryJobs');

    if (!this.config.database.retryJobs) {
      throw new Error('The configured database adapter does not support retryJobs');
    }

    const count = await this.config.database.retryJobs(criteria);
    if (count > 0) {
      telemetry.emit('job:retry', { result: { count } });
      this.queues.forEach(queue => queue.dispatch());
    }
    return count;
  }

  /** Retries one job. Returns false if it was not in a retryable state. */
  async retryJob(id: number): Promise<boolean> {
    return (await this.retryJobs({ ids: [id] })) > 0;
  }

  /**
   * Deletes every prunable job older than `maxAgeSeconds`. Runs in bounded
   * batches of `batchSize` rows -- looping, and yielding to the event loop
   * between batches -- rather than one unbounded DELETE that would lock the
   * table for however long the whole backlog takes to scan.
   */
  async pruneJobs(maxAgeSeconds = 86400 * 7, batchSize = DEFAULT_BATCH_SIZE): Promise<number> {
    return runInBatches(
      limit => this.config.database.pruneJobs(maxAgeSeconds, limit),
      batchSize
    );
  }

  async rescueStuckJobs(rescueAfterSeconds = 300): Promise<number> {
    return this.config.database.rescueStuckJobs(rescueAfterSeconds, this.nodeTtl);
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
      const staged = await runInBatches(
        limit => this.config.database.stageJobs(limit),
        this.config.stageBatchSize
      );
      if (staged > 0) {
        this.queues.forEach(queue => queue.dispatch());
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.config.logger.error('Error staging jobs', { error: err });
      telemetry.emit('queue:stage_error', { error: err });
    }
  }

  /**
   * Synchronously runs every available job in the given queue (or all queues)
   * to completion, modeled on `Oban.drain_queue/2`. Jobs are fetched (which
   * marks them `executing` and consumes one attempt, same as the live poller)
   * and executed inline through the same worker-execution path the poller
   * uses, one at a time, until a fetch comes back empty.
   *
   * If the queue is currently running, its poller is paused for the duration
   * of the drain and resumed afterward -- otherwise the poller and the inline
   * executor would race to claim the same backlog. A poll already in flight
   * when drain() is called is allowed to finish claiming its jobs first; those
   * jobs are not re-fetched here; and they run to completion independently,
   * so they are not reflected in the returned tally.
   */
  async drain(queueName?: string): Promise<DrainResult> {
    const queuesToDrain: Queue[] = (
      queueName ? [this.queues.get(queueName)] : Array.from(this.queues.values())
    ).filter((queue): queue is Queue => queue !== undefined);

    // Pausing is synchronous and happens before any other work here, so
    // nothing can slip a new poll in between deciding to drain and doing so.
    const pausedQueues = queuesToDrain.filter(queue => queue.currentState === 'running');
    pausedQueues.forEach(queue => queue.pause());

    try {
      await Promise.all(queuesToDrain.map(queue => queue.awaitInFlightPoll()));

      await this.stageJobs();

      const tally: DrainResult = {
        success: 0,
        failure: 0,
        snoozed: 0,
        discarded: 0,
        cancelled: 0
      };

      for (const queue of queuesToDrain) {
        let jobs = await this.config.database.fetchJobs(queue.name, queue.limit, this.config.node);

        while (jobs.length > 0) {
          for (const job of jobs) {
            const outcome = await queue.executeInline(job);
            tally[outcome] += 1;
          }
          jobs = await this.config.database.fetchJobs(queue.name, queue.limit, this.config.node);
        }
      }

      return tally;
    } finally {
      pausedQueues.forEach(queue => queue.resume());
    }
  }
}

export function createIziQueue(config: IziQueueFullConfig): IziQueue {
  return new IziQueue(config);
}
