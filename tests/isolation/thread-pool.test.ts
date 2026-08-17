import { join } from 'path';
import { ThreadPool } from '../../src/core/isolation/thread-pool.js';
import { waitFor } from '../helpers/wait.js';
import type { SerializableJob, IsolatedWorkerOptions } from '../../src/types.js';

const TEST_WORKER_PATH = join(__dirname, '../fixtures/test-isolated-worker.js');

function createSerializableJob(overrides: Partial<SerializableJob> = {}): SerializableJob {
  const now = new Date().toISOString();
  return {
    id: Math.floor(Math.random() * 10000),
    state: 'executing',
    queue: 'default',
    worker: 'TestWorker',
    args: {},
    meta: {},
    tags: [],
    errors: [],
    attempt: 1,
    maxAttempts: 20,
    priority: 0,
    insertedAt: now,
    scheduledAt: now,
    attemptedAt: now,
    attemptedBy: null,
    uniqueKey: null,
    completedAt: null,
    discardedAt: null,
    cancelledAt: null,
    ...overrides
  };
}

function createIsolationOptions(overrides: Partial<IsolatedWorkerOptions> = {}): IsolatedWorkerOptions {
  return {
    isolated: true,
    workerPath: TEST_WORKER_PATH,
    ...overrides
  };
}

