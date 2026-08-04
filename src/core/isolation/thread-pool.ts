import { Worker } from 'worker_threads';
import { existsSync } from 'fs';
import { join } from 'path';
import { isolationDir } from './worker-path.js';
import type {
  IsolatedWorkerOptions,
  ResourceLimits,
  SerializableJob,
  WorkerResult,
  WorkerThreadMessage
} from '../../types.js';
import { telemetry } from '../telemetry.js';

/** Locates the compiled worker thread entry point next to this module. */
function getWorkerThreadPath(): string {
  const path = join(isolationDir(), 'worker-thread.js');

  if (!existsSync(path)) {
    throw new Error(
      `izi-queue: could not find the isolated worker entry point at ${path}. ` +
        'If you are running from source, build the package first.'
    );
  }

  return path;
}

let WORKER_THREAD_PATH: string;

interface PooledWorker {
  worker: Worker;
  busy: boolean;
  lastUsed: number;
  currentJobId: number | null;
  /**
   * Resource limits are fixed when a thread is created, so a worker can only
   * serve jobs asking for the same ones. This key partitions the pool.
   */
  limitsKey: string;
  limits?: ResourceLimits;
}

interface Waiter {
  limitsKey: string;
  limits?: ResourceLimits;
  resolve: (worker: PooledWorker | null) => void;
}

/** Stable identity for a set of resource limits, used to match threads to jobs. */
function limitsKeyFor(limits?: ResourceLimits): string {
  if (!limits) return '';
  return JSON.stringify({
    maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb ?? null,
    maxYoungGenerationSizeMb: limits.maxYoungGenerationSizeMb ?? null,
    codeRangeSizeMb: limits.codeRangeSizeMb ?? null,
    stackSizeMb: limits.stackSizeMb ?? null
  });
}

export interface ThreadPoolConfig {
  minThreads?: number;
  maxThreads?: number;
  idleTimeoutMs?: number;
}

const DEFAULT_CONFIG: Required<ThreadPoolConfig> = {
  minThreads: 0,
  maxThreads: 4,
  idleTimeoutMs: 30000
};

