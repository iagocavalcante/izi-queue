export { ThreadPool, type ThreadPoolConfig } from './thread-pool.js';
export {
  initializeIsolation,
  getThreadPool,
  executeIsolated,
  terminateIsolatedJob,
  shutdownIsolation,
  getIsolationStats
} from './executor.js';
