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

describe('IziQueue Class', () => {
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

  describe('constructor', () => {
    it('should create queue with object-style queue config', () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5, priority: 10 }
      });

      expect(queue.isStarted).toBe(false);
      expect(queue.database).toBe(adapter);
    });

    it('should create queue with array-style queue config', () => {
      const queue = createIziQueue({
        database: adapter,
        queues: [
          { name: 'default', limit: 5, paused: false },
          { name: 'priority', limit: 10, paused: false }
        ]
      });

      expect(queue.isStarted).toBe(false);
    });

    it('should generate a unique node identifier', () => {
      const queue1 = createIziQueue({ database: adapter, queues: { default: 5 } });
      const queue2 = createIziQueue({ database: adapter, queues: { default: 5 } });

      expect(queue1.node).toBeDefined();
      expect(queue2.node).toBeDefined();
      expect(queue1.node).not.toBe(queue2.node);
    });

    it('should use provided node identifier', () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 },
        node: 'custom-node-1'
      });

      expect(queue.node).toBe('custom-node-1');
    });

    it('should validate plugins on construction', () => {
      const invalidPlugin = createLifelinePlugin({
        interval: 100, // Too low
        rescueAfter: 5 // Too low
      });

      expect(() => {
        createIziQueue({
          database: adapter,
          queues: { default: 5 },
          plugins: [invalidPlugin]
        });
      }).toThrow(/validation failed/);
    });

    it('should accept valid plugins', () => {
      const lifeline = createLifelinePlugin({ interval: 5000, rescueAfter: 60 });
      const pruner = createPrunerPlugin({ interval: 5000, maxAge: 3600 });

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 },
        plugins: [lifeline, pruner]
      });

      expect(queue.isStarted).toBe(false);
    });
  });

  describe('start / stop lifecycle', () => {
    it('should start and mark isStarted as true', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      expect(queue.isStarted).toBe(false);

      await queue.start();
      expect(queue.isStarted).toBe(true);

      await queue.shutdown();
      expect(queue.isStarted).toBe(false);
    });

    it('should be idempotent on multiple start calls', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await queue.start();
      await queue.start();
      await queue.start();

      expect(queue.isStarted).toBe(true);

      await queue.shutdown();
    });

    it('should be idempotent on multiple stop calls', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await queue.start();
      await queue.stop();
      await queue.stop();
      await queue.stop();

      expect(queue.isStarted).toBe(false);

      await adapter.close();
    });

    it('should start plugins when queue starts', async () => {
      const lifeline = createLifelinePlugin({ interval: 60000, rescueAfter: 300 });

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 },
        plugins: [lifeline]
      });

      await queue.start();
      expect(queue.isStarted).toBe(true);

      await queue.shutdown();
    });
  });

  describe('register', () => {
    it('should register a worker and return this for chaining', () => {
      const worker = defineWorker('TestWorker', async () => WorkerResults.ok());

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const result = queue.register(worker);
      expect(result).toBe(queue);
    });

    it('should allow chaining multiple registrations', () => {
      const worker1 = defineWorker('Worker1', async () => WorkerResults.ok());
      const worker2 = defineWorker('Worker2', async () => WorkerResults.ok());

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      queue.register(worker1).register(worker2);
    });
  });

  describe('insert', () => {
    it('should insert a job by worker name', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const job = await queue.insert('TestWorker', {
        args: { data: 'test' }
      });

      expect(job.id).toBeDefined();
      expect(job.worker).toBe('TestWorker');
      expect(job.args).toEqual({ data: 'test' });
      expect(job.state).toBe('available');

      await queue.shutdown();
    });

    it('should insert a job by worker definition', async () => {
      const worker = defineWorker('MyWorker', async () => WorkerResults.ok(), {
        queue: 'priority',
        maxAttempts: 5,
        priority: 1
      });

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5, priority: 10 }
      });

      queue.register(worker);

      const job = await queue.insert(worker, { args: {} });

      expect(job.worker).toBe('MyWorker');
      expect(job.queue).toBe('priority');
      expect(job.maxAttempts).toBe(5);
      expect(job.priority).toBe(1);

      await queue.shutdown();
    });

    it('should use worker defaults for queue, maxAttempts, priority', async () => {
      const worker = defineWorker('ConfiguredWorker', async () => WorkerResults.ok(), {
        queue: 'emails',
        maxAttempts: 3,
        priority: -5
      });

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5, emails: 2 }
      });

      queue.register(worker);

      const job = await queue.insert('ConfiguredWorker', { args: {} });

      expect(job.queue).toBe('emails');
      expect(job.maxAttempts).toBe(3);
      expect(job.priority).toBe(-5);

      await queue.shutdown();
    });

    it('should override worker defaults with insert options', async () => {
      const worker = defineWorker('ConfiguredWorker', async () => WorkerResults.ok(), {
        queue: 'emails',
        maxAttempts: 3,
        priority: -5
      });

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5, emails: 2, urgent: 1 }
      });

      queue.register(worker);

      const job = await queue.insert('ConfiguredWorker', {
        args: {},
        queue: 'urgent',
        maxAttempts: 10,
        priority: -100
      });

      expect(job.queue).toBe('urgent');
      expect(job.maxAttempts).toBe(10);
      expect(job.priority).toBe(-100);

      await queue.shutdown();
    });
  });

  describe('insertWithResult', () => {
    it('should return job and conflict status', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const result = await queue.insertWithResult('TestWorker', {
        args: { id: 1 }
      });

      expect(result.job).toBeDefined();
      expect(result.conflict).toBe(false);

      await queue.shutdown();
    });

    it('should detect unique constraint conflicts', async () => {
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
  });

  describe('insertAll', () => {
    it('should insert multiple jobs at once', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const jobs = await queue.insertAll('BatchWorker', [
        { args: { id: 1 } },
        { args: { id: 2 } },
        { args: { id: 3 } }
      ]);

      expect(jobs).toHaveLength(3);
      expect(jobs[0].args).toEqual({ id: 1 });
      expect(jobs[1].args).toEqual({ id: 2 });
      expect(jobs[2].args).toEqual({ id: 3 });

      await queue.shutdown();
    });

    it('should handle empty array', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const jobs = await queue.insertAll('BatchWorker', []);

      expect(jobs).toHaveLength(0);

      await queue.shutdown();
    });
  });

  describe('getJob', () => {
    it('should retrieve a job by id', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const inserted = await queue.insert('TestWorker', { args: { test: true } });
      const retrieved = await queue.getJob(inserted.id);

      expect(retrieved).toEqual(inserted);

      await queue.shutdown();
    });

    it('should return null for non-existent job', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const result = await queue.getJob(99999);

      expect(result).toBeNull();

      await queue.shutdown();
    });
  });

  describe('cancelJobs', () => {
    it('should cancel jobs by worker name', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await queue.insert('WorkerA', { args: {} });
      await queue.insert('WorkerA', { args: {} });
      await queue.insert('WorkerB', { args: {} });

      const cancelled = await queue.cancelJobs({ worker: 'WorkerA' });

      expect(cancelled).toBe(2);

      await queue.shutdown();
    });

    it('should cancel jobs by queue name', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5, emails: 2 }
      });

      await queue.insert('Worker', { args: {}, queue: 'default' });
      await queue.insert('Worker', { args: {}, queue: 'emails' });
      await queue.insert('Worker', { args: {}, queue: 'emails' });

      const cancelled = await queue.cancelJobs({ queue: 'emails' });

      expect(cancelled).toBe(2);

      await queue.shutdown();
    });

    it('should cancel jobs by state', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await queue.insert('Worker', { args: {} }); // available
      await queue.insert('Worker', { args: {}, scheduledAt: new Date(Date.now() + 60000) }); // scheduled

      const cancelled = await queue.cancelJobs({ state: ['available'] });

      expect(cancelled).toBe(1);

      await queue.shutdown();
    });
  });

  describe('pruneJobs', () => {
    it('should prune old completed jobs', async () => {
      // Insert a job and mark it completed with old timestamp
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, completed_at)
        VALUES ('completed', 'default', 'OldWorker', '{}', datetime('now', '-10 days'))
      `).run();

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const pruned = await queue.pruneJobs(86400 * 7); // 7 days

      expect(pruned).toBe(1);

      await queue.shutdown();
    });

    it('should not prune recent jobs', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      // Insert and immediately complete a job
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, completed_at)
        VALUES ('completed', 'default', 'RecentWorker', '{}', datetime('now'))
      `).run();

      const pruned = await queue.pruneJobs(86400); // 1 day

      expect(pruned).toBe(0);

      await queue.shutdown();
    });
  });

  describe('rescueStuckJobs', () => {
    it('should rescue jobs stuck in executing state', async () => {
      // Insert a job stuck in executing state
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, attempted_at)
        VALUES ('executing', 'default', 'StuckWorker', '{}', datetime('now', '-10 minutes'))
      `).run();

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const rescued = await queue.rescueStuckJobs(300); // 5 minutes

      expect(rescued).toBe(1);

      // Verify job is now available
      const row = db.prepare('SELECT state FROM izi_jobs WHERE worker = ?').get('StuckWorker') as any;
      expect(row.state).toBe('available');

      await queue.shutdown();
    });
  });

  describe('pauseQueue / resumeQueue', () => {
    it('should pause and resume a queue', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await queue.start();

      expect(queue.getQueueStatus('default')?.state).toBe('running');

      queue.pauseQueue('default');
      expect(queue.getQueueStatus('default')?.state).toBe('paused');

      queue.resumeQueue('default');
      expect(queue.getQueueStatus('default')?.state).toBe('running');

      await queue.shutdown();
    });

    it('should handle pause on non-existent queue gracefully', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await queue.start();

      // Should not throw
      queue.pauseQueue('nonexistent');
      queue.resumeQueue('nonexistent');

      await queue.shutdown();
    });
  });

  describe('scaleQueue', () => {
    it('should scale queue concurrency limit', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await queue.start();

      expect(queue.getQueueStatus('default')?.limit).toBe(5);

      queue.scaleQueue('default', 20);
      expect(queue.getQueueStatus('default')?.limit).toBe(20);

      queue.scaleQueue('default', 1);
      expect(queue.getQueueStatus('default')?.limit).toBe(1);

      await queue.shutdown();
    });
  });

  describe('getQueueStatus / getAllQueueStatus', () => {
    it('should return status for a specific queue', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await queue.start();

      const status = queue.getQueueStatus('default');

      expect(status).toEqual({
        name: 'default',
        state: 'running',
        limit: 5,
        running: 0
      });

      await queue.shutdown();
    });

    it('should return null for non-existent queue', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await queue.start();

      const status = queue.getQueueStatus('nonexistent');

      expect(status).toBeNull();

      await queue.shutdown();
    });

    it('should return status for all queues', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5, priority: 10, slow: 2 }
      });

      await queue.start();

      const statuses = queue.getAllQueueStatus();

      expect(statuses).toHaveLength(3);
      expect(statuses.map(s => s.name).sort()).toEqual(['default', 'priority', 'slow']);

      await queue.shutdown();
    });
  });

  describe('on (telemetry)', () => {
    it('should subscribe to telemetry events', async () => {
      const events: string[] = [];

      const worker = defineWorker('TelemetryWorker', async () => WorkerResults.ok());

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 },
        pollInterval: 50
      });

      const unsubscribe = queue.on('*', (payload) => {
        events.push(payload.event);
      });

      queue.register(worker);
      await queue.start();

      await queue.insert('TelemetryWorker', { args: {} });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(events).toContain('queue:start');

      unsubscribe();

      await queue.shutdown();
    });

    it('should allow unsubscribing from events', async () => {
      const events: string[] = [];

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const unsubscribe = queue.on('queue:start', (payload) => {
        events.push(payload.event);
      });

      await queue.start();

      expect(events).toContain('queue:start');

      unsubscribe();
      events.length = 0;

      await queue.stop();
      await queue.start();

      // After unsubscribe, no new events should be recorded
      // (the queue:start event after restart won't be captured)
      expect(events.filter(e => e === 'queue:start').length).toBe(0);

      await queue.shutdown();
    });
  });

  describe('migrate', () => {
    it('should run migrations through the queue', async () => {
      const freshDb = new Database(':memory:');
      const freshAdapter = createSQLiteAdapter(freshDb);

      const queue = createIziQueue({
        database: freshAdapter,
        queues: { default: 5 }
      });

      await queue.migrate();

      // Verify migrations were applied
      const migrations = freshDb.prepare('SELECT * FROM izi_migrations').all();
      expect(migrations.length).toBeGreaterThan(0);

      await freshAdapter.close();
    });
  });

  describe('scheduled jobs', () => {
    it('should insert job in scheduled state for future dates', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const futureDate = new Date(Date.now() + 60000);

      const job = await queue.insert('ScheduledWorker', {
        args: {},
        scheduledAt: futureDate
      });

      expect(job.state).toBe('scheduled');
      expect(job.scheduledAt.getTime()).toBe(futureDate.getTime());

      await queue.shutdown();
    });

    it('should insert job in available state for past dates', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const pastDate = new Date(Date.now() - 60000);

      const job = await queue.insert('Worker', {
        args: {},
        scheduledAt: pastDate
      });

      expect(job.state).toBe('available');

      await queue.shutdown();
    });
  });

  describe('job metadata and tags', () => {
    it('should store and retrieve job metadata', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const job = await queue.insert('Worker', {
        args: {},
        meta: { source: 'api', requestId: 'abc123' }
      });

      expect(job.meta).toEqual({ source: 'api', requestId: 'abc123' });

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.meta).toEqual({ source: 'api', requestId: 'abc123' });

      await queue.shutdown();
    });

    it('should store and retrieve job tags', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const job = await queue.insert('Worker', {
        args: {},
        tags: ['urgent', 'customer-support']
      });

      expect(job.tags).toEqual(['urgent', 'customer-support']);

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.tags).toEqual(['urgent', 'customer-support']);

      await queue.shutdown();
    });
  });
});
