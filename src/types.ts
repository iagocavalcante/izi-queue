/**
 * Structured logger izi-queue reports through instead of `console.*`. Message
 * plus an optional metadata object -- shaped to pass straight through to
 * pino, winston, or any logger with this same four-method surface. A default
 * console-backed implementation (`consoleLogger`, in `src/core/logger.ts`) is
 * used wherever a `logger` is not supplied, preserving izi-queue's prior
 * behavior of writing everything to the console.
 */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export type JobState =
  | 'scheduled'
  | 'available'
  | 'executing'
  | 'retryable'
  | 'completed'
  | 'discarded'
  | 'cancelled';

export interface JobError {
  at: Date;
  attempt: number;
  error: string;
  stacktrace?: string;
}

export interface Job<T = Record<string, unknown>> {
  id: number;
  state: JobState;
  queue: string;
  worker: string;
  args: T;
  meta: Record<string, unknown>;
  tags: string[];
  errors: JobError[];
  attempt: number;
  maxAttempts: number;
  priority: number;
  insertedAt: Date;
  scheduledAt: Date;
  attemptedAt: Date | null;
  /** Name of the node that last fetched this job. Null for jobs never attempted. */
  attemptedBy: string | null;
  /** Digest identifying this job for uniqueness. Null for non-unique jobs. */
  uniqueKey: string | null;
  completedAt: Date | null;
  discardedAt: Date | null;
  cancelledAt: Date | null;
}

export interface UniqueOptions {
  fields?: Array<'worker' | 'queue' | 'args'>;
  keys?: string[];
  period?: number | 'infinity';
  states?: JobState[];
}

export interface JobCriteria {
  ids?: number[];
  queue?: string;
  worker?: string;
  state?: JobState[];
  /**
   * Required to act on every job. Without it an empty criteria object is
   * rejected, so a handler forwarding optional filters cannot wipe the queue.
   */
  all?: boolean;
}

/**
 * A caller-managed transaction handle, passed straight through to the adapter.
 * Adapter-specific by nature, so the shared type stays open and each adapter
 * validates what it is given:
 *
 * - PostgreSQL: a `PoolClient` with `BEGIN` already issued
 * - MySQL: a `PoolConnection` with `beginTransaction()` already called
 * - SQLite: the `Database`, with `BEGIN` issued manually
 */
export type TransactionHandle = unknown;

export interface JobInsertOptions<T = Record<string, unknown>> {
  args: T;
  queue?: string;
  maxAttempts?: number;
  priority?: number;
  scheduledAt?: Date;
  meta?: Record<string, unknown>;
  tags?: string[];
  unique?: UniqueOptions;
  /**
   * Insert as part of the caller's transaction, so the job is committed or
   * discarded atomically with their business write.
   */
  tx?: TransactionHandle;
}

export type WorkerResult =
  | { status: 'ok'; value?: unknown }
  | { status: 'error'; error: Error | string }
  | { status: 'cancel'; reason: string }
  | { status: 'snooze'; seconds: number };

/**
 * How a single job resolved when executed inline by `IziQueue.drain()`.
 * `failure` is an error with retry budget left (the job becomes `retryable`);
 * `discarded` covers both an error with no attempts left and an unregistered
 * worker -- both land the job in the `discarded` state.
 */
export type DrainOutcome = 'success' | 'failure' | 'snoozed' | 'discarded' | 'cancelled';

/** Tally of drain outcomes, returned by `IziQueue.drain()`. */
export type DrainResult = Record<DrainOutcome, number>;

export interface ResourceLimits {
  maxOldGenerationSizeMb?: number;
  maxYoungGenerationSizeMb?: number;
  codeRangeSizeMb?: number;
  stackSizeMb?: number;
}

export interface IsolatedWorkerOptions {
  isolated: true;
  workerPath: string;
  resourceLimits?: ResourceLimits;
}

export interface WorkerDefinition<T = Record<string, unknown>> {
  name: string;
  perform: (job: Job<T>) => Promise<WorkerResult | void>;
  queue?: string;
  maxAttempts?: number;
  priority?: number;
  backoff?: (job: Job<T>) => number;
  timeout?: number;
  isolation?: IsolatedWorkerOptions;
}

export interface QueueConfig {
  name: string;
  limit: number;
  paused?: boolean;
  pollInterval?: number;
}

export interface SerializableJob<T = Record<string, unknown>> {
  id: number;
  state: JobState;
  queue: string;
  worker: string;
  args: T;
  meta: Record<string, unknown>;
  tags: string[];
  errors: Array<{
    at: string;
    attempt: number;
    error: string;
    stacktrace?: string;
  }>;
  attempt: number;
  maxAttempts: number;
  priority: number;
  insertedAt: string;
  scheduledAt: string;
  attemptedAt: string | null;
  attemptedBy: string | null;
  uniqueKey: string | null;
  completedAt: string | null;
  discardedAt: string | null;
  cancelledAt: string | null;
}

export type WorkerThreadMessageType =
  | 'execute'
  | 'result'
  | 'error'
  | 'terminate'
  | 'ready';

export interface WorkerThreadMessage {
  type: WorkerThreadMessageType;
  jobId?: number;
  job?: SerializableJob;
  workerPath?: string;
  result?: WorkerResult;
  error?: string;
  stack?: string;
}

