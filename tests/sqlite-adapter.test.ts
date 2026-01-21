import Database from 'better-sqlite3';
import { createSQLiteAdapter } from '../src/database/sqlite.js';
import type { Job, JobState } from '../src/types.js';

describe('SQLiteAdapter', () => {
  let db: Database.Database;
  let adapter: ReturnType<typeof createSQLiteAdapter>;

  beforeEach(async () => {
    db = new Database(':memory:');
    adapter = createSQLiteAdapter(db);
    await adapter.migrate();
  });

  afterEach(async () => {
    await adapter.close();
  });

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

  describe('migrate', () => {
    it('should create required tables', async () => {
      // Check izi_jobs table exists
      const jobsTable = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='izi_jobs'
      `).get();
      expect(jobsTable).toBeDefined();

      // Check izi_migrations table exists
      const migrationsTable = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='izi_migrations'
      `).get();
      expect(migrationsTable).toBeDefined();
    });

    it('should be idempotent', async () => {
      await adapter.migrate();
      await adapter.migrate();
      await adapter.migrate();

      const migrations = db.prepare('SELECT * FROM izi_migrations').all();
      const uniqueVersions = new Set((migrations as any[]).map(m => m.version));
      expect(uniqueVersions.size).toBe(migrations.length);
    });

    it('should track applied migrations', async () => {
      const migrations = db.prepare('SELECT * FROM izi_migrations ORDER BY version').all() as any[];

      expect(migrations.length).toBeGreaterThan(0);
      expect(migrations[0].version).toBe(1);
    });
  });

  describe('getMigrationStatus', () => {
    it('should return status of all migrations', async () => {
      const status = await adapter.getMigrationStatus();

      expect(status.length).toBeGreaterThan(0);
      expect(status.every(m => m.applied)).toBe(true);
      expect(status[0]).toHaveProperty('version');
      expect(status[0]).toHaveProperty('name');
      expect(status[0]).toHaveProperty('applied');
    });
  });

  describe('rollback', () => {
    it('should rollback to a specific version', async () => {
      const statusBefore = await adapter.getMigrationStatus();
      const appliedBefore = statusBefore.filter(m => m.applied).length;

      // Rollback to version 2
      await adapter.rollback(2);

      const statusAfter = await adapter.getMigrationStatus();
      const appliedAfter = statusAfter.filter(m => m.applied).length;

      expect(appliedAfter).toBeLessThan(appliedBefore);
    });
  });

  describe('insertJob', () => {
    it('should insert a job and return it with id', async () => {
      const jobData = createJobData({ args: { test: true } });
      const job = await adapter.insertJob(jobData);

      expect(job.id).toBeDefined();
      expect(typeof job.id).toBe('number');
      expect(job.worker).toBe('TestWorker');
      expect(job.args).toEqual({ test: true });
      expect(job.insertedAt).toBeDefined();
    });

    it('should store all job properties', async () => {
      const jobData = createJobData({
        queue: 'priority',
        worker: 'MyWorker',
        args: { userId: 123, action: 'notify' },
        meta: { source: 'api' },
        tags: ['urgent', 'notification'],
        priority: -5,
        maxAttempts: 3
      });

      const job = await adapter.insertJob(jobData);

      expect(job.queue).toBe('priority');
      expect(job.worker).toBe('MyWorker');
      expect(job.args).toEqual({ userId: 123, action: 'notify' });
      expect(job.meta).toEqual({ source: 'api' });
      expect(job.tags).toEqual(['urgent', 'notification']);
      expect(job.priority).toBe(-5);
      expect(job.maxAttempts).toBe(3);
    });

    it('should handle complex nested args', async () => {
      const complexArgs = {
        user: { id: 1, name: 'Test' },
        items: [1, 2, 3],
        config: { nested: { deep: true } }
      };

      const jobData = createJobData({ args: complexArgs });
      const job = await adapter.insertJob(jobData);

      expect(job.args).toEqual(complexArgs);
    });
  });

  describe('getJob', () => {
    it('should retrieve a job by id', async () => {
      const jobData = createJobData({ args: { id: 'test-123' } });
      const inserted = await adapter.insertJob(jobData);

      const retrieved = await adapter.getJob(inserted.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(inserted.id);
      expect(retrieved?.args).toEqual({ id: 'test-123' });
    });

    it('should return null for non-existent job', async () => {
      const result = await adapter.getJob(99999);
      expect(result).toBeNull();
    });

    it('should correctly parse dates', async () => {
      const scheduledAt = new Date();
      const jobData = createJobData({ scheduledAt });
      const inserted = await adapter.insertJob(jobData);

      const retrieved = await adapter.getJob(inserted.id);

      expect(retrieved?.scheduledAt).toBeInstanceOf(Date);
      expect(retrieved?.insertedAt).toBeInstanceOf(Date);
    });
  });

  describe('fetchJobs', () => {
    it('should fetch available jobs from queue', async () => {
      await adapter.insertJob(createJobData({ queue: 'default' }));
      await adapter.insertJob(createJobData({ queue: 'default' }));
      await adapter.insertJob(createJobData({ queue: 'other' }));

      const jobs = await adapter.fetchJobs('default', 10);

      expect(jobs).toHaveLength(2);
      expect(jobs.every(j => j.queue === 'default')).toBe(true);
    });

    it('should update state to executing', async () => {
      const inserted = await adapter.insertJob(createJobData());
      expect(inserted.state).toBe('available');

      const fetched = await adapter.fetchJobs('default', 1);

      expect(fetched).toHaveLength(1);
      expect(fetched[0].state).toBe('executing');
    });

    it('should increment attempt count', async () => {
      const inserted = await adapter.insertJob(createJobData({ attempt: 0 }));

      const fetched = await adapter.fetchJobs('default', 1);

      expect(fetched[0].attempt).toBe(1);
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        await adapter.insertJob(createJobData());
      }

      const jobs = await adapter.fetchJobs('default', 3);

      expect(jobs).toHaveLength(3);
    });

    it('should order by priority then scheduled_at then id', async () => {
      const now = new Date();

      // Insert in random order
      await adapter.insertJob(createJobData({ priority: 5, args: { order: 3 } }));
      await adapter.insertJob(createJobData({ priority: -5, args: { order: 1 } }));
      await adapter.insertJob(createJobData({ priority: 0, args: { order: 2 } }));

      const jobs = await adapter.fetchJobs('default', 3);

      // Should be ordered by priority ASC
      expect((jobs[0].args as any).order).toBe(1);
      expect((jobs[1].args as any).order).toBe(2);
      expect((jobs[2].args as any).order).toBe(3);
    });

    it('should only fetch available jobs', async () => {
      await adapter.insertJob(createJobData({ state: 'available' }));
      await adapter.insertJob(createJobData({ state: 'scheduled' }));
      await adapter.insertJob(createJobData({ state: 'completed' }));

      const jobs = await adapter.fetchJobs('default', 10);

      expect(jobs).toHaveLength(1);
      expect(jobs[0].state).toBe('executing'); // Changed from available
    });

    it('should return empty array when no jobs available', async () => {
      const jobs = await adapter.fetchJobs('default', 10);
      expect(jobs).toEqual([]);
    });
  });

  describe('updateJob', () => {
    it('should update job state', async () => {
      const inserted = await adapter.insertJob(createJobData());

      const updated = await adapter.updateJob(inserted.id, { state: 'completed' });

      expect(updated?.state).toBe('completed');
    });

    it('should update completedAt', async () => {
      const inserted = await adapter.insertJob(createJobData());
      const completedAt = new Date();

      const updated = await adapter.updateJob(inserted.id, {
        state: 'completed',
        completedAt
      });

      expect(updated?.completedAt).toBeDefined();
    });

    it('should update errors array', async () => {
      const inserted = await adapter.insertJob(createJobData());

      const errors = [
        { at: new Date(), attempt: 1, error: 'Error 1' }
      ];

      const updated = await adapter.updateJob(inserted.id, { errors });

      expect(updated?.errors).toHaveLength(1);
      expect(updated?.errors[0].error).toBe('Error 1');
    });

    it('should update meta object', async () => {
      const inserted = await adapter.insertJob(createJobData({ meta: {} }));

      const updated = await adapter.updateJob(inserted.id, {
        meta: { processed: true, retryCount: 3 }
      });

      expect(updated?.meta).toEqual({ processed: true, retryCount: 3 });
    });

    it('should return null for non-existent job', async () => {
      const result = await adapter.updateJob(99999, { state: 'completed' });
      expect(result).toBeNull();
    });

    it('should only update provided fields', async () => {
      const inserted = await adapter.insertJob(createJobData({
        meta: { original: true },
        priority: 5
      }));

      const updated = await adapter.updateJob(inserted.id, { state: 'completed' });

      expect(updated?.state).toBe('completed');
      expect(updated?.meta).toEqual({ original: true });
      expect(updated?.priority).toBe(5);
    });
  });

  describe('pruneJobs', () => {
    it('should delete old completed jobs', async () => {
      // Insert a job and mark it completed with old timestamp
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, completed_at)
        VALUES ('completed', 'default', 'OldWorker', '{}', datetime('now', '-10 days'))
      `).run();

      const pruned = await adapter.pruneJobs(86400 * 7); // 7 days

      expect(pruned).toBe(1);
    });

    it('should delete old discarded jobs', async () => {
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, discarded_at)
        VALUES ('discarded', 'default', 'OldWorker', '{}', datetime('now', '-10 days'))
      `).run();

      const pruned = await adapter.pruneJobs(86400 * 7);
      expect(pruned).toBe(1);
    });

    it('should delete old cancelled jobs', async () => {
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, cancelled_at)
        VALUES ('cancelled', 'default', 'OldWorker', '{}', datetime('now', '-10 days'))
      `).run();

      const pruned = await adapter.pruneJobs(86400 * 7);
      expect(pruned).toBe(1);
    });

    it('should not delete recent jobs', async () => {
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, completed_at)
        VALUES ('completed', 'default', 'RecentWorker', '{}', datetime('now'))
      `).run();

      const pruned = await adapter.pruneJobs(86400); // 1 day
      expect(pruned).toBe(0);
    });

    it('should not delete non-terminal jobs', async () => {
      await adapter.insertJob(createJobData({ state: 'available' }));
      await adapter.insertJob(createJobData({ state: 'executing' }));

      const pruned = await adapter.pruneJobs(0); // Would delete everything if terminal
      expect(pruned).toBe(0);
    });
  });

  describe('stageJobs', () => {
    it('should move scheduled jobs to available when due', async () => {
      // Insert a scheduled job with past scheduledAt
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, scheduled_at)
        VALUES ('scheduled', 'default', 'ScheduledWorker', '{}', datetime('now', '-1 minute'))
      `).run();

      const staged = await adapter.stageJobs();

      expect(staged).toBe(1);

      const job = db.prepare('SELECT state FROM izi_jobs WHERE worker = ?').get('ScheduledWorker') as any;
      expect(job.state).toBe('available');
    });

    it('should not stage future scheduled jobs', async () => {
      // Insert a scheduled job with future scheduledAt
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, scheduled_at)
        VALUES ('scheduled', 'default', 'FutureWorker', '{}', datetime('now', '+1 hour'))
      `).run();

      const staged = await adapter.stageJobs();

      expect(staged).toBe(0);

      const job = db.prepare('SELECT state FROM izi_jobs WHERE worker = ?').get('FutureWorker') as any;
      expect(job.state).toBe('scheduled');
    });

    it('should stage retryable jobs when due', async () => {
      // Insert a retryable job that is due to be processed
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, scheduled_at)
        VALUES ('scheduled', 'default', 'RetryableWorker', '{}', datetime('now', '-1 second'))
      `).run();

      const staged = await adapter.stageJobs();
      expect(staged).toBe(1);
    });
  });

  describe('cancelJobs', () => {
    it('should cancel jobs by queue', async () => {
      await adapter.insertJob(createJobData({ queue: 'default' }));
      await adapter.insertJob(createJobData({ queue: 'default' }));
      await adapter.insertJob(createJobData({ queue: 'other' }));

      const cancelled = await adapter.cancelJobs({ queue: 'default' });

      expect(cancelled).toBe(2);
    });

    it('should cancel jobs by worker', async () => {
      await adapter.insertJob(createJobData({ worker: 'WorkerA' }));
      await adapter.insertJob(createJobData({ worker: 'WorkerA' }));
      await adapter.insertJob(createJobData({ worker: 'WorkerB' }));

      const cancelled = await adapter.cancelJobs({ worker: 'WorkerA' });

      expect(cancelled).toBe(2);
    });

    it('should cancel jobs by state', async () => {
      await adapter.insertJob(createJobData({ state: 'available' }));
      await adapter.insertJob(createJobData({ state: 'scheduled' }));

      const cancelled = await adapter.cancelJobs({ state: ['available'] });

      expect(cancelled).toBe(1);
    });

    it('should not cancel already terminal jobs', async () => {
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, completed_at)
        VALUES ('completed', 'default', 'DoneWorker', '{}', datetime('now'))
      `).run();

      const cancelled = await adapter.cancelJobs({ worker: 'DoneWorker' });

      expect(cancelled).toBe(0);
    });

    it('should set cancelledAt timestamp', async () => {
      const inserted = await adapter.insertJob(createJobData());

      await adapter.cancelJobs({ worker: 'TestWorker' });

      const job = await adapter.getJob(inserted.id);
      expect(job?.state).toBe('cancelled');
      expect(job?.cancelledAt).toBeDefined();
    });
  });

  describe('rescueStuckJobs', () => {
    it('should rescue jobs stuck in executing state', async () => {
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, attempted_at)
        VALUES ('executing', 'default', 'StuckWorker', '{}', datetime('now', '-10 minutes'))
      `).run();

      const rescued = await adapter.rescueStuckJobs(300); // 5 minutes

      expect(rescued).toBe(1);

      const job = db.prepare('SELECT state FROM izi_jobs WHERE worker = ?').get('StuckWorker') as any;
      expect(job.state).toBe('available');
    });

    it('should not rescue recently executing jobs', async () => {
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, attempted_at)
        VALUES ('executing', 'default', 'ActiveWorker', '{}', datetime('now', '-1 minute'))
      `).run();

      const rescued = await adapter.rescueStuckJobs(300); // 5 minutes

      expect(rescued).toBe(0);
    });
  });

  describe('checkUnique', () => {
    it('should find existing job with same args', async () => {
      const inserted = await adapter.insertJob(createJobData({
        worker: 'UniqueWorker',
        args: { userId: 123 }
      }));

      const jobData = createJobData({
        worker: 'UniqueWorker',
        args: { userId: 123 }
      });

      const existing = await adapter.checkUnique({ period: 60 }, jobData);

      expect(existing).not.toBeNull();
      expect(existing?.id).toBe(inserted.id);
    });

    it('should not find job with different args', async () => {
      await adapter.insertJob(createJobData({
        worker: 'UniqueWorker',
        args: { userId: 123 }
      }));

      const jobData = createJobData({
        worker: 'UniqueWorker',
        args: { userId: 456 }
      });

      const existing = await adapter.checkUnique({ period: 60 }, jobData);

      expect(existing).toBeNull();
    });

    it('should check only specified keys', async () => {
      await adapter.insertJob(createJobData({
        worker: 'UniqueWorker',
        args: { userId: 123, timestamp: 1000 }
      }));

      const jobData = createJobData({
        worker: 'UniqueWorker',
        args: { userId: 123, timestamp: 2000 }
      });

      const existing = await adapter.checkUnique(
        { period: 60, keys: ['userId'] },
        jobData
      );

      expect(existing).not.toBeNull();
    });

    it('should respect period constraint', async () => {
      // Insert a job 10 minutes ago
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, inserted_at)
        VALUES ('available', 'default', 'UniqueWorker', '{"userId":123}', datetime('now', '-10 minutes'))
      `).run();

      const jobData = createJobData({
        worker: 'UniqueWorker',
        args: { userId: 123 }
      });

      // Check with 5 minute period - should not find
      const existing5min = await adapter.checkUnique({ period: 300 }, jobData);
      expect(existing5min).toBeNull();

      // Check with 15 minute period - should find
      const existing15min = await adapter.checkUnique({ period: 900 }, jobData);
      expect(existing15min).not.toBeNull();
    });

    it('should check specified states', async () => {
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args)
        VALUES ('completed', 'default', 'UniqueWorker', '{"userId":123}')
      `).run();

      const jobData = createJobData({
        worker: 'UniqueWorker',
        args: { userId: 123 }
      });

      // Default states don't include completed
      const existingDefault = await adapter.checkUnique({ period: 60 }, jobData);
      expect(existingDefault).toBeNull();

      // Explicitly include completed
      const existingWithCompleted = await adapter.checkUnique(
        { period: 60, states: ['completed'] },
        jobData
      );
      expect(existingWithCompleted).not.toBeNull();
    });

    it('should handle infinity period', async () => {
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, inserted_at)
        VALUES ('available', 'default', 'UniqueWorker', '{"userId":123}', datetime('now', '-365 days'))
      `).run();

      const jobData = createJobData({
        worker: 'UniqueWorker',
        args: { userId: 123 }
      });

      const existing = await adapter.checkUnique({ period: 'infinity' }, jobData);
      expect(existing).not.toBeNull();
    });
  });

  describe('close', () => {
    it('should close the database connection', async () => {
      await adapter.close();

      expect(() => {
        db.prepare('SELECT 1').get();
      }).toThrow();
    });
  });

  describe('edge cases', () => {
    it('should handle empty args', async () => {
      const job = await adapter.insertJob(createJobData({ args: {} }));
      const retrieved = await adapter.getJob(job.id);
      expect(retrieved?.args).toEqual({});
    });

    it('should handle null values in nullable fields', async () => {
      const job = await adapter.insertJob(createJobData({
        attemptedAt: null,
        completedAt: null,
        discardedAt: null,
        cancelledAt: null
      }));

      const retrieved = await adapter.getJob(job.id);
      expect(retrieved?.attemptedAt).toBeNull();
      expect(retrieved?.completedAt).toBeNull();
      expect(retrieved?.discardedAt).toBeNull();
      expect(retrieved?.cancelledAt).toBeNull();
    });

    it('should handle special characters in args', async () => {
      const specialArgs = {
        message: 'Hello "World"',
        path: '/path/to/file',
        emoji: '🎉',
        unicode: 'café'
      };

      const job = await adapter.insertJob(createJobData({ args: specialArgs }));
      const retrieved = await adapter.getJob(job.id);
      expect(retrieved?.args).toEqual(specialArgs);
    });

    it('should handle large args payload', async () => {
      const largeArgs = {
        data: 'x'.repeat(10000),
        array: Array(100).fill({ key: 'value' })
      };

      const job = await adapter.insertJob(createJobData({ args: largeArgs }));
      const retrieved = await adapter.getJob(job.id);
      expect(retrieved?.args).toEqual(largeArgs);
    });
  });
});
