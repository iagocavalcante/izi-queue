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

export interface JobInsertOptions<T = Record<string, unknown>> {
  args: T;
  queue?: string;
  maxAttempts?: number;
  priority?: number;
  scheduledAt?: Date;
  meta?: Record<string, unknown>;
  tags?: string[];
  unique?: UniqueOptions;
}

export type WorkerResult =
  | { status: 'ok'; value?: unknown }
  | { status: 'error'; error: Error | string }
  | { status: 'cancel'; reason: string }
  | { status: 'snooze'; seconds: number };

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
  insertJob(job: Omit<Job, 'id' | 'insertedAt'>): Promise<Job>;
  /**
   * Claims up to `limit` available jobs for `queue`, marking them executing.
   * `node` is recorded on each claimed job so orphan rescue can tell a job
   * abandoned by a dead node from one still running on a live node.
   */
  fetchJobs(queue: string, limit: number, node?: string): Promise<Job[]>;
  updateJob(id: number, updates: Partial<Job>): Promise<Job | null>;
  getJob(id: number): Promise<Job | null>;
  pruneJobs(maxAge: number): Promise<number>;
  stageJobs(): Promise<number>;
  cancelJobs(criteria: { queue?: string; worker?: string; state?: JobState[] }): Promise<number>;
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
    options: UniqueOptions
  ): Promise<{ job: Job; conflict: boolean }>;
  close(): Promise<void>;
  listen?(callback: (event: { queue: string }) => void): Promise<void>;
  notify?(queue: string): Promise<void>;
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
  shutdownGracePeriod?: number;
  /**
   * How often this node refreshes its liveness record, in ms. A node is presumed
   * dead after four missed heartbeats (minimum 60s), which is when its in-flight
   * jobs become eligible for rescue.
   */
  heartbeatInterval?: number;
  pollInterval?: number;
  isolation?: IsolationConfig;
}

export type TelemetryEvent =
  | 'job:start'
  | 'job:complete'
  | 'job:error'
  | 'job:cancel'
  | 'job:snooze'
  | 'job:rescue'
  | 'job:unique_conflict'
  | 'job:isolated:start'
  | 'job:isolated:timeout'
  | 'queue:start'
  | 'queue:stop'
  | 'queue:pause'
  | 'queue:resume'
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