export interface DatabaseAdapter {
  migrate(): Promise<void>;
  insertJob(job: Omit<Job, 'id' | 'insertedAt'>, tx?: TransactionHandle): Promise<Job>;
  /**
   * Claims up to `limit` available jobs for `queue`, marking them executing.
   * `node` is recorded on each claimed job so orphan rescue can tell a job
   * abandoned by a dead node from one still running on a live node.
   */
  fetchJobs(queue: string, limit: number, node?: string): Promise<Job[]>;
  /**
   * Applies `updates` to a job. When `expectedStates` is given the database
   * arbitrates the transition: the write only lands if the job is still in one
   * of those states, and `null` is returned otherwise. That check has to happen
   * in the database, because the race is between nodes.
   */
  updateJob(id: number, updates: Partial<Job>, expectedStates?: JobState[]): Promise<Job | null>;
  getJob(id: number): Promise<Job | null>;
  /**
   * Deletes at most `limit` prunable (completed/discarded/cancelled, past
   * `maxAge`) rows and returns how many were deleted. Callers wanting the
   * whole backlog cleared loop on the result rather than relying on a single
   * unbounded statement, which would lock the table for as long as the
   * backlog takes to scan. `limit` defaults to a safe batch size when omitted;
   * a custom adapter that ignores it simply does not batch.
   */
  pruneJobs(maxAge: number, limit?: number): Promise<number>;
  /**
   * Promotes at most `limit` due scheduled/retryable jobs to available and
   * returns how many were promoted. Same batching contract as `pruneJobs`.
   */
  stageJobs(limit?: number): Promise<number>;
  cancelJobs(criteria: JobCriteria): Promise<number>;
  /** Returns discarded or cancelled jobs to the queue. */
  retryJobs?(criteria: JobCriteria): Promise<number>;
  /**
   * Returns jobs abandoned by dead nodes to the queue (or discards them when
   * their attempts are exhausted). `nodeTtl` is how many seconds a node may go
   * without a heartbeat before it is presumed dead.
   */
  rescueStuckJobs(rescueAfter: number, nodeTtl?: number): Promise<number>;
  /** Registers/refreshes this node's liveness record. */
  heartbeat?(node: string): Promise<void>;
  /** Removes a node's liveness record on graceful shutdown. */
  removeNode?(node: string): Promise<void>;
  /**
   * @deprecated Superseded by `insertUnique`, which is atomic. Retained so
   * third-party adapters keep working; the check-then-insert it supports races
   * between concurrent callers.
   */
  checkUnique?(options: UniqueOptions, job: Omit<Job, 'id' | 'insertedAt'>): Promise<Job | null>;
  /**
   * Inserts a job unless an equivalent one already exists, atomically. Callers
   * racing on the same unique job must all observe the same outcome: exactly
   * one insert, and every caller receives the surviving job.
   */
  insertUnique?(
    job: Omit<Job, 'id' | 'insertedAt'>,
    options: UniqueOptions,
    tx?: TransactionHandle
  ): Promise<{ job: Job; conflict: boolean }>;
  close(): Promise<void>;
  listen?(callback: (event: { queue: string }) => void): Promise<void>;
  /**
   * Wakes queues for `queue`. When a transaction is supplied the notification
   * must not be observable before it commits.
   */
  notify?(queue: string, tx?: TransactionHandle): Promise<void>;
}

export interface IsolationConfig {
  minThreads?: number;
  maxThreads?: number;
  idleTimeoutMs?: number;
}

export interface IziQueueConfig {
  database: DatabaseAdapter;
  queues: QueueConfig[] | Record<string, number>;
  node?: string;
  stageInterval?: number;
  /**
   * Maximum rows staged per statement, per stage cycle. A large backlog is
   * worked in this many rows at a time rather than one unbounded UPDATE,
   * looping (yielding to the event loop between batches) until it is caught
   * up. Defaults to `DEFAULT_BATCH_SIZE` (5000).
   */
  stageBatchSize?: number;
  shutdownGracePeriod?: number;
  /**
   * How often this node refreshes its liveness record, in ms. A node is presumed
   * dead after four missed heartbeats (minimum 60s), which is when its in-flight
   * jobs become eligible for rescue.
   */
  heartbeatInterval?: number;
  pollInterval?: number;
  isolation?: IsolationConfig;
  /**
   * Where izi-queue reports its own operational logging (staging/fetch
   * errors, node heartbeat failures, ...). Defaults to `consoleLogger`, which
   * preserves the pre-#40 behavior of writing to `console.*`.
   *
   * This is independent of any `logger` passed to the database adapter's
   * factory function (`createPostgresAdapter`, etc.) -- IziQueue does not
   * propagate its logger down to the adapter. Adapters log on their own
   * (connection errors, reconnect attempts, migrations) and can do so before
   * an `IziQueue` even exists, e.g. via `adapter.migrate()` called directly.
   * Pass the same `Logger` instance to both if you want adapter and
   * queue-level logging routed through the same sink.
   */
  logger?: Logger;
}

export type TelemetryEvent =
  | 'job:start'
  | 'job:complete'
  | 'job:error'
  | 'job:cancel'
  | 'job:snooze'
  | 'job:rescue'
  | 'job:retry'
  | 'job:unknown_worker'
  | 'job:transition_refused'
  | 'jobs:pruned'
  | 'job:unique_conflict'
  | 'job:isolated:start'
  | 'job:isolated:timeout'
  | 'queue:start'
  | 'queue:stop'
  | 'queue:pause'
  | 'queue:resume'
  | 'queue:stage_error'
  | 'queue:fetch_error'
  | 'thread:spawn'
  | 'thread:exit'
  | 'plugin:start'
  | 'plugin:stop'
  | 'plugin:error';

export interface TelemetryPayload {
  event: TelemetryEvent;
  job?: Job;
  queue?: string;
  duration?: number;
  error?: Error;
  result?: unknown;
  timestamp: Date;
  threadId?: number;
  isolated?: boolean;
}

export type TelemetryHandler = (payload: TelemetryPayload) => void;
