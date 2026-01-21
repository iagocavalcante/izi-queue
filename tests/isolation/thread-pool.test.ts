import { join } from 'path';
import { ThreadPool } from '../../src/core/isolation/thread-pool.js';
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

      const startTime = Date.now();
      const results = await Promise.all(
        jobs.map(job => pool.execute(job, options, 5000))
      );
      const elapsed = Date.now() - startTime;

      // All jobs should complete
      expect(results.every(r => r.status === 'ok')).toBe(true);

      // Should complete in roughly the time of one job since they run in parallel
      expect(elapsed).toBeLessThan(400); // Allow some overhead
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
      await pool.terminate(job.id);

      const result = await executePromise;

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect((result.error as Error).message).toContain('terminated');
      }
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

    it('should return error when no threads available', async () => {
      pool = new ThreadPool({ maxThreads: 1 });
      const options = createIsolationOptions();

      // Start one long-running job
      const longJob = createSerializableJob({
        id: 1,
        args: { action: 'delay', delay: 2000 }
      });
      pool.execute(longJob, options, 5000);

      // Wait for thread to be busy
      await new Promise(resolve => setTimeout(resolve, 50));

      // Try to start another job - should fail since thread is busy
      const shortJob = createSerializableJob({
        id: 2,
        args: { action: 'success' }
      });
      const result = await pool.execute(shortJob, options, 1000);

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect((result.error as Error).message).toContain('No available worker threads');
      }
    });
  });
});
