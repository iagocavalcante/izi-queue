import type {
  IsolatedWorkerOptions,
  IsolationConfig,
  Job,
  SerializableJob,
  WorkerResult
} from '../../types.js';
import { ThreadPool, type ThreadPoolConfig } from './thread-pool.js';

let threadPool: ThreadPool | null = null;

function serializeJob(job: Job): SerializableJob {
  return {
    ...job,
    insertedAt: job.insertedAt.toISOString(),
    scheduledAt: job.scheduledAt.toISOString(),
    attemptedAt: job.attemptedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    discardedAt: job.discardedAt?.toISOString() ?? null,
    cancelledAt: job.cancelledAt?.toISOString() ?? null,
    errors: job.errors.map(e => ({
      ...e,
      at: e.at.toISOString()
    }))
  };
}

export function initializeIsolation(config?: IsolationConfig): void {
  if (threadPool) {
    return;
  }

  const poolConfig: ThreadPoolConfig = {
    minThreads: config?.minThreads ?? 0,
    maxThreads: config?.maxThreads ?? 4,
    idleTimeoutMs: config?.idleTimeoutMs ?? 30000
  };

  threadPool = new ThreadPool(poolConfig);
}

export function getThreadPool(): ThreadPool | null {
  return threadPool;
}

export async function executeIsolated(
  job: Job,
  options: IsolatedWorkerOptions,
  timeout: number
): Promise<WorkerResult> {
  if (!threadPool) {
    initializeIsolation();
  }

  const serializedJob = serializeJob(job);
  return threadPool!.execute(serializedJob, options, timeout);
}

export async function terminateIsolatedJob(jobId: number): Promise<void> {
  if (threadPool) {
    await threadPool.terminate(jobId);
  }
}

export async function shutdownIsolation(): Promise<void> {
  if (threadPool) {
    await threadPool.shutdown();
    threadPool = null;
  }
}

export function getIsolationStats(): {
  totalWorkers: number;
  busyWorkers: number;
  idleWorkers: number;
  pendingJobs: number;
} | null {
  if (!threadPool) {
    return null;
  }
  return threadPool.getStats();
}
