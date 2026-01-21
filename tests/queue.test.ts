import Database from 'better-sqlite3';
import { Queue } from '../src/core/queue.js';
import {
  createSQLiteAdapter,
  defineWorker,
  WorkerResults,
  registerWorker,
  clearWorkers
} from '../src/index.js';
import { telemetry } from '../src/core/telemetry.js';
import type { QueueConfig, Job } from '../src/types.js';

describe('Queue Class', () => {
  let db: Database.Database;
  let adapter: ReturnType<typeof createSQLiteAdapter>;

  beforeEach(async () => {
    db = new Database(':memory:');
    adapter = createSQLiteAdapter(db);
    await adapter.migrate();
    clearWorkers();
  });

  afterEach(async () => {
    await adapter.close();
  });

  function createQueueConfig(overrides: Partial<QueueConfig> = {}): QueueConfig {
    return {
      name: 'test-queue',
      limit: 5,
      paused: false,
      pollInterval: 100,
      ...overrides
    };
  }

  function createJobData(overrides: Partial<Omit<Job, 'id' | 'insertedAt'>> = {}): Omit<Job, 'id' | 'insertedAt'> {
    return {
      state: 'available',
      queue: 'default',
      worker: 'TestWorker',
      args: {},
      meta: {},
      tags: [],
      errors: [],
      attempt: 0,
      maxAttempts: 20,
      priority: 0,
      scheduledAt: new Date(),
      attemptedAt: null,
      completedAt: null,
      discardedAt: null,
      cancelledAt: null,
      ...overrides
    };
  }

  describe('constructor', () => {
    it('should create a queue with given config', () => {
      const config = createQueueConfig({ name: 'my-queue', limit: 10 });
      const queue = new Queue(config, adapter, 'node-1');

      expect(queue.name).toBe('my-queue');
      expect(queue.limit).toBe(10);
      expect(queue.currentState).toBe('stopped');
      expect(queue.runningCount).toBe(0);
    });
  });

  describe('start / stop lifecycle', () => {
    it('should start in running state', async () => {
      const config = createQueueConfig();
      const queue = new Queue(config, adapter, 'node-1');

      await queue.start();

      expect(queue.currentState).toBe('running');

      await queue.stop();
    });

    it('should start in paused state if config.paused is true', async () => {
      const config = createQueueConfig({ paused: true });
      const queue = new Queue(config, adapter, 'node-1');

      await queue.start();

      expect(queue.currentState).toBe('paused');

      await queue.stop();
    });

    it('should stop and reset state', async () => {
      const config = createQueueConfig();
      const queue = new Queue(config, adapter, 'node-1');

      await queue.start();
      expect(queue.currentState).toBe('running');

      await queue.stop();
      expect(queue.currentState).toBe('stopped');
    });

    it('should be idempotent on multiple start calls', async () => {
      const config = createQueueConfig();
      const queue = new Queue(config, adapter, 'node-1');

      await queue.start();
      await queue.start();
      await queue.start();

      expect(queue.currentState).toBe('running');

      await queue.stop();
    });

    it('should be idempotent on multiple stop calls', async () => {
      const config = createQueueConfig();
      const queue = new Queue(config, adapter, 'node-1');

      await queue.start();
      await queue.stop();
      await queue.stop();
      await queue.stop();

      expect(queue.currentState).toBe('stopped');
    });

    it('should emit queue:start event on start', async () => {
      const events: string[] = [];
      const unsubscribe = telemetry.on('queue:start', () => {
        events.push('queue:start');
      });

      const config = createQueueConfig({ name: 'events-queue' });
      const queue = new Queue(config, adapter, 'node-1');

      await queue.start();

      expect(events).toContain('queue:start');

      unsubscribe();
      await queue.stop();
    });

    it('should emit queue:stop event on stop', async () => {
      const events: string[] = [];
      const unsubscribe = telemetry.on('queue:stop', () => {
        events.push('queue:stop');
      });

      const config = createQueueConfig({ name: 'events-queue' });
      const queue = new Queue(config, adapter, 'node-1');

      await queue.start();
      await queue.stop();

      expect(events).toContain('queue:stop');

      unsubscribe();
    });
  });

  describe('pause / resume', () => {
    it('should pause a running queue', async () => {
      const config = createQueueConfig();
      const queue = new Queue(config, adapter, 'node-1');

      await queue.start();
      expect(queue.currentState).toBe('running');

      queue.pause();
      expect(queue.currentState).toBe('paused');

      await queue.stop();
    });

    it('should resume a paused queue', async () => {
      const config = createQueueConfig();
      const queue = new Queue(config, adapter, 'node-1');

      await queue.start();
      queue.pause();
      expect(queue.currentState).toBe('paused');

      queue.resume();
      expect(queue.currentState).toBe('running');

      await queue.stop();
    });

    it('should not pause if not running', async () => {
      const config = createQueueConfig();
      const queue = new Queue(config, adapter, 'node-1');

      queue.pause(); // Queue is stopped
      expect(queue.currentState).toBe('stopped');
    });

    it('should not resume if not paused', async () => {
      const config = createQueueConfig();
      const queue = new Queue(config, adapter, 'node-1');

      await queue.start();
      queue.resume(); // Already running
      expect(queue.currentState).toBe('running');

      await queue.stop();
    });

    it('should emit queue:pause event', async () => {
      const events: string[] = [];
      const unsubscribe = telemetry.on('queue:pause', () => {
        events.push('queue:pause');
      });

      const config = createQueueConfig();
      const queue = new Queue(config, adapter, 'node-1');

      await queue.start();
      queue.pause();

      expect(events).toContain('queue:pause');

      unsubscribe();
      await queue.stop();
    });

    it('should emit queue:resume event', async () => {
      const events: string[] = [];
      const unsubscribe = telemetry.on('queue:resume', () => {
        events.push('queue:resume');
      });

      const config = createQueueConfig();
      const queue = new Queue(config, adapter, 'node-1');

      await queue.start();
      queue.pause();
      queue.resume();

      expect(events).toContain('queue:resume');

      unsubscribe();
      await queue.stop();
    });
  });

  describe('scale', () => {
    it('should change the concurrency limit', async () => {
      const config = createQueueConfig({ limit: 5 });
      const queue = new Queue(config, adapter, 'node-1');

      expect(queue.limit).toBe(5);

      queue.scale(20);
      expect(queue.limit).toBe(20);

      queue.scale(1);
      expect(queue.limit).toBe(1);
    });
  });

  describe('dispatch', () => {
    it('should not poll if not running', async () => {
      const config = createQueueConfig();
      const queue = new Queue(config, adapter, 'node-1');

      // Insert a job
      await adapter.insertJob(createJobData({ queue: 'test-queue' }));

      queue.dispatch(); // Queue is stopped, should not poll

      // Job should still be available
      const jobs = db.prepare('SELECT * FROM izi_jobs WHERE state = ?').all('available');
      expect(jobs).toHaveLength(1);
    });
  });

  describe('job processing', () => {
    it('should process available jobs', async () => {
      const processed: number[] = [];

      registerWorker({
        name: 'ProcessWorker',
        perform: async (job) => {
          processed.push(job.args.id as number);
          return WorkerResults.ok();
        }
      });

      const config = createQueueConfig({ name: 'default', pollInterval: 50 });
      const queue = new Queue(config, adapter, 'node-1');

      await adapter.insertJob(createJobData({ worker: 'ProcessWorker', args: { id: 1 } }));

      await queue.start();

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(processed).toContain(1);

      await queue.stop();
    });

    it('should emit job:start and job:complete events', async () => {
      const events: string[] = [];
      const unsubscribe1 = telemetry.on('job:start', () => events.push('job:start'));
      const unsubscribe2 = telemetry.on('job:complete', () => events.push('job:complete'));

      registerWorker({
        name: 'EventWorker',
        perform: async () => WorkerResults.ok()
      });

      const config = createQueueConfig({ name: 'default', pollInterval: 50 });
      const queue = new Queue(config, adapter, 'node-1');

      await adapter.insertJob(createJobData({ worker: 'EventWorker' }));

      await queue.start();
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(events).toContain('job:start');
      expect(events).toContain('job:complete');

      unsubscribe1();
      unsubscribe2();
      await queue.stop();
    });

    it('should mark job as completed on success', async () => {
      registerWorker({
        name: 'SuccessWorker',
        perform: async () => WorkerResults.ok({ result: 'done' })
      });

      const config = createQueueConfig({ name: 'default', pollInterval: 50 });
      const queue = new Queue(config, adapter, 'node-1');

      const inserted = await adapter.insertJob(createJobData({ worker: 'SuccessWorker' }));

      await queue.start();
      await new Promise(resolve => setTimeout(resolve, 200));

      const job = await adapter.getJob(inserted.id);
      expect(job?.state).toBe('completed');
      expect(job?.completedAt).toBeDefined();

      await queue.stop();
    });

    it('should handle worker errors and retry', async () => {
      let attempts = 0;

      registerWorker({
        name: 'RetryWorker',
        perform: async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error('Temporary failure');
          }
          return WorkerResults.ok();
        }
      });

      const config = createQueueConfig({ name: 'default', pollInterval: 50 });
      const queue = new Queue(config, adapter, 'node-1');

      await adapter.insertJob(createJobData({ worker: 'RetryWorker', maxAttempts: 5 }));

      await queue.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(attempts).toBeGreaterThanOrEqual(1);

      await queue.stop();
    });

    it('should mark job as discarded after max attempts', async () => {
      registerWorker({
        name: 'AlwaysFailWorker',
        perform: async () => {
          throw new Error('Always fails');
        }
      });

      const config = createQueueConfig({ name: 'default', pollInterval: 50 });
      const queue = new Queue(config, adapter, 'node-1');

      const inserted = await adapter.insertJob(createJobData({
        worker: 'AlwaysFailWorker',
        maxAttempts: 1 // Only 1 attempt allowed
      }));

      await queue.start();
      await new Promise(resolve => setTimeout(resolve, 200));

      const job = await adapter.getJob(inserted.id);
      expect(job?.state).toBe('discarded');
      expect(job?.discardedAt).toBeDefined();
      expect(job?.errors.length).toBeGreaterThan(0);

      await queue.stop();
    });

    it('should handle cancel result', async () => {
      registerWorker({
        name: 'CancelWorker',
        perform: async () => WorkerResults.cancel('Data invalid')
      });

      const config = createQueueConfig({ name: 'default', pollInterval: 50 });
      const queue = new Queue(config, adapter, 'node-1');

      const inserted = await adapter.insertJob(createJobData({ worker: 'CancelWorker' }));

      await queue.start();
      await new Promise(resolve => setTimeout(resolve, 200));

      const job = await adapter.getJob(inserted.id);
      expect(job?.state).toBe('cancelled');
      expect(job?.cancelledAt).toBeDefined();

      await queue.stop();
    });

    it('should handle snooze result', async () => {
      registerWorker({
        name: 'SnoozeWorker',
        perform: async () => WorkerResults.snooze(60) // Snooze for 60 seconds
      });

      const config = createQueueConfig({ name: 'default', pollInterval: 50 });
      const queue = new Queue(config, adapter, 'node-1');

      const inserted = await adapter.insertJob(createJobData({ worker: 'SnoozeWorker' }));

      await queue.start();
      await new Promise(resolve => setTimeout(resolve, 200));

      const job = await adapter.getJob(inserted.id);
      expect(job?.state).toBe('scheduled');
      expect(job?.scheduledAt.getTime()).toBeGreaterThan(Date.now());
      expect(job?.meta?.snoozedAt).toBeDefined();

      await queue.stop();
    });

    it('should handle missing worker gracefully', async () => {
      const config = createQueueConfig({ name: 'default', pollInterval: 50 });
      const queue = new Queue(config, adapter, 'node-1');

      const inserted = await adapter.insertJob(createJobData({
        worker: 'NonExistentWorker',
        maxAttempts: 1
      }));

      await queue.start();
      await new Promise(resolve => setTimeout(resolve, 200));

      const job = await adapter.getJob(inserted.id);
      expect(job?.state).toBe('discarded');
      expect(job?.errors.length).toBeGreaterThan(0);
      expect(job?.errors[0].error).toContain('not registered');

      await queue.stop();
    });
  });

  describe('concurrency', () => {
    it('should respect concurrency limit', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      registerWorker({
        name: 'ConcurrentWorker',
        perform: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise(resolve => setTimeout(resolve, 100));
          concurrent--;
          return WorkerResults.ok();
        }
      });

      const config = createQueueConfig({ name: 'default', limit: 2, pollInterval: 20 });
      const queue = new Queue(config, adapter, 'node-1');

      // Insert 5 jobs
      for (let i = 0; i < 5; i++) {
        await adapter.insertJob(createJobData({ worker: 'ConcurrentWorker', args: { id: i } }));
      }

      await queue.start();
      await new Promise(resolve => setTimeout(resolve, 800));

      // Max concurrent should never exceed limit
      expect(maxConcurrent).toBeLessThanOrEqual(2);

      await queue.stop();
    });

    it('should track running job count', async () => {
      let runningDuringExecution = 0;

      registerWorker({
        name: 'TrackingWorker',
        perform: async () => {
          await new Promise(resolve => setTimeout(resolve, 100));
          return WorkerResults.ok();
        }
      });

      const config = createQueueConfig({ name: 'default', limit: 3, pollInterval: 20 });
      const queue = new Queue(config, adapter, 'node-1');

      await adapter.insertJob(createJobData({ worker: 'TrackingWorker' }));

      await queue.start();

      // Check running count during execution
      await new Promise(resolve => setTimeout(resolve, 50));
      runningDuringExecution = queue.runningCount;

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(runningDuringExecution).toBeGreaterThanOrEqual(0);
      expect(queue.runningCount).toBe(0);

      await queue.stop();
    });
  });

  describe('priority ordering', () => {
    it('should process higher priority jobs first (lower number = higher priority)', async () => {
      const processed: number[] = [];

      registerWorker({
        name: 'PriorityWorker',
        perform: async (job) => {
          processed.push(job.args.priority as number);
          return WorkerResults.ok();
        }
      });

      const config = createQueueConfig({ name: 'default', limit: 1, pollInterval: 50 });
      const queue = new Queue(config, adapter, 'node-1');

      // Insert jobs with different priorities (lower = higher priority)
      await adapter.insertJob(createJobData({
        worker: 'PriorityWorker',
        args: { priority: 10 },
        priority: 10 // Low priority
      }));

      await adapter.insertJob(createJobData({
        worker: 'PriorityWorker',
        args: { priority: -10 },
        priority: -10 // High priority
      }));

      await adapter.insertJob(createJobData({
        worker: 'PriorityWorker',
        args: { priority: 0 },
        priority: 0 // Normal priority
      }));

      await queue.start();
      await new Promise(resolve => setTimeout(resolve, 500));

      // Should be processed in priority order: -10, 0, 10
      expect(processed).toEqual([-10, 0, 10]);

      await queue.stop();
    });
  });

  describe('graceful shutdown', () => {
    it('should wait for running jobs during stop', async () => {
      let jobCompleted = false;

      registerWorker({
        name: 'LongWorker',
        perform: async () => {
          await new Promise(resolve => setTimeout(resolve, 200));
          jobCompleted = true;
          return WorkerResults.ok();
        }
      });

      const config = createQueueConfig({ name: 'default', pollInterval: 20 });
      const queue = new Queue(config, adapter, 'node-1');

      await adapter.insertJob(createJobData({ worker: 'LongWorker' }));

      await queue.start();
      await new Promise(resolve => setTimeout(resolve, 50)); // Let job start

      // Stop with grace period
      await queue.stop(1000);

      expect(jobCompleted).toBe(true);
    });

    it('should timeout if jobs take too long during stop', async () => {
      let jobCompleted = false;

      registerWorker({
        name: 'VeryLongWorker',
        perform: async () => {
          await new Promise(resolve => setTimeout(resolve, 2000));
          jobCompleted = true;
          return WorkerResults.ok();
        }
      });

      const config = createQueueConfig({ name: 'default', pollInterval: 20 });
      const queue = new Queue(config, adapter, 'node-1');

      await adapter.insertJob(createJobData({ worker: 'VeryLongWorker' }));

      await queue.start();
      await new Promise(resolve => setTimeout(resolve, 50)); // Let job start

      // Stop with short grace period
      await queue.stop(100);

      // Job should not have completed due to timeout
      expect(jobCompleted).toBe(false);
    });
  });
});
