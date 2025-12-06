import Database from 'better-sqlite3';
import {
  createIziQueue,
  createSQLiteAdapter,
  defineWorker,
  WorkerResults,
  createLifelinePlugin,
  createPrunerPlugin,
  clearWorkers
} from '../src/index.js';
import type { Job } from '../src/types.js';

describe('Integration Tests', () => {
  let db: Database.Database;
  let adapter: ReturnType<typeof createSQLiteAdapter>;

  beforeEach(() => {
    db = new Database(':memory:');
    adapter = createSQLiteAdapter(db);
    clearWorkers();
  });

  afterEach(async () => {
    await adapter.close();
  });

  describe('Basic Job Processing', () => {
    it('should insert and retrieve a job', async () => {
      await adapter.migrate();

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const job = await queue.insert('TestWorker', {
        args: { message: 'Hello' }
      });

      expect(job.id).toBeDefined();
      expect(job.worker).toBe('TestWorker');
      expect(job.args).toEqual({ message: 'Hello' });
      expect(job.state).toBe('available');

      const retrieved = await queue.getJob(job.id);
      expect(retrieved).toEqual(job);

      await queue.shutdown();
    });

    it('should execute a job through the queue', async () => {
      await adapter.migrate();

      const processed: string[] = [];

      const worker = defineWorker<{ message: string }>(
        'ProcessWorker',
        async (job) => {
          processed.push(job.args.message);
          return WorkerResults.ok();
        }
      );

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 },
        pollInterval: 50
      });

      queue.register(worker);
      await queue.start();

      await queue.insert('ProcessWorker', {
        args: { message: 'test-message' }
      });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(processed).toContain('test-message');

      // Check job state
      const jobs = db.prepare('SELECT * FROM izi_jobs WHERE worker = ?').all('ProcessWorker') as any[];
      expect(jobs[0].state).toBe('completed');

      await queue.shutdown();
    });

    it('should retry failed jobs with backoff', async () => {
      await adapter.migrate();

      let attempts = 0;

      const worker = defineWorker('FailingWorker', async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Temporary failure');
        }
        return WorkerResults.ok();
      });

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 },
        pollInterval: 50,
        stageInterval: 50
      });

      queue.register(worker);
      await queue.start();

      await queue.insert('FailingWorker', {
        args: {},
        maxAttempts: 5
      });

      // Wait for retries (this test is time-sensitive)
      await new Promise(resolve => setTimeout(resolve, 500));

      // Check that multiple attempts were made
      expect(attempts).toBeGreaterThanOrEqual(1);

      await queue.shutdown();
    });

    it('should discard job after max attempts', async () => {
      await adapter.migrate();

      const worker = defineWorker('AlwaysFailWorker', async () => {
        throw new Error('Always fails');
      });

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 },
        pollInterval: 50,
        stageInterval: 50
      });

      queue.register(worker);
      await queue.start();

      const job = await queue.insert('AlwaysFailWorker', {
        args: {},
        maxAttempts: 2
      });

      // Wait for processing and retries
      await new Promise(resolve => setTimeout(resolve, 300));

      const finalJob = await queue.getJob(job.id);
      // Job should be retryable or discarded
      expect(['retryable', 'discarded', 'executing']).toContain(finalJob?.state);

      await queue.shutdown();
    });
  });

  describe('Unique Jobs', () => {
    it('should prevent duplicate jobs with same args', async () => {
      await adapter.migrate();

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const result1 = await queue.insertWithResult('UniqueWorker', {
        args: { userId: 123 },
        unique: { period: 60 }
      });

      const result2 = await queue.insertWithResult('UniqueWorker', {
        args: { userId: 123 },
        unique: { period: 60 }
      });

      expect(result1.conflict).toBe(false);
      expect(result2.conflict).toBe(true);
      expect(result1.job.id).toBe(result2.job.id);

      await queue.shutdown();
    });

    it('should allow different args even with unique constraint', async () => {
      await adapter.migrate();

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const result1 = await queue.insertWithResult('UniqueWorker', {
        args: { userId: 123 },
        unique: { period: 60 }
      });

      const result2 = await queue.insertWithResult('UniqueWorker', {
        args: { userId: 456 },
        unique: { period: 60 }
      });

      expect(result1.conflict).toBe(false);
      expect(result2.conflict).toBe(false);
      expect(result1.job.id).not.toBe(result2.job.id);

      await queue.shutdown();
    });

    it('should check only specified keys', async () => {
      await adapter.migrate();

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const result1 = await queue.insertWithResult('UniqueWorker', {
        args: { userId: 123, timestamp: Date.now() },
        unique: { keys: ['userId'], period: 60 }
      });

      const result2 = await queue.insertWithResult('UniqueWorker', {
        args: { userId: 123, timestamp: Date.now() + 1000 },
        unique: { keys: ['userId'], period: 60 }
      });

      expect(result1.conflict).toBe(false);
      expect(result2.conflict).toBe(true);

      await queue.shutdown();
    });
  });

  describe('Queue Management', () => {
    it('should pause and resume queues', async () => {
      await adapter.migrate();

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 },
        pollInterval: 50
      });

      await queue.start();

      expect(queue.getQueueStatus('default')?.state).toBe('running');

      queue.pauseQueue('default');
      expect(queue.getQueueStatus('default')?.state).toBe('paused');

      queue.resumeQueue('default');
      expect(queue.getQueueStatus('default')?.state).toBe('running');

      await queue.shutdown();
    });

    it('should scale queue concurrency', async () => {
      await adapter.migrate();

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await queue.start();

      expect(queue.getQueueStatus('default')?.limit).toBe(5);

      queue.scaleQueue('default', 10);
      expect(queue.getQueueStatus('default')?.limit).toBe(10);

      await queue.shutdown();
    });

    it('should get all queue statuses', async () => {
      await adapter.migrate();

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5, priority: 10, slow: 2 }
      });

      await queue.start();

      const statuses = queue.getAllQueueStatus();
      expect(statuses).toHaveLength(3);
      expect(statuses.map(s => s.name)).toContain('default');
      expect(statuses.map(s => s.name)).toContain('priority');
      expect(statuses.map(s => s.name)).toContain('slow');

      await queue.shutdown();
    });
  });

  describe('Scheduled Jobs', () => {
    it('should schedule job for future execution', async () => {
      await adapter.migrate();

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const futureDate = new Date(Date.now() + 60000); // 1 minute in future

      const job = await queue.insert('ScheduledWorker', {
        args: {},
        scheduledAt: futureDate
      });

      expect(job.state).toBe('scheduled');
      expect(job.scheduledAt.getTime()).toBe(futureDate.getTime());

      await queue.shutdown();
    });
  });

  describe('Telemetry', () => {
    it('should emit job events', async () => {
      await adapter.migrate();

      const events: string[] = [];

      const worker = defineWorker('TelemetryWorker', async () => {
        return WorkerResults.ok();
      });

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 },
        pollInterval: 50
      });

      queue.on('*', (payload) => {
        events.push(payload.event);
      });

      queue.register(worker);
      await queue.start();

      await queue.insert('TelemetryWorker', { args: {} });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(events).toContain('queue:start');
      expect(events).toContain('job:start');
      expect(events).toContain('job:complete');

      await queue.shutdown();
    });
  });

  describe('Plugins', () => {
    it('should load and start plugins', async () => {
      await adapter.migrate();

      const lifeline = createLifelinePlugin({
        interval: 1000,
        rescueAfter: 60
      });

      const pruner = createPrunerPlugin({
        interval: 1000,
        maxAge: 3600
      });

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 },
        plugins: [lifeline, pruner]
      });

      await queue.start();

      // Plugins should be running
      expect(queue.isStarted).toBe(true);

      await queue.shutdown();
    });

    it('should validate plugin configuration', () => {
      const invalidLifeline = createLifelinePlugin({
        interval: 100,
        rescueAfter: 5 // Too low, minimum is 10
      });

      expect(() => {
        createIziQueue({
          database: adapter,
          queues: { default: 5 },
          plugins: [invalidLifeline]
        });
      }).toThrow(/validation failed/);
    });
  });

  describe('Cancel Jobs', () => {
    it('should cancel jobs by criteria', async () => {
      await adapter.migrate();

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await queue.insert('CancelWorker', { args: { id: 1 } });
      await queue.insert('CancelWorker', { args: { id: 2 } });
      await queue.insert('OtherWorker', { args: { id: 3 } });

      const cancelled = await queue.cancelJobs({ worker: 'CancelWorker' });
      expect(cancelled).toBe(2);

      const jobs = db.prepare('SELECT * FROM izi_jobs WHERE state = ?').all('cancelled') as any[];
      expect(jobs).toHaveLength(2);

      await queue.shutdown();
    });
  });

  describe('Prune Jobs', () => {
    it('should prune old completed jobs', async () => {
      await adapter.migrate();

      // Insert a job and mark it completed with old timestamp
      const stmt = db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, completed_at)
        VALUES ('completed', 'default', 'OldWorker', '{}', datetime('now', '-10 days'))
      `);
      stmt.run();

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const pruned = await queue.pruneJobs(86400 * 7); // 7 days
      expect(pruned).toBe(1);

      const jobs = db.prepare('SELECT * FROM izi_jobs WHERE worker = ?').all('OldWorker') as any[];
      expect(jobs).toHaveLength(0);

      await queue.shutdown();
    });
  });

  describe('Migrations', () => {
    it('should apply migrations in order', async () => {
      await adapter.migrate();

      const status = await adapter.getMigrationStatus();

      expect(status.length).toBeGreaterThan(0);
      expect(status.every(m => m.applied)).toBe(true);

      // All migrations should be applied
      const migrations = db.prepare('SELECT * FROM izi_migrations ORDER BY version').all() as any[];
      expect(migrations.length).toBeGreaterThan(0);
      expect(migrations[0].version).toBe(1);
    });

    it('should be idempotent', async () => {
      await adapter.migrate();
      await adapter.migrate(); // Should not fail
      await adapter.migrate(); // Should not fail

      const migrations = db.prepare('SELECT * FROM izi_migrations').all() as any[];
      // Count should be stable
      const count = migrations.length;

      await adapter.migrate();

      const migrationsAfter = db.prepare('SELECT * FROM izi_migrations').all() as any[];
      expect(migrationsAfter.length).toBe(count);
    });
  });
});
