import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type {
  IsolatedWorkerOptions,
  SerializableJob,
  WorkerResult,
  WorkerThreadMessage
} from '../../types.js';
import { telemetry } from '../telemetry.js';

function getWorkerThreadPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');

  // CommonJS environment (Jest and some Node.js setups)
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - __dirname may not be available in ESM
  if (typeof __dirname !== 'undefined') {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - __dirname available in CommonJS
    let workerPath = join(__dirname, 'worker-thread.js');

    // If running from source (e.g., Jest), try to find the compiled version in dist
    if (!fs.existsSync(workerPath)) {
      // Try dist path - src/core/isolation -> dist/core/isolation
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore - __dirname available in CommonJS
      const distPath = __dirname.replace('/src/', '/dist/').replace('\\src\\', '\\dist\\');
      const distWorkerPath = join(distPath, 'worker-thread.js');
      if (fs.existsSync(distWorkerPath)) {
        workerPath = distWorkerPath;
      }
    }

    return workerPath;
  }

  // ESM environment - use dynamic evaluation to avoid parser errors in CJS
  // eslint-disable-next-line no-eval
  const getMetaUrl = new Function('return import.meta.url');
  try {
    const currentUrl = getMetaUrl();
    const currentFilename = fileURLToPath(currentUrl);
    const currentDirname = dirname(currentFilename);
    return join(currentDirname, 'worker-thread.js');
  } catch {
    throw new Error('Cannot determine worker thread path - neither __dirname nor import.meta.url available');
  }
}

let WORKER_THREAD_PATH: string;

interface PooledWorker {
  worker: Worker;
  busy: boolean;
  lastUsed: number;
  currentJobId: number | null;
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

  private createWorker(): PooledWorker {
    if (!WORKER_THREAD_PATH) {
      WORKER_THREAD_PATH = getWorkerThreadPath();
    }
    const worker = new Worker(WORKER_THREAD_PATH);

    telemetry.emit('thread:spawn', {
      threadId: worker.threadId
    });

    const pooled: PooledWorker = {
      worker,
      busy: false,
      lastUsed: Date.now(),
      currentJobId: null
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

    const index = this.workers.indexOf(pooled);
    if (index !== -1) {
      this.workers.splice(index, 1);
    }

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

    const index = this.workers.indexOf(pooled);
    if (index !== -1) {
      this.workers.splice(index, 1);
    }

    telemetry.emit('thread:exit', {
      threadId: pooled.worker.threadId
    });
  }

  private getAvailableWorker(): PooledWorker | null {
    for (const pooled of this.workers) {
      if (!pooled.busy) {
        return pooled;
      }
    }

    if (this.workers.length < this.config.maxThreads) {
      return this.createWorker();
    }

    return null;
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

    const pooled = this.getAvailableWorker();
    if (!pooled) {
      return {
        status: 'error',
        error: new Error('No available worker threads')
      };
    }

    pooled.busy = true;
    pooled.currentJobId = job.id;

    telemetry.emit('job:isolated:start', {
      job: job as unknown as import('../../types.js').Job,
      threadId: pooled.worker.threadId,
      isolated: true
    });

    return new Promise<WorkerResult>((resolve) => {
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
          const index = this.workers.indexOf(pooled);
          if (index !== -1) {
            this.workers.splice(index, 1);
          }

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