export class ThreadPool {
  private config: Required<ThreadPoolConfig>;
  private workers: PooledWorker[] = [];
  private pendingJobs: Map<number, {
    resolve: (result: WorkerResult) => void;
    reject: (error: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }> = new Map();
  private cleanupInterval?: ReturnType<typeof setInterval>;
  private waiters: Waiter[] = [];
  private shuttingDown = false;

  constructor(config: ThreadPoolConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startCleanupInterval();
  }

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupIdleWorkers();
    }, this.config.idleTimeoutMs / 2);
  }

  private cleanupIdleWorkers(): void {
    if (this.shuttingDown) return;

    const now = Date.now();
    const minWorkers = this.config.minThreads;

    this.workers = this.workers.filter((pooled, index) => {
      if (pooled.busy) return true;
      if (index < minWorkers) return true;

      const idleTime = now - pooled.lastUsed;
      if (idleTime > this.config.idleTimeoutMs) {
        this.terminateWorker(pooled);
        return false;
      }

      return true;
    });
  }

  private createWorker(limits?: ResourceLimits): PooledWorker {
    if (!WORKER_THREAD_PATH) {
      WORKER_THREAD_PATH = getWorkerThreadPath();
    }
    // Limits have to be supplied at construction: a thread's heap cannot be
    // capped after it starts. That is why the pool is partitioned by them.
    const worker = new Worker(WORKER_THREAD_PATH, limits ? { resourceLimits: limits } : undefined);

    telemetry.emit('thread:spawn', {
      threadId: worker.threadId
    });

    const pooled: PooledWorker = {
      worker,
      busy: false,
      lastUsed: Date.now(),
      currentJobId: null,
      limitsKey: limitsKeyFor(limits),
      limits
    };

    worker.on('message', (message: WorkerThreadMessage) => {
      this.handleWorkerMessage(pooled, message);
    });

    worker.on('error', (error: Error) => {
      this.handleWorkerError(pooled, error);
    });

    worker.on('exit', (code: number) => {
      this.handleWorkerExit(pooled, code);
    });

    this.workers.push(pooled);
    return pooled;
  }

  private handleWorkerMessage(pooled: PooledWorker, message: WorkerThreadMessage): void {
    if (message.type === 'result' && message.jobId !== undefined) {
      const pending = this.pendingJobs.get(message.jobId);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pendingJobs.delete(message.jobId);
        pooled.busy = false;
        pooled.lastUsed = Date.now();
        pooled.currentJobId = null;

        if (message.result) {
          pending.resolve(message.result);
        } else {
          pending.resolve({ status: 'ok' });
        }

        this.handOffToWaiter();
      }
    } else if (message.type === 'error' && message.jobId !== undefined) {
      const pending = this.pendingJobs.get(message.jobId);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pendingJobs.delete(message.jobId);
        pooled.busy = false;
        pooled.lastUsed = Date.now();
        pooled.currentJobId = null;

        pending.resolve({
          status: 'error',
          error: new Error(message.error || 'Unknown worker error')
        });

        this.handOffToWaiter();
      }
    }
  }

  private handleWorkerError(pooled: PooledWorker, error: Error): void {
    if (pooled.currentJobId !== null) {
      const pending = this.pendingJobs.get(pooled.currentJobId);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pendingJobs.delete(pooled.currentJobId);
        pending.resolve({
          status: 'error',
          error
        });
      }
    }

    this.removeWorker(pooled);
    // Its slot is free even though it died, so someone queued can start.
    this.handOffToWaiter();

    telemetry.emit('thread:exit', {
      threadId: pooled.worker.threadId,
      error
    });
  }

  private handleWorkerExit(pooled: PooledWorker, code: number): void {
    if (pooled.currentJobId !== null) {
      const pending = this.pendingJobs.get(pooled.currentJobId);
      if (pending) {
        clearTimeout(pending.timeoutId);
        this.pendingJobs.delete(pooled.currentJobId);
        pending.resolve({
          status: 'error',
          error: new Error(`Worker thread exited unexpectedly with code ${code}`)
        });
      }
    }

    this.removeWorker(pooled);
    // Its slot is free even though it died, so someone queued can start.
    this.handOffToWaiter();

    telemetry.emit('thread:exit', {
      threadId: pooled.worker.threadId
    });
  }

  /**
   * Finds or creates a thread able to run a job with these limits, waiting if
   * the pool is saturated.
   *
   * Waiting rather than failing is the point: a job that arrives while every
   * thread is busy has not failed, it has not started. Returning an error would
   * consume one of its retry attempts for something it had no part in, which is
   * easy to hit whenever a queue's concurrency exceeds `maxThreads`.
   */
  private acquireWorker(limits: ResourceLimits | undefined, signal: { aborted: boolean }): Promise<PooledWorker | null> {
    const limitsKey = limitsKeyFor(limits);

    const immediate = this.takeIdleWorker(limitsKey, limits);
    if (immediate) return Promise.resolve(immediate);

    return new Promise<PooledWorker | null>(resolve => {
      const waiter: Waiter = {
        limitsKey,
        limits,
        resolve: worker => {
          if (signal.aborted) {
            // The job gave up while queued; hand the thread to the next in line.
            if (worker) {
              worker.busy = false;
              this.handOffToWaiter();
            }
            resolve(null);
            return;
          }
          resolve(worker);
        }
      };

      this.waiters.push(waiter);
    });
  }

  /** Returns a thread ready for `limitsKey`, or null if none can be had now. */
  private takeIdleWorker(limitsKey: string, limits?: ResourceLimits): PooledWorker | null {
    const matching = this.workers.find(w => !w.busy && w.limitsKey === limitsKey);
    if (matching) {
      matching.busy = true;
      return matching;
    }

    if (this.workers.length < this.config.maxThreads) {
      const created = this.createWorker(limits);
      created.busy = true;
      return created;
    }

    // At capacity with only mismatched idle threads. Limits are fixed at
    // construction, so the only way to serve this job is to replace one.
    const mismatched = this.workers.find(w => !w.busy);
    if (mismatched) {
      this.removeWorker(mismatched);
      this.terminateWorker(mismatched);
      const created = this.createWorker(limits);
      created.busy = true;
      return created;
    }

    return null;
  }

  /** Called whenever a thread frees up or the pool gains capacity. */
  private handOffToWaiter(): void {
    if (this.shuttingDown) return;

    for (let i = 0; i < this.waiters.length; i++) {
      const waiter = this.waiters[i];
      const worker = this.takeIdleWorker(waiter.limitsKey, waiter.limits);
      if (!worker) return;

      this.waiters.splice(i, 1);
      waiter.resolve(worker);
      return;
    }
  }

  private removeWorker(pooled: PooledWorker): void {
    const index = this.workers.indexOf(pooled);
    if (index !== -1) {
      this.workers.splice(index, 1);
    }
  }

  private terminateWorker(pooled: PooledWorker): void {
    pooled.worker.terminate();
    telemetry.emit('thread:exit', {
      threadId: pooled.worker.threadId
    });
  }

  async execute(
    job: SerializableJob,
    options: IsolatedWorkerOptions,
    timeout: number
  ): Promise<WorkerResult> {
    if (this.shuttingDown) {
      return {
        status: 'error',
        error: new Error('Thread pool is shutting down')
      };
    }

    // The deadline covers queueing as well as execution, so a saturated pool
    // cannot leave a job outstanding indefinitely.
    const signal = { aborted: false };
    let settle: ((result: WorkerResult) => void) | undefined;
    const settled = new Promise<WorkerResult>(resolve => {
      settle = resolve;
    });

    const waitTimer = setTimeout(() => {
      signal.aborted = true;
      this.waiters = this.waiters.filter(w => w.resolve !== waiterResolve);
      settle?.({
        status: 'error',
        error: new Error(`Timed out after ${timeout}ms waiting for a worker thread`)
      });
    }, timeout);

    const waiterResolve = (): void => {};

    const pooled = await Promise.race([
      this.acquireWorker(options.resourceLimits, signal),
      settled.then(() => null)
    ]);

    clearTimeout(waitTimer);

    if (signal.aborted || !pooled) {
      return settled;
    }

    pooled.currentJobId = job.id;

    telemetry.emit('job:isolated:start', {
      job: job as unknown as import('../../types.js').Job,
      threadId: pooled.worker.threadId,
      isolated: true
    });

    return new Promise<WorkerResult>(resolve => {
      const timeoutId = setTimeout(() => {
        const pending = this.pendingJobs.get(job.id);
        if (pending) {
          this.pendingJobs.delete(job.id);

          telemetry.emit('job:isolated:timeout', {
            job: job as unknown as import('../../types.js').Job,
            threadId: pooled.worker.threadId,
            isolated: true
          });

          this.terminateWorker(pooled);
          this.removeWorker(pooled);
          this.handOffToWaiter();

          resolve({
            status: 'error',
            error: new Error(`Isolated job timed out after ${timeout}ms`)
          });
        }
      }, timeout);

      this.pendingJobs.set(job.id, { resolve, reject: () => {}, timeoutId });

      const message: WorkerThreadMessage = {
        type: 'execute',
        jobId: job.id,
        job,
        workerPath: options.workerPath
      };

      pooled.worker.postMessage(message);
    });
  }

  async terminate(jobId: number): Promise<void> {
    for (const pooled of this.workers) {
      if (pooled.currentJobId === jobId) {
        const pending = this.pendingJobs.get(jobId);
        if (pending) {
          clearTimeout(pending.timeoutId);
          this.pendingJobs.delete(jobId);
          pending.resolve({
            status: 'error',
            error: new Error('Job terminated')
          });
        }

        this.terminateWorker(pooled);
        const index = this.workers.indexOf(pooled);
        if (index !== -1) {
          this.workers.splice(index, 1);
        }
        return;
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    // Nothing will free up now, so release anyone queued rather than leaving
    // their promises pending forever.
    const waiting = this.waiters;
    this.waiters = [];
    waiting.forEach(w => w.resolve(null));

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }

    for (const pending of this.pendingJobs.values()) {
      clearTimeout(pending.timeoutId);
      pending.resolve({
        status: 'error',
        error: new Error('Thread pool shutdown')
      });
    }
    this.pendingJobs.clear();

    const terminatePromises = this.workers.map(pooled => {
      return new Promise<void>((resolve) => {
        pooled.worker.once('exit', () => resolve());
        pooled.worker.terminate();
      });
    });

    await Promise.all(terminatePromises);
    this.workers = [];
  }

  getStats(): {
    totalWorkers: number;
    busyWorkers: number;
    idleWorkers: number;
    pendingJobs: number;
  } {
    const busyWorkers = this.workers.filter(w => w.busy).length;
    return {
      totalWorkers: this.workers.length,
      busyWorkers,
      idleWorkers: this.workers.length - busyWorkers,
      pendingJobs: this.pendingJobs.size
    };
  }
}
