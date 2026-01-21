// Main entry point
export { IziQueue, createIziQueue, type IziQueueFullConfig, type InsertResult } from './core/izi-queue.js';

// Core exports
export {
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
  createSQLiteAdapter
} from './database/index.js';

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
  UniqueOptions,
  WorkerResult,
  WorkerDefinition,
  QueueConfig,
  DatabaseAdapter,
  IziQueueConfig,
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
