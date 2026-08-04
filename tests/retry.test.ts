import Database from 'better-sqlite3';
import { IziQueue } from '../src/core/izi-queue.js';
import { defineWorker, WorkerResults, clearWorkers } from '../src/core/worker.js';
import { createSQLiteAdapter, SQLiteAdapter } from '../src/database/sqlite.js';
import { waitFor } from './helpers/wait.js';

describe('retry lifecycle', () => {
  let db: Database.Database;
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    db = new Database(':memory:');
    adapter = createSQLiteAdapter(db);
    await adapter.migrate();
    clearWorkers();
  });

  afterEach(async () => {
    await adapter.close();
  });

  describe('stageJobs', () => {
    it('promotes a due retryable job to available', async () => {
      db.prepare(
        `INSERT INTO izi_jobs (state, queue, worker, args, scheduled_at)
         VALUES ('retryable', 'default', 'RetryWorker', '{}', datetime('now', '-1 second'))`
      ).run();

      const staged = await adapter.stageJobs();

      expect(staged).toBe(1);
      const job = db
        .prepare('SELECT state FROM izi_jobs WHERE worker = ?')
        .get('RetryWorker') as { state: string };
      expect(job.state).toBe('available');
    });

    it('leaves a retryable job alone until its backoff has elapsed', async () => {
      db.prepare(
        `INSERT INTO izi_jobs (state, queue, worker, args, scheduled_at)
         VALUES ('retryable', 'default', 'FutureRetryWorker', '{}', datetime('now', '+1 hour'))`
      ).run();

      const staged = await adapter.stageJobs();

      expect(staged).toBe(0);
      const job = db
        .prepare('SELECT state FROM izi_jobs WHERE worker = ?')
        .get('FutureRetryWorker') as { state: string };
      expect(job.state).toBe('retryable');
    });
  });

  describe('end to end', () => {
    it('re-executes a failed job after its backoff elapses', async () => {
      let attempts = 0;
      const flaky = defineWorker(
        'flaky',
        async () => {
          attempts++;
          if (attempts < 2) return WorkerResults.error(new Error('transient failure'));
          return WorkerResults.ok();
        },
        { backoff: () => 200 }
      );

      const queue = new IziQueue({
        database: adapter,
        queues: { default: 5 },
        stageInterval: 100,
        pollInterval: 100,
      });
      queue.register(flaky);
      await queue.start();

      const job = await queue.insert('flaky', { args: { x: 1 } });

      const final = await waitFor(
        async () => {
          const current = await queue.getJob(job.id);
          return current?.state === 'completed' ? current : null;
        },
        { describe: 'the job to complete after retrying' }
      );
      await queue.stop();

      expect(attempts).toBe(2);
      expect(final?.state).toBe('completed');
      expect(final?.attempt).toBe(2);
    }, 15000);

    it('discards a job once its attempts are exhausted', async () => {
      let attempts = 0;
      const alwaysFails = defineWorker(
        'always_fails',
        async () => {
          attempts++;
          return WorkerResults.error(new Error('permanent failure'));
        },
        { backoff: () => 100, maxAttempts: 3 }
      );

      const queue = new IziQueue({
        database: adapter,
        queues: { default: 5 },
        stageInterval: 100,
        pollInterval: 100,
      });
      queue.register(alwaysFails);
      await queue.start();

      const job = await queue.insert('always_fails', { args: {}, maxAttempts: 3 });

      const final = await waitFor(
        async () => {
          const current = await queue.getJob(job.id);
          return current?.state === 'discarded' ? current : null;
        },
        { describe: 'the job to be discarded once attempts run out' }
      );
      await queue.stop();

      expect(attempts).toBe(3);
      expect(final?.state).toBe('discarded');
      expect(final?.errors).toHaveLength(3);
    }, 15000);
  });
});
