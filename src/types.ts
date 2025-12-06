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

export interface WorkerDefinition<T = Record<string, unknown>> {
  name: string;
  perform: (job: Job<T>) => Promise<WorkerResult | void>;
  queue?: string;
  maxAttempts?: number;
  priority?: number;
  backoff?: (job: Job<T>) => number;
  timeout?: number;
}

export interface QueueConfig {
  name: string;
  limit: number;
  paused?: boolean;
  pollInterval?: number;
}

export interface DatabaseAdapter {
  migrate(): Promise<void>;
  insertJob(job: Omit<Job, 'id' | 'insertedAt'>): Promise<Job>;
  fetchJobs(queue: string, limit: number): Promise<Job[]>;
  updateJob(id: number, updates: Partial<Job>): Promise<Job | null>;
  getJob(id: number): Promise<Job | null>;
  pruneJobs(maxAge: number): Promise<number>;
  stageJobs(): Promise<number>;
  cancelJobs(criteria: { queue?: string; worker?: string; state?: JobState[] }): Promise<number>;
  rescueStuckJobs(rescueAfter: number): Promise<number>;
  checkUnique?(options: UniqueOptions, job: Omit<Job, 'id' | 'insertedAt'>): Promise<Job | null>;
  close(): Promise<void>;
  listen?(callback: (event: { queue: string }) => void): Promise<void>;
  notify?(queue: string): Promise<void>;
}

export interface IziQueueConfig {
  database: DatabaseAdapter;
  queues: QueueConfig[] | Record<string, number>;
  node?: string;
  stageInterval?: number;
  shutdownGracePeriod?: number;
  pollInterval?: number;
}

export type TelemetryEvent =
  | 'job:start'
  | 'job:complete'
  | 'job:error'
  | 'job:cancel'
  | 'job:snooze'
  | 'job:rescue'
  | 'job:unique_conflict'
  | 'queue:start'
  | 'queue:stop'
  | 'queue:pause'
  | 'queue:resume'
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
}

export type TelemetryHandler = (payload: TelemetryPayload) => void;