describe('ThreadPool', () => {
  let pool: ThreadPool;

  afterEach(async () => {
    if (pool) {
      await pool.shutdown();
    }
  });

  describe('execute', () => {
    it('should execute a job in a worker thread successfully', async () => {
      pool = new ThreadPool({ maxThreads: 2 });

      const job = createSerializableJob({
        args: { action: 'success' }
      });
      const options = createIsolationOptions();

      const result = await pool.execute(job, options, 5000);

      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value).toMatchObject({
          processed: true,
          jobId: job.id,
          isMainThread: false
        });
      }
    });

    it('should handle worker errors', async () => {
      pool = new ThreadPool({ maxThreads: 2 });

      const job = createSerializableJob({
        args: { action: 'crash', crashMessage: 'Test crash' }
      });
      const options = createIsolationOptions();

      const result = await pool.execute(job, options, 5000);

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect((result.error as Error).message).toContain('Test crash');
      }
    });

    it('should handle job timeout', async () => {
      pool = new ThreadPool({ maxThreads: 2 });

      const job = createSerializableJob({
        args: { action: 'delay', delay: 5000 }
      });
      const options = createIsolationOptions();

      const result = await pool.execute(job, options, 100); // 100ms timeout

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect((result.error as Error).message).toContain('timed out');
      }
    });

    it('should handle snooze result', async () => {
      pool = new ThreadPool({ maxThreads: 2 });

      const job = createSerializableJob({
        args: { action: 'snooze', seconds: 30 }
      });
      const options = createIsolationOptions();

      const result = await pool.execute(job, options, 5000);

      expect(result.status).toBe('snooze');
      if (result.status === 'snooze') {
        expect(result.seconds).toBe(30);
      }
    });

    it('should handle cancel result', async () => {
      pool = new ThreadPool({ maxThreads: 2 });

      const job = createSerializableJob({
        args: { action: 'cancel', reason: 'Test cancellation' }
      });
      const options = createIsolationOptions();

      const result = await pool.execute(job, options, 5000);

      expect(result.status).toBe('cancel');
      if (result.status === 'cancel') {
        expect(result.reason).toBe('Test cancellation');
      }
    });

    it('should execute multiple jobs concurrently', async () => {
      pool = new ThreadPool({ maxThreads: 4 });

      const jobs = Array.from({ length: 4 }, (_, i) =>
        createSerializableJob({
          id: i + 1,
          args: { action: 'delay', delay: 100 }
        })
      );
      const options = createIsolationOptions();

      const results = await Promise.all(
        jobs.map(job => pool.execute(job, options, 5000))
      );

      expect(results.every(r => r.status === 'ok')).toBe(true);

      // Parallelism is asserted from what the workers report, not from how long
      // the batch took. A wall-clock ceiling has to cover spawning four threads
      // as well as the work itself, so on a loaded machine it fails for reasons
      // that have nothing to do with whether the jobs ran in parallel.
      const runs = results.map(
        r => (r as { status: 'ok'; value: { threadId: number; startedAt: number; finishedAt: number } }).value
      );

      // Spread across the pool rather than queued onto one thread.
      expect(new Set(runs.map(r => r.threadId)).size).toBeGreaterThan(1);

      // And genuinely overlapping in time, not merely on different threads.
      const overlapping = runs.some((a, i) =>
        runs.some((b, j) => i !== j && a.startedAt < b.finishedAt && b.startedAt < a.finishedAt)
      );
      expect(overlapping).toBe(true);
    });
  });

  describe('terminate', () => {
    it('should terminate a running job', async () => {
      pool = new ThreadPool({ maxThreads: 2 });

      const job = createSerializableJob({
        args: { action: 'delay', delay: 10000 }
      });
      const options = createIsolationOptions();

      // Start a long-running job
      const executePromise = pool.execute(job, options, 30000);

      // Wait a bit for the job to start
      await new Promise(resolve => setTimeout(resolve, 50));

      // Terminate the job
      const found = await pool.terminate(job.id);
      expect(found).toBe(true);

      const result = await executePromise;

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect((result.error as Error).message).toContain('terminated');
      }
    });

    it('returns false and does nothing when the job is not running', async () => {
      pool = new ThreadPool({ maxThreads: 2 });

      const found = await pool.terminate(999999);

      expect(found).toBe(false);
    });

    it('resolves the pending execution with a caller-supplied result', async () => {
      pool = new ThreadPool({ maxThreads: 2 });

      const job = createSerializableJob({
        args: { action: 'delay', delay: 10000 }
      });
      const options = createIsolationOptions();

      const executePromise = pool.execute(job, options, 30000);
      await new Promise(resolve => setTimeout(resolve, 50));

      await pool.terminate(job.id, { status: 'cancel', reason: 'Job cancelled' });

      const result = await executePromise;
      expect(result).toEqual({ status: 'cancel', reason: 'Job cancelled' });
    });

    it('frees the slot immediately so a queued job is handed a thread without waiting on the exit event', async () => {
      pool = new ThreadPool({ maxThreads: 1 });
      const options = createIsolationOptions();

      const blocker = createSerializableJob({ id: 1, args: { action: 'delay', delay: 10000 } });
      const blocked = pool.execute(blocker, options, 30000);

      await waitFor(() => pool.getStats().busyWorkers === 1, { describe: 'the pool to be busy' });

      const queuedJob = createSerializableJob({ id: 2, args: { action: 'success' } });
      const queued = pool.execute(queuedJob, options, 10000);

      // Give the second execute() call a moment to actually enqueue as a
      // waiter before terminating the first job.
      await new Promise(resolve => setTimeout(resolve, 20));

      await pool.terminate(blocker.id);

      const queuedResult = await queued;
      expect(queuedResult.status).toBe('ok');

      await blocked;
    });

    it('keeps the pool healthy after termination: a replacement thread serves the next job', async () => {
      pool = new ThreadPool({ maxThreads: 1 });
      const options = createIsolationOptions();

      const job = createSerializableJob({ args: { action: 'delay', delay: 10000 } });
      const executePromise = pool.execute(job, options, 30000);
      await waitFor(() => pool.getStats().busyWorkers === 1, { describe: 'the pool to be busy' });

      await pool.terminate(job.id);
      await executePromise;

      const nextJob = createSerializableJob({ args: { action: 'success' } });
      const nextResult = await pool.execute(nextJob, options, 5000);

      expect(nextResult.status).toBe('ok');
      expect(pool.getStats().totalWorkers).toBe(1);
    });
  });

  describe('getStats', () => {
    it('should return pool statistics', async () => {
      pool = new ThreadPool({ maxThreads: 4 });

      // Initially no workers
      let stats = pool.getStats();
      expect(stats.totalWorkers).toBe(0);
      expect(stats.busyWorkers).toBe(0);
      expect(stats.idleWorkers).toBe(0);

      // Execute a job to spawn a worker
      const job = createSerializableJob({ args: { action: 'success' } });
      const options = createIsolationOptions();
      await pool.execute(job, options, 5000);

      stats = pool.getStats();
      expect(stats.totalWorkers).toBe(1);
      expect(stats.busyWorkers).toBe(0); // Job completed
      expect(stats.idleWorkers).toBe(1);
    });
  });

  describe('shutdown', () => {
    it('should shutdown cleanly', async () => {
      pool = new ThreadPool({ maxThreads: 2 });

      // Execute some jobs first
      const job = createSerializableJob({ args: { action: 'success' } });
      const options = createIsolationOptions();
      await pool.execute(job, options, 5000);

      // Shutdown should complete without errors
      await expect(pool.shutdown()).resolves.not.toThrow();

      // After shutdown, executing should fail
      const result = await pool.execute(job, options, 5000);
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect((result.error as Error).message).toContain('shutting down');
      }
    });
  });

  describe('thread pool limits', () => {
    it('should respect maxThreads limit', async () => {
      pool = new ThreadPool({ maxThreads: 2 });

      // Start exactly as many jobs as threads
      const jobs = Array.from({ length: 2 }, (_, i) =>
        createSerializableJob({
          id: i + 1,
          args: { action: 'delay', delay: 100 }
        })
      );
      const options = createIsolationOptions();

      // Start all jobs
      const promises = jobs.map(job => pool.execute(job, options, 5000));

      // Wait a bit for workers to start
      await new Promise(resolve => setTimeout(resolve, 50));

      const stats = pool.getStats();
      expect(stats.totalWorkers).toBeLessThanOrEqual(2);

      // Wait for all to complete
      const results = await Promise.all(promises);
      expect(results.filter(r => r.status === 'ok').length).toBe(2);
    });

    it('should queue rather than error when no threads are free', async () => {
      // Superseded behaviour: this used to assert that a saturated pool
      // returned an error, which consumed one of the job's retry attempts for
      // something it had no part in. It now waits for a thread.
      pool = new ThreadPool({ maxThreads: 1 });
      const options = createIsolationOptions();

      const longJob = createSerializableJob({ id: 1, args: { action: 'delay', delay: 300 } });
      const first = pool.execute(longJob, options, 10000);

      await waitFor(() => pool.getStats().busyWorkers === 1, { describe: 'the pool to be busy' });

      const shortJob = createSerializableJob({ id: 2, args: { action: 'success' } });
      const second = await pool.execute(shortJob, options, 10000);

      expect(second.status).toBe('ok');
      expect((await first).status).toBe('ok');
  });
  });

  describe('saturation', () => {
    it('queues jobs instead of failing them when every thread is busy', async () => {
      // A job that arrives while the pool is full has not failed -- it has not
      // started. Returning an error consumes one of its retry attempts for
      // something the job had no part in.
      pool = new ThreadPool({ maxThreads: 1 });

      const jobs = Array.from({ length: 3 }, (_, i) =>
        createSerializableJob({ id: i + 1, args: { action: 'delay', delay: 60 } })
      );
      const options = createIsolationOptions();

      const results = await Promise.all(jobs.map(job => pool.execute(job, options, 10000)));

      expect(results.every(r => r.status === 'ok')).toBe(true);
      const errors = results
        .filter((r): r is { status: 'error'; error: Error } => r.status === 'error')
        .map(r => r.error.message);
      expect(errors).toEqual([]);
    }, 20000);

    it('runs queued jobs one at a time on a single-thread pool', async () => {
      pool = new ThreadPool({ maxThreads: 1 });

      const jobs = Array.from({ length: 3 }, (_, i) =>
        createSerializableJob({ id: i + 1, args: { action: 'delay', delay: 60 } })
      );
      const options = createIsolationOptions();

      const results = await Promise.all(jobs.map(job => pool.execute(job, options, 10000)));
      const runs = results.map(
        r => (r as { status: 'ok'; value: { startedAt: number; finishedAt: number } }).value
      );

      const overlapping = runs.some((a, i) =>
        runs.some((b, j) => i !== j && a.startedAt < b.finishedAt && b.startedAt < a.finishedAt)
      );
      expect(overlapping).toBe(false);
    }, 20000);

    it('reports a distinct error when a job gives up waiting for a thread', async () => {
      pool = new ThreadPool({ maxThreads: 1 });
      const options = createIsolationOptions();

      const blocker = pool.execute(
        createSerializableJob({ id: 1, args: { action: 'delay', delay: 2000 } }),
        options,
        10000
      );

      const queued = await pool.execute(
        createSerializableJob({ id: 2, args: { action: 'success' } }),
        options,
        150
      );

      expect(queued.status).toBe('error');
      if (queued.status === 'error') {
        expect((queued.error as Error).message).toMatch(/waiting for a worker thread/i);
      }

      await blocker;
    }, 20000);
  });

  describe('resource limits', () => {
    it('applies the configured heap cap to the worker thread', async () => {
      pool = new ThreadPool({ maxThreads: 1 });

      const job = createSerializableJob({ args: { action: 'allocate', megabytes: 128 } });
      const options = createIsolationOptions({
        resourceLimits: { maxOldGenerationSizeMb: 16 }
      });

      const result = await pool.execute(job, options, 20000);

      // 128MB of live buffers cannot fit in a 16MB heap: the thread must die
      // rather than the allocation quietly succeeding.
      expect(result.status).toBe('error');
    }, 30000);

    it('runs the same work fine without a cap', async () => {
      pool = new ThreadPool({ maxThreads: 1 });

      const job = createSerializableJob({ args: { action: 'allocate', megabytes: 128 } });

      const result = await pool.execute(job, createIsolationOptions(), 20000);

      expect(result.status).toBe('ok');
    }, 30000);
  });
});
