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
import { waitForEvent } from './helpers/wait.js';
import type { DatabaseAdapter, Job, Logger } from '../src/types.js';

/**
 * A class instance's methods live on its prototype, not as own properties, so
 * `{ ...adapter, listJobs: undefined }` would silently drop every other
 * method too. This proxy keeps every method delegating to `adapter` except
 * the one under test, which is what actually simulates "an adapter that
 * doesn't implement this optional method".
 */
function adapterWithout(adapter: DatabaseAdapter, methodName: 'listJobs' | 'countJobs'): DatabaseAdapter {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === methodName) return undefined;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

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

    it('preserves input order across a mix of queues', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5, priority: 5 }
      });

      const jobs = await queue.insertAll('BatchWorker', [
        { args: { id: 1 }, queue: 'priority' },
        { args: { id: 2 } },
        { args: { id: 3 }, queue: 'priority' }
      ]);

      expect(jobs.map(j => j.args)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(jobs.map(j => j.queue)).toEqual(['priority', 'default', 'priority']);

      await queue.shutdown();
    });

    it('collapses duplicate unique jobs within the batch before hitting the database', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const results = await queue.insertAllWithResult('BatchWorker', [
        { args: { userId: 1 }, unique: { period: 60 } },
        { args: { userId: 1 }, unique: { period: 60 } },
        { args: { userId: 2 }, unique: { period: 60 } }
      ]);

      expect(results[0].conflict).toBe(false);
      expect(results[1].conflict).toBe(true);
      expect(results[1].job.id).toBe(results[0].job.id);
      expect(results[2].conflict).toBe(false);
      expect(results[2].job.id).not.toBe(results[0].job.id);

      const count = (db.prepare('SELECT COUNT(*) AS c FROM izi_jobs').get() as { c: number }).c;
      expect(count).toBe(2);

      await queue.shutdown();
    });

    it('reports a conflict with a pre-existing job the same way a single insert does', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const existing = await queue.insert('BatchWorker', {
        args: { userId: 1 },
        unique: { period: 60 }
      });

      const results = await queue.insertAllWithResult('BatchWorker', [
        { args: { userId: 99 } },
        { args: { userId: 1 }, unique: { period: 60 } }
      ]);

      expect(results[0].conflict).toBe(false);
      expect(results[1].conflict).toBe(true);
      expect(results[1].job.id).toBe(existing.id);

      const count = (db.prepare('SELECT COUNT(*) AS c FROM izi_jobs').get() as { c: number }).c;
      expect(count).toBe(2);

      await queue.shutdown();
    });

    it('rolls back the whole batch when one row fails', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await expect(
        queue.insertAll('BatchWorker', [
          { args: { id: 1 } },
          // A unique job breaks the otherwise-contiguous run of plain jobs
          // into separate statements, so the batch spans more than one SQL
          // statement inside its transaction rather than failing atomically
          // as a single multi-row INSERT.
          { args: { id: 2 }, unique: { period: 60 } },
          // A BigInt cannot be JSON.stringify'd, so this throws while
          // building the third statement -- after the first two have already
          // been written inside the (uncommitted) transaction.
          { args: { bad: 10n } }
        ])
      ).rejects.toThrow();

      const count = (db.prepare('SELECT COUNT(*) AS c FROM izi_jobs').get() as { c: number }).c;
      expect(count).toBe(0);

      await queue.shutdown();
    });

    it('sends at most one wake-up notification per queue in the batch', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5, priority: 5 }
      });
      await queue.start();

      const notify = jest.fn(async (_queue: string, _tx?: unknown) => {});
      // SQLiteAdapter has no built-in notify (it relies on polling); attach a
      // stub since `notify` is an optional part of the adapter interface, and
      // this is the only way to count wake-ups precisely.
      (adapter as unknown as { notify: typeof notify }).notify = notify;

      await queue.insertAll('BatchWorker', [
        { args: { id: 1 } },
        { args: { id: 2 }, queue: 'priority' },
        { args: { id: 3 } },
        { args: { id: 4 }, queue: 'priority' }
      ]);

      expect(notify).toHaveBeenCalledTimes(2);
      expect(notify.mock.calls.map(call => call[0]).sort()).toEqual(['default', 'priority']);

      await queue.shutdown();
    });

    it('does not wake a queue whose only batch entries were conflicts', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });
      await queue.start();

      await queue.insert('BatchWorker', { args: { userId: 1 }, unique: { period: 60 } });

      const notify = jest.fn(async (_queue: string, _tx?: unknown) => {});
      (adapter as unknown as { notify: typeof notify }).notify = notify;

      await queue.insertAll('BatchWorker', [
        { args: { userId: 1 }, unique: { period: 60 } }
      ]);

      expect(notify).not.toHaveBeenCalled();

      await queue.shutdown();
    });

    it('rejects a batch whose entries disagree on which transaction to use', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const otherDb = new (await import('better-sqlite3')).default(':memory:');
      try {
        await expect(
          queue.insertAll('BatchWorker', [
            { args: { id: 1 }, tx: db },
            { args: { id: 2 }, tx: otherDb }
          ])
        ).rejects.toThrow(/same transaction handle/i);
      } finally {
        otherDb.close();
      }

      await queue.shutdown();
    });

    it('rejects a batch where only some entries carry a transaction', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await expect(
        queue.insertAll('BatchWorker', [
          { args: { id: 1 }, tx: db },
          { args: { id: 2 } }
        ])
      ).rejects.toThrow(/same transaction handle/i);

      await queue.shutdown();
    });

    it('rolls back with the caller-supplied transaction', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      db.exec('BEGIN');
      try {
        await queue.insertAll('BatchWorker', [
          { args: { id: 1 }, tx: db },
          { args: { id: 2 }, tx: db }
        ]);
        throw new Error('business logic failed');
      } catch {
        db.exec('ROLLBACK');
      }

      const count = (db.prepare('SELECT COUNT(*) AS c FROM izi_jobs').get() as { c: number }).c;
      expect(count).toBe(0);

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

  describe('listJobs', () => {
    it('delegates to the adapter and returns matching jobs', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await queue.insert('WorkerA', { args: {} });
      await queue.insert('WorkerB', { args: {} });

      const jobs = await queue.listJobs({ worker: 'WorkerA' });

      expect(jobs).toHaveLength(1);
      expect(jobs[0].worker).toBe('WorkerA');

      await queue.shutdown();
    });

    it('does not require scoping -- unlike cancelJobs/retryJobs it is read-only', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await queue.insert('Worker', { args: {} });

      await expect(queue.listJobs({})).resolves.toHaveLength(1);

      await queue.shutdown();
    });

    it('throws a clear error when the adapter does not implement listJobs', async () => {
      const queue = createIziQueue({
        database: adapterWithout(adapter, 'listJobs'),
        queues: { default: 5 }
      });

      await expect(queue.listJobs({})).rejects.toThrow(/does not support listJobs/);

      await queue.shutdown();
    });
  });

  describe('countJobs', () => {
    it('delegates to the adapter and returns counts grouped by state', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await queue.insert('Worker', { args: {} });

      const counts = await queue.countJobs({});

      expect(counts.available).toBe(1);
      expect(counts.completed).toBe(0);

      await queue.shutdown();
    });

    it('throws a clear error when the adapter does not implement countJobs', async () => {
      const queue = createIziQueue({
        database: adapterWithout(adapter, 'countJobs'),
        queues: { default: 5 }
      });

      await expect(queue.countJobs({})).rejects.toThrow(/does not support countJobs/);

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

    it('accepts tags alone as a valid scope, without needing { all: true }', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await queue.insert('Worker', { args: {}, tags: ['billing'] });
      await queue.insert('Worker', { args: {}, tags: ['other'] });

      const cancelled = await queue.cancelJobs({ tags: ['billing'] });

      expect(cancelled).toBe(1);

      await queue.shutdown();
    });

    it('still rejects a completely unscoped call', async () => {
      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      await expect(queue.cancelJobs({})).rejects.toThrow(/requires at least one criterion/);

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

    it('prunes across multiple batches when the backlog exceeds batchSize', async () => {
      // 2.5x the batch size: a single pruneJobs call must run three batches
      // (5 + 5 + 2) internally rather than leaving most of the backlog behind.
      for (let i = 0; i < 12; i++) {
        db.prepare(`
          INSERT INTO izi_jobs (state, queue, worker, args, completed_at)
          VALUES ('completed', 'default', 'OldWorker', '{}', datetime('now', '-10 days'))
        `).run();
      }
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args)
        VALUES ('available', 'default', 'KeepWorker', '{}')
      `).run();

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 }
      });

      const pruned = await queue.pruneJobs(86400 * 7, 5);

      expect(pruned).toBe(12);
      const remaining = db.prepare('SELECT state FROM izi_jobs').all() as { state: string }[];
      expect(remaining).toEqual([{ state: 'available' }]);

      await queue.shutdown();
    });
  });

  describe('stageJobs batching (internal)', () => {
    it('stages the whole backlog across multiple batches when it exceeds stageBatchSize', async () => {
      // 2.5x the batch size: one stage cycle must run three batches (5 + 5 + 2)
      // internally rather than leaving most of the backlog behind.
      for (let i = 0; i < 12; i++) {
        db.prepare(`
          INSERT INTO izi_jobs (state, queue, worker, args, scheduled_at)
          VALUES ('scheduled', 'default', 'DueWorker', '{}', datetime('now', '-1 minute'))
        `).run();
      }
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, scheduled_at)
        VALUES ('scheduled', 'default', 'FutureWorker', '{}', datetime('now', '+1 hour'))
      `).run();

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 5 },
        stageBatchSize: 5
      });

      // Exercises the queue's own batching loop directly, without starting
      // its poll/dispatch machinery, which would otherwise race staged jobs
      // out of the 'available' state before this can observe them.
      await (queue as unknown as { stageJobs(): Promise<void> }).stageJobs();

      const states = (db.prepare('SELECT state FROM izi_jobs').all() as { state: string }[]).map(
        r => r.state
      );
      expect(states.filter(s => s === 'available')).toHaveLength(12);
      expect(states.filter(s => s === 'scheduled')).toHaveLength(1);

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
        running: 0,
        // Single node, so it is always the leader.
        isLeader: true
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

  describe('logging', () => {
    function createMockLogger(): Logger & {
      debug: jest.Mock;
      info: jest.Mock;
      warn: jest.Mock;
      error: jest.Mock;
    } {
      return {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      };
    }

    it('routes a staging failure through the injected logger and emits queue:stage_error, instead of only console.error', async () => {
      const logger = createMockLogger();
      const boom = new Error('staging exploded');
      const stageSpy = jest.spyOn(adapter, 'stageJobs').mockRejectedValueOnce(boom);

      const queue = createIziQueue({ database: adapter, queues: { default: 5 }, logger });

      const eventPromise = waitForEvent('queue:stage_error');
      await queue.drain();
      const payload = await eventPromise;

      expect(payload.error).toBe(boom);
      expect(logger.error).toHaveBeenCalledWith('Error staging jobs', expect.objectContaining({ error: boom }));

      stageSpy.mockRestore();
    });

    it('defaults to consoleLogger for a staging failure when no logger is supplied', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const boom = new Error('staging exploded');
      const stageSpy = jest.spyOn(adapter, 'stageJobs').mockRejectedValueOnce(boom);

      const queue = createIziQueue({ database: adapter, queues: { default: 5 } });

      const eventPromise = waitForEvent('queue:stage_error');
      await queue.drain();
      await eventPromise;

      expect(errorSpy).toHaveBeenCalledWith('[izi-queue] Error staging jobs', { error: boom });

      stageSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('routes a heartbeat failure through the injected logger instead of only console.error', async () => {
      const logger = createMockLogger();
      const boom = new Error('heartbeat exploded');
      const heartbeatSpy = jest.spyOn(adapter, 'heartbeat').mockRejectedValueOnce(boom);

      const queue = createIziQueue({ database: adapter, queues: { default: 5 }, logger });
      await queue.start();

      expect(logger.error).toHaveBeenCalledWith(
        'Error recording node heartbeat',
        expect.objectContaining({ error: boom })
      );

      heartbeatSpy.mockRestore();
      await queue.shutdown();
    });
  });
});
