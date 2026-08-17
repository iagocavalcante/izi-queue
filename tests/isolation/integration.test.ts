import { join } from 'path';
import Database from 'better-sqlite3';
import {
  createIziQueue,
  defineWorker,
  WorkerResults,
  clearWorkers,
  shutdownIsolatedWorkers
} from '../../src/index.js';
import { createSQLiteAdapter } from '../../src/database/sqlite.js';
import type { Job } from '../../src/types.js';
import { waitFor } from '../helpers/wait.js';

const TEST_WORKER_PATH = join(__dirname, '../fixtures/test-isolated-worker.js');

describe('Isolated Workers Integration', () => {
  let sqliteDb: Database.Database;
  let db: ReturnType<typeof createSQLiteAdapter>;

  beforeEach(async () => {
    clearWorkers();
    sqliteDb = new Database(':memory:');
    db = createSQLiteAdapter(sqliteDb);
    await db.migrate();
  });

  afterEach(async () => {
    await shutdownIsolatedWorkers();
    await db.close();
    clearWorkers();
  });

  it('should execute isolated workers alongside non-isolated workers', async () => {
    const results: { isolated: string[]; nonIsolated: string[] } = {
      isolated: [],
      nonIsolated: []
    };

    // Non-isolated worker
    const regularWorker = defineWorker('RegularWorker', async (job: Job) => {
      results.nonIsolated.push(`job-${job.id}`);
      return WorkerResults.ok({ regular: true });
    }, {
      queue: 'default'
    });

    // Isolated worker
    const isolatedWorker = defineWorker('IsolatedWorker', async () => {
      // This perform function won't be called - the workerPath is used instead
      return WorkerResults.ok();
    }, {
      queue: 'default',
      isolation: {
        isolated: true,
        workerPath: TEST_WORKER_PATH
      }
    });

    const queue = createIziQueue({
      database: db,
      queues: { default: 5 },
      pollInterval: 100,
      isolation: { maxThreads: 2 }
    });

    queue.register(regularWorker);
    queue.register(isolatedWorker);

    await queue.start();

    // Insert jobs
    const regularJob = await queue.insert(regularWorker, {
      args: { type: 'regular' }
    });

    const isolatedJob = await queue.insert(isolatedWorker, {
      args: { action: 'success' }
    });

    // Wait for processing - need enough time for poll + execution
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Verify regular worker executed
    expect(results.nonIsolated).toContain(`job-${regularJob.id}`);

    // Verify isolated job completed
    const updatedIsolatedJob = await queue.getJob(isolatedJob.id);
    expect(updatedIsolatedJob?.state).toBe('completed');

    await queue.shutdown();
  });

  it('should handle isolated worker crashes without affecting main thread', async () => {
    const crashingWorker = defineWorker('CrashingWorker', async () => {
      return WorkerResults.ok();
    }, {
      queue: 'default',
      maxAttempts: 1,
      isolation: {
        isolated: true,
        workerPath: TEST_WORKER_PATH
      }
    });

    const queue = createIziQueue({
      database: db,
      queues: { default: 5 },
      pollInterval: 100,
      isolation: { maxThreads: 2 }
    });

    queue.register(crashingWorker);
    await queue.start();

    // Insert a crashing job
    const job = await queue.insert(crashingWorker, {
      args: { action: 'crash', crashMessage: 'Integration test crash' }
    });

    // Wait for processing - need enough time for poll + execution
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Job should be discarded (maxAttempts: 1)
    const updatedJob = await queue.getJob(job.id);
    expect(updatedJob?.state).toBe('discarded');
    expect(updatedJob?.errors.length).toBeGreaterThan(0);
    expect(updatedJob?.errors[0].error).toContain('Integration test crash');

    // Main thread should still be running
    expect(queue.isStarted).toBe(true);

    await queue.shutdown();
  });

  it('should respect isolated worker timeout', async () => {
    const slowWorker = defineWorker('SlowIsolatedWorker', async () => {
      return WorkerResults.ok();
    }, {
      queue: 'default',
      timeout: 200, // 200ms timeout
      maxAttempts: 1,
      isolation: {
        isolated: true,
        workerPath: TEST_WORKER_PATH
      }
    });

    const queue = createIziQueue({
      database: db,
      queues: { default: 5 },
      pollInterval: 100,
      isolation: { maxThreads: 2 }
    });

    queue.register(slowWorker);
    await queue.start();

    // Insert a slow job that will timeout
    const job = await queue.insert(slowWorker, {
      args: { action: 'delay', delay: 5000 }
    });

    // Wait for timeout + processing - need time for poll + timeout
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Job should be discarded due to timeout
    const updatedJob = await queue.getJob(job.id);
    expect(updatedJob?.state).toBe('discarded');
    expect(updatedJob?.errors[0].error).toContain('timed out');

    await queue.shutdown();
  });

  it('should provide isolation stats', async () => {
    const worker = defineWorker('StatsWorker', async () => {
      return WorkerResults.ok();
    }, {
      queue: 'default',
      isolation: {
        isolated: true,
        workerPath: TEST_WORKER_PATH
      }
    });

    const queue = createIziQueue({
      database: db,
      queues: { default: 5 },
      pollInterval: 100,
      isolation: { maxThreads: 4 }
    });

    queue.register(worker);
    await queue.start();

    // Execute some isolated jobs
    await queue.insert(worker, { args: { action: 'success' } });
    await queue.insert(worker, { args: { action: 'success' } });

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 2000));

    const stats = queue.getIsolationStats();
    expect(stats).not.toBeNull();
    expect(stats).toMatchObject({
      totalWorkers: expect.any(Number),
      busyWorkers: expect.any(Number),
      idleWorkers: expect.any(Number),
      pendingJobs: expect.any(Number)
    });

    await queue.shutdown();
  });

  it('should handle snooze result from isolated worker', async () => {
    const snoozeWorker = defineWorker('SnoozeWorker', async () => {
      return WorkerResults.ok();
    }, {
      queue: 'default',
      isolation: {
        isolated: true,
        workerPath: TEST_WORKER_PATH
      }
    });

    const queue = createIziQueue({
      database: db,
      queues: { default: 5 },
      pollInterval: 100,
      isolation: { maxThreads: 2 }
    });

    queue.register(snoozeWorker);
    await queue.start();

    const job = await queue.insert(snoozeWorker, {
      args: { action: 'snooze', seconds: 60 }
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    const updatedJob = await queue.getJob(job.id);
    expect(updatedJob?.state).toBe('scheduled');
    expect(updatedJob?.meta?.snoozedAt).toBeDefined();

    await queue.shutdown();
  });

  it('should handle cancel result from isolated worker', async () => {
    const cancelWorker = defineWorker('CancelWorker', async () => {
      return WorkerResults.ok();
    }, {
      queue: 'default',
      isolation: {
        isolated: true,
        workerPath: TEST_WORKER_PATH
      }
    });

    const queue = createIziQueue({
      database: db,
      queues: { default: 5 },
      pollInterval: 100,
      isolation: { maxThreads: 2 }
    });

    queue.register(cancelWorker);
    await queue.start();

    const job = await queue.insert(cancelWorker, {
      args: { action: 'cancel', reason: 'Integration test cancellation' }
    });

    await new Promise(resolve => setTimeout(resolve, 2000));

    const updatedJob = await queue.getJob(job.id);
    expect(updatedJob?.state).toBe('cancelled');
    expect(updatedJob?.errors[0].error).toContain('Integration test cancellation');

    await queue.shutdown();
  });

  it('should execute CPU-bound work in parallel using isolation', async () => {
    const cpuWorker = defineWorker('CpuBoundWorker', async () => {
      return WorkerResults.ok();
    }, {
      queue: 'default',
      isolation: {
        isolated: true,
        workerPath: TEST_WORKER_PATH
      }
    });

    const queue = createIziQueue({
      database: db,
      queues: { default: 5 },
      pollInterval: 100,
      isolation: { maxThreads: 4 }
    });

    queue.register(cpuWorker);
    await queue.start();

    // Insert multiple CPU-bound jobs - use fewer to avoid thread pool limits
    const jobs = await Promise.all([
      queue.insert(cpuWorker, { args: { action: 'cpu-bound' } }),
      queue.insert(cpuWorker, { args: { action: 'cpu-bound' } })
    ]);

    // Wait for processing - CPU-bound work takes longer
    await new Promise(resolve => setTimeout(resolve, 5000));

    // All jobs should complete
    for (const job of jobs) {
      const updatedJob = await queue.getJob(job.id);
      expect(updatedJob?.state).toBe('completed');
    }

    await queue.shutdown();
  }, 10000); // Increase test timeout

  it('should gracefully shutdown with running isolated jobs', async () => {
    const slowWorker = defineWorker('SlowShutdownWorker', async () => {
      return WorkerResults.ok();
    }, {
      queue: 'default',
      isolation: {
        isolated: true,
        workerPath: TEST_WORKER_PATH
      }
    });

    const queue = createIziQueue({
      database: db,
      queues: { default: 5 },
      shutdownGracePeriod: 500,
      isolation: { maxThreads: 2 }
    });

    queue.register(slowWorker);
    await queue.start();

    // Insert a slow job
    await queue.insert(slowWorker, {
      args: { action: 'delay', delay: 10000 }
    });

    // Give job time to start
    await new Promise(resolve => setTimeout(resolve, 100));

    // Shutdown should complete despite running job (grace period will force termination)
    await expect(queue.shutdown()).resolves.not.toThrow();
  });

  describe('cancelling a running isolated job', () => {
    it('pre-emptively terminates the thread, settles the job cancelled, and leaves the pool healthy', async () => {
      const longWorker = defineWorker('LongIsolatedWorker', async () => WorkerResults.ok(), {
        queue: 'default',
        isolation: {
          isolated: true,
          workerPath: TEST_WORKER_PATH
        }
      });

      const queue = createIziQueue({
        database: db,
        queues: { default: 5 },
        pollInterval: 50,
        isolation: { maxThreads: 2 }
      });

      queue.register(longWorker);
      await queue.start();

      const job = await queue.insert(longWorker, {
        args: { action: 'delay', delay: 10000 }
      });

      await waitFor(
        async () => (await queue.getJob(job.id))?.state === 'executing',
        { describe: 'the isolated job to start executing' }
      );
      await waitFor(
        () => (queue.getIsolationStats()?.busyWorkers ?? 0) > 0,
        { describe: 'the worker thread to pick up the job' }
      );

      const cancelled = await queue.cancelJob(job.id);
      expect(cancelled).toBe(true);

      // Pre-emptive: the job must settle promptly, not after the 10s delay
      // it asked for.
      const final = await waitFor(
        async () => {
          const current = await queue.getJob(job.id);
          return current?.state === 'cancelled' ? current : null;
        },
        { describe: 'the terminated isolated job to settle cancelled', timeout: 3000 }
      );

      expect(final?.state).toBe('cancelled');
      // Terminating it must not have burned a retry or recorded a failure --
      // it settles on the direct DB cancellation, not on the thread's result.
      expect(final?.errors).toHaveLength(0);

      // The pool must stay healthy: no leaked slot, capacity for a fresh job.
      const healthy = await queue.insert(longWorker, { args: { action: 'success' } });
      const healthyFinal = await waitFor(
        async () => {
          const current = await queue.getJob(healthy.id);
          return current?.state === 'completed' ? current : null;
        },
        { describe: 'a fresh isolated job to complete after termination' }
      );
      expect(healthyFinal?.state).toBe('completed');

      await queue.shutdown();
    }, 20000);
  });
});
