import Database from 'better-sqlite3';
import { IziQueue } from '../src/core/izi-queue.js';
import { defineWorker, WorkerResults, clearWorkers } from '../src/core/worker.js';
import { createSQLiteAdapter, SQLiteAdapter } from '../src/database/sqlite.js';
import { telemetry } from '../src/core/telemetry.js';
import type { Job, TelemetryEvent } from '../src/types.js';

describe('job lifecycle', () => {
  let db: Database.Database;
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    db = new Database(':memory:');
    adapter = createSQLiteAdapter(db);
    await adapter.migrate();
    clearWorkers();
    telemetry.off();
  });

  afterEach(async () => {
    telemetry.off();
    await adapter.close();
  });

  function queueWith(...workers: Parameters<IziQueue['register']>[0][]): IziQueue {
    const queue = new IziQueue({
      database: adapter,
      queues: { default: 5 },
      stageInterval: 50,
      pollInterval: 50,
    });
    workers.forEach((w) => queue.register(w));
    return queue;
  }

  function events(): TelemetryEvent[] {
    const seen: TelemetryEvent[] = [];
    telemetry.on('*', ({ event }) => seen.push(event));
    return seen;
  }

  describe('snooze', () => {
    it('does not consume a retry attempt', async () => {
      let calls = 0;
      const queue = queueWith(
        defineWorker('snoozer', async () => {
          calls++;
          if (calls <= 3) return WorkerResults.snooze(0);
          return WorkerResults.ok();
        })
      );

      await queue.start();
      const job = await queue.insert('snoozer', { args: {}, maxAttempts: 2 });
      await new Promise((r) => setTimeout(r, 1500));
      const final = await queue.getJob(job.id);
      await queue.stop();

      // Snoozing three times with maxAttempts: 2 must not exhaust the job.
      expect(calls).toBe(4);
      expect(final?.state).toBe('completed');
    }, 20000);

    it('leaves the effective retry budget intact after snoozing', async () => {
      const queue = queueWith(
        defineWorker('snooze_once', async () => WorkerResults.snooze(60))
      );

      await queue.start();
      const job = await queue.insert('snooze_once', { args: {}, maxAttempts: 5 });
      await new Promise((r) => setTimeout(r, 400));
      const snoozed = await queue.getJob(job.id);
      await queue.stop();

      expect(snoozed?.state).toBe('scheduled');
      // One attempt was consumed by the fetch, so the budget is raised to
      // compensate: the job still has its original five real attempts.
      expect(snoozed!.maxAttempts - snoozed!.attempt).toBe(5);
    }, 20000);
  });

  describe('unknown workers', () => {
    it('discards the job immediately instead of retrying it', async () => {
      const queue = queueWith();
      const seen = events();

      await queue.start();
      const job = await queue.insert('NeverRegistered', { args: {} });
      await new Promise((r) => setTimeout(r, 400));
      const final = await queue.getJob(job.id);
      await queue.stop();

      expect(final?.state).toBe('discarded');
      expect(final?.errors).toHaveLength(1);
      expect(final?.errors[0].error).toContain('NeverRegistered');
      expect(seen).toContain('job:unknown_worker');
    }, 20000);
  });

  describe('state transitions', () => {
    it('does not let a finishing worker resurrect a cancelled job', async () => {
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const queue = queueWith(
        defineWorker('slow', async () => {
          await gate;
          return WorkerResults.ok();
        })
      );

      await queue.start();
      const job = await queue.insert('slow', { args: {} });
      await new Promise((r) => setTimeout(r, 300)); // let it start executing

      expect((await queue.getJob(job.id))?.state).toBe('executing');
      await queue.cancelJobs({ queue: 'default' });
      expect((await queue.getJob(job.id))?.state).toBe('cancelled');

      release!();
      await new Promise((r) => setTimeout(r, 300));
      const final = await queue.getJob(job.id);
      await queue.stop();

      // The worker succeeded, but the job was already cancelled. Completing it
      // now would silently undo the cancellation.
      expect(final?.state).toBe('cancelled');
    }, 20000);

    it('refuses an update whose source state does not allow it', async () => {
      const job = await adapter.insertJob({
        state: 'completed',
        queue: 'default',
        worker: 'W',
        args: {},
        meta: {},
        tags: [],
        errors: [],
        attempt: 1,
        maxAttempts: 20,
        priority: 0,
        scheduledAt: new Date(),
        attemptedAt: null,
        attemptedBy: null,
        uniqueKey: null,
        completedAt: null,
        discardedAt: null,
        cancelledAt: null,
      } as Omit<Job, 'id' | 'insertedAt'>);

      const refused = await adapter.updateJob(job.id, { state: 'executing' }, ['available']);

      expect(refused).toBeNull();
      expect((await adapter.getJob(job.id))?.state).toBe('completed');
    });
  });

  describe('cancel and retry', () => {
    it('cancels a single job by id', async () => {
      const queue = queueWith();
      const keep = await queue.insert('W', { args: { n: 1 } });
      const drop = await queue.insert('W', { args: { n: 2 } });

      const cancelled = await queue.cancelJob(drop.id);

      expect(cancelled).toBe(true);
      expect((await queue.getJob(drop.id))?.state).toBe('cancelled');
      expect((await queue.getJob(keep.id))?.state).toBe('available');
    });

    it('refuses to cancel everything unless asked explicitly', async () => {
      const queue = queueWith();
      const job = await queue.insert('W', { args: {} });

      await expect(queue.cancelJobs({})).rejects.toThrow(/criteri/i);
      // The rejected call must not have touched anything.
      expect((await queue.getJob(job.id))?.state).toBe('available');

      const cancelled = await queue.cancelJobs({ all: true });
      expect(cancelled).toBe(1);
      expect((await queue.getJob(job.id))?.state).toBe('cancelled');
    });

    it('returns a discarded job to the queue', async () => {
      const queue = queueWith();
      const job = await queue.insert('W', { args: {}, maxAttempts: 1 });
      await adapter.updateJob(job.id, { state: 'discarded', discardedAt: new Date() });

      const retried = await queue.retryJob(job.id);

      expect(retried).toBe(true);
      const after = await queue.getJob(job.id);
      expect(after?.state).toBe('available');
      // A job that exhausted its attempts needs headroom to run again.
      expect(after!.maxAttempts).toBeGreaterThan(after!.attempt);
    });

    it('does not retry a job that is still runnable', async () => {
      const queue = queueWith();
      const job = await queue.insert('W', { args: {} });

      expect(await queue.retryJob(job.id)).toBe(false);
      expect((await queue.getJob(job.id))?.state).toBe('available');
    });
  });

  describe('pruner telemetry', () => {
    it('does not report pruned rows as completed jobs', async () => {
      const { PrunerPlugin } = await import('../src/plugins/pruner.js');
      const seen = events();

      db.prepare(
        `INSERT INTO izi_jobs (state, queue, worker, args, completed_at)
         VALUES ('completed', 'default', 'W', '{}', datetime('now', '-2 days'))`
      ).run();

      const pruner = new PrunerPlugin({ interval: 60000, maxAge: 3600 });
      await pruner.start({ database: adapter, node: 'node-1', queues: ['default'] });
      await new Promise((r) => setTimeout(r, 50));
      await (pruner as unknown as { prune(): Promise<void> }).prune();
      await pruner.stop();

      expect(seen).not.toContain('job:complete');
      expect(seen).toContain('jobs:pruned');
    }, 20000);
  });
});
