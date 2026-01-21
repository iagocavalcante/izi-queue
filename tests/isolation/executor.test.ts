import { join } from 'path';
import {
  initializeIsolation,
  executeIsolated,
  terminateIsolatedJob,
  shutdownIsolation,
  getIsolationStats,
  getThreadPool
} from '../../src/core/isolation/executor.js';
import type { Job, IsolatedWorkerOptions } from '../../src/types.js';

const TEST_WORKER_PATH = join(__dirname, '../fixtures/test-isolated-worker.js');

function createMockJob(overrides: Partial<Job> = {}): Job {
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
    insertedAt: new Date(),
    scheduledAt: new Date(),
    attemptedAt: new Date(),
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

describe('Isolation Executor', () => {
  afterEach(async () => {
    await shutdownIsolation();
  });

  describe('initializeIsolation', () => {
    it('should initialize the thread pool with default config', () => {
      initializeIsolation();

      const pool = getThreadPool();
      expect(pool).not.toBeNull();
    });

    it('should initialize with custom config', () => {
      initializeIsolation({
        minThreads: 2,
        maxThreads: 8,
        idleTimeoutMs: 60000
      });

      const pool = getThreadPool();
      expect(pool).not.toBeNull();
    });

    it('should not reinitialize if already initialized', () => {
      initializeIsolation({ maxThreads: 4 });
      const pool1 = getThreadPool();

      initializeIsolation({ maxThreads: 8 });
      const pool2 = getThreadPool();

      expect(pool1).toBe(pool2);
    });
  });

  describe('executeIsolated', () => {
    it('should execute a job in isolation', async () => {
      initializeIsolation({ maxThreads: 2 });

      const job = createMockJob({
        args: { action: 'success' }
      });
      const options = createIsolationOptions();

      const result = await executeIsolated(job, options, 5000);

      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value).toMatchObject({
          processed: true,
          jobId: job.id
        });
      }
    });

    it('should auto-initialize if not initialized', async () => {
      // Don't call initializeIsolation explicitly
      const job = createMockJob({
        args: { action: 'success' }
      });
      const options = createIsolationOptions();

      const result = await executeIsolated(job, options, 5000);

      expect(result.status).toBe('ok');
      expect(getThreadPool()).not.toBeNull();
    });

    it('should serialize and deserialize dates correctly', async () => {
      initializeIsolation({ maxThreads: 2 });

      const insertedAt = new Date('2024-01-15T10:30:00Z');
      const job = createMockJob({
        args: { action: 'success' },
        insertedAt
      });
      const options = createIsolationOptions();

      const result = await executeIsolated(job, options, 5000);

      expect(result.status).toBe('ok');
    });

    it('should handle job errors', async () => {
      initializeIsolation({ maxThreads: 2 });

      const job = createMockJob({
        args: { action: 'crash', crashMessage: 'Executor test crash' }
      });
      const options = createIsolationOptions();

      const result = await executeIsolated(job, options, 5000);

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect((result.error as Error).message).toContain('Executor test crash');
      }
    });
  });

  describe('terminateIsolatedJob', () => {
    it('should terminate a running isolated job', async () => {
      initializeIsolation({ maxThreads: 2 });

      const job = createMockJob({
        args: { action: 'delay', delay: 10000 }
      });
      const options = createIsolationOptions();

      // Start the long-running job
      const executePromise = executeIsolated(job, options, 30000);

      // Wait for it to start
      await new Promise(resolve => setTimeout(resolve, 50));

      // Terminate it
      await terminateIsolatedJob(job.id);

      const result = await executePromise;

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect((result.error as Error).message).toContain('terminated');
      }
    });

    it('should be a no-op if job does not exist', async () => {
      initializeIsolation({ maxThreads: 2 });

      // Should not throw
      await expect(terminateIsolatedJob(99999)).resolves.not.toThrow();
    });
  });

  describe('shutdownIsolation', () => {
    it('should shutdown the thread pool', async () => {
      initializeIsolation({ maxThreads: 2 });
      expect(getThreadPool()).not.toBeNull();

      await shutdownIsolation();

      expect(getThreadPool()).toBeNull();
    });

    it('should be safe to call multiple times', async () => {
      initializeIsolation({ maxThreads: 2 });

      await shutdownIsolation();
      await expect(shutdownIsolation()).resolves.not.toThrow();
    });
  });

  describe('getIsolationStats', () => {
    it('should return null if not initialized', () => {
      const stats = getIsolationStats();
      expect(stats).toBeNull();
    });

    it('should return stats when initialized', async () => {
      initializeIsolation({ maxThreads: 2 });

      // Execute a job to create workers
      const job = createMockJob({ args: { action: 'success' } });
      const options = createIsolationOptions();
      await executeIsolated(job, options, 5000);

      const stats = getIsolationStats();

      expect(stats).not.toBeNull();
      expect(stats).toMatchObject({
        totalWorkers: expect.any(Number),
        busyWorkers: expect.any(Number),
        idleWorkers: expect.any(Number),
        pendingJobs: expect.any(Number)
      });
    });
  });
});
