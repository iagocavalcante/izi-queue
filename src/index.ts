// Main entry point
export {
  IziQueue,
  createIziQueue,
  type IziQueueFullConfig,
  type InsertResult,
  type QueueStatus
} from './core/izi-queue.js';

// Core exports
export {
  Peer,
  Queue,
  createJob,
  calculateBackoff,
  formatError,
  isValidTransition,
  isTerminal,
  STATE_TRANSITIONS,
  TERMINAL_STATES,
  registerWorker,
  getWorker,
  hasWorker,
  getWorkerNames,
  clearWorkers,
  executeWorker,
  getBackoffDelay,
  defineWorker,
  WorkerResults,
  telemetry,
  consoleLogger,
  computeUniqueKey,
  advisoryLockKey,
  initializeIsolatedWorkers,
  shutdownIsolatedWorkers,
  terminateIsolatedJob,
  getIsolationStats,
  ThreadPool,
  type ThreadPoolConfig,
  executeIsolated,
  initializeIsolation,
  shutdownIsolation
} from './core/index.js';

// Database adapters
export {
  BaseAdapter,
  SQL,
  rowToJob,
  PostgresAdapter,
  createPostgresAdapter,
  SQLiteAdapter,
  createSQLiteAdapter,
  MySQLAdapter,
  createMySQLAdapter
} from './database/index.js';

export {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  JOB_STATES,
  DEFAULT_LEADER_NAME,
  DEFAULT_LEADERSHIP_INTERVAL,
  DEFAULT_LEADERSHIP_TTL
} from './database/adapter.js';

// Plugins
export {
  BasePlugin,
  LifelinePlugin,
  createLifelinePlugin,
  PrunerPlugin,
  createPrunerPlugin,
  type Plugin,
  type PluginConfig,
  type PluginContext,
  type LifelineConfig,
  type PrunerConfig
} from './plugins/index.js';

// Types
export type {
  Job,
  JobState,
  JobError,
  JobInsertOptions,
  JobCriteria,
  JobListCriteria,
  JobOrderBy,
  JobOrderByField,
  JobStateCounts,
  LeaderInfo,
  LeadershipConfig,
  UniqueOptions,
  WorkerResult,
  WorkerDefinition,
  BackoffStrategy,
  BackoffOptions,
  QueueConfig,
  DatabaseAdapter,
  DrainOutcome,
  DrainResult,
  IziQueueConfig,
  Logger,
  TelemetryEvent,
  TelemetryPayload,
  TelemetryHandler,
  IsolatedWorkerOptions,
  IsolationConfig,
  ResourceLimits,
  SerializableJob,
  WorkerThreadMessage,
  WorkerThreadMessageType
} from './types.js';
