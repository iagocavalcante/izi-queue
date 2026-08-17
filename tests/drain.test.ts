import Database from 'better-sqlite3';
import { IziQueue } from '../src/core/izi-queue.js';
import { defineWorker, WorkerResults, clearWorkers } from '../src/core/worker.js';
import { createSQLiteAdapter, SQLiteAdapter } from '../src/database/sqlite.js';
import { telemetry } from '../src/core/telemetry.js';
import { waitFor } from './helpers/wait.js';

describe('drain', () => {
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
      queues: { default: 2 },
      stageInterval: 50,
      pollInterval: 50
    });
    workers.forEach((w) => queue.register(w));
    return queue;
  }

  /**
   * Starts the queue (so `IziQueue` populates its internal `Queue` instances)
   * and immediately pauses it, so setup work (inserting jobs) cannot race the
   * live poller. Tests that specifically exercise the poller race resume the
   * queue themselves.
   */
  async function startPaused(queue: IziQueue, name = 'default'): Promise<void> {
    await queue.start();
    queue.pauseQueue(name);
  }

  it("increments a drained job's attempt exactly once", async () => {
    const queue = queueWith(defineWorker('ok', async () => WorkerResults.ok()));
    await startPaused(queue);

    const inserted = await queue.insert('ok', { args: {} });

    await queue.drain();

    const final = await queue.getJob(inserted.id);
    await queue.shutdown();

    expect(final?.attempt).toBe(1);
    expect(final?.state).toBe('completed');
  }, 20000);

  it('returns a tally that matches the jobs it executed', async () => {
    const queue = queueWith(
      defineWorker('succeed', async () => WorkerResults.ok()),
      defineWorker('fail', async () => WorkerResults.error('boom'), { maxAttempts: 5 }),
      defineWorker('discard', async () => WorkerResults.error('boom'), { maxAttempts: 1 }),
      defineWorker('cancel', async () => WorkerResults.cancel('nope')),
      defineWorker('snooze', async () => WorkerResults.snooze(60))
    );
    await startPaused(queue);

    await queue.insert('succeed', { args: {} });
    await queue.insert('fail', { args: {} });
    await queue.insert('discard', { args: {} });
    await queue.insert('cancel', { args: {} });
    await queue.insert('snooze', { args: {} });

    const tally = await queue.drain();
    await queue.shutdown();

    expect(tally).toEqual({
      success: 1,
      failure: 1,
      snoozed: 1,
      discarded: 1,
      cancelled: 1
    });
  }, 20000);

  it('drains a backlog larger than the queue limit', async () => {
    let executions = 0;
    const queue = queueWith(
      defineWorker('bulk', async () => {
        executions++;
        return WorkerResults.ok();
      })
    );
    await startPaused(queue); // limit is 2, backlog is 7 -- forces multiple fetch rounds

    for (let i = 0; i < 7; i++) {
      await queue.insert('bulk', { args: { i } });
    }

    const tally = await queue.drain();
    await queue.shutdown();

    expect(executions).toBe(7);
    expect(tally.success).toBe(7);
  }, 20000);

  it('completes only once the queue has no more available jobs', async () => {
    const queue = queueWith(defineWorker('ok', async () => WorkerResults.ok()));
    await startPaused(queue);

    const jobs = await Promise.all(
      Array.from({ length: 5 }, (_, i) => queue.insert('ok', { args: { i } }))
    );

    await queue.drain();

    for (const job of jobs) {
      const final = await queue.getJob(job.id);
      expect(final?.state).toBe('completed');
    }

    // Nothing left runnable: the backlog drain() was asked to clear is gone.
    const remaining = db
      .prepare("SELECT COUNT(*) as n FROM izi_jobs WHERE state = 'available'")
      .get() as { n: number };
    expect(remaining.n).toBe(0);

    await queue.shutdown();
  }, 20000);

  it('never resets a fetched job back to available', async () => {
    // A worker that errors without exhausting attempts should land on
    // `retryable`, never bounce back through `available` on the way there.
    const queue = queueWith(
      defineWorker('flaky', async () => WorkerResults.error('boom'), { maxAttempts: 5 })
    );
    await startPaused(queue);

    const inserted = await queue.insert('flaky', { args: {} });
    await queue.drain();

    const final = await queue.getJob(inserted.id);
    await queue.shutdown();

    expect(final?.state).toBe('retryable');
    expect(final?.attempt).toBe(1);
  }, 20000);

  it('leaves the queue running again after draining a started, running queue', async () => {
    const queue = queueWith(defineWorker('ok', async () => WorkerResults.ok()));
    await startPaused(queue);
    await queue.insert('ok', { args: {} });
    queue.resumeQueue('default');

    await queue.drain();

    expect(queue.getQueueStatus('default')?.state).toBe('running');

    // Prove the poller genuinely resumed: a job inserted after drain() is
    // picked up by the live poll loop, not left stranded.
    const job = await queue.insert('ok', { args: {} });
    const final = await waitFor(
      async () => {
        const current = await queue.getJob(job.id);
        return current?.state === 'completed' ? current : null;
      },
      { describe: 'the poller to resume and process a post-drain job' }
    );

    await queue.shutdown();
    expect(final?.state).toBe('completed');
  }, 20000);

  it('leaves a paused queue paused after draining', async () => {
    const queue = queueWith(defineWorker('ok', async () => WorkerResults.ok()));
    await startPaused(queue);
    await queue.insert('ok', { args: {} });

    await queue.drain();

    expect(queue.getQueueStatus('default')?.state).toBe('paused');

    await queue.shutdown();
  }, 20000);

  it('does not double-run or double-count a job the live poller also raced for', async () => {
    // Poll aggressively and make jobs slow enough that, without pausing the
    // poller during drain, the old bug (drain resets fetched jobs back to
    // `available`, then calls dispatch()) would let both the poller and
    // drain's own loop claim the same job.
    const executedJobIds: number[] = [];
    const queue = new IziQueue({
      database: adapter,
      queues: { default: 3 },
      stageInterval: 50,
      pollInterval: 5
    });
    queue.register(
      defineWorker(
        'slow',
        async (job) => {
          executedJobIds.push(job.id);
          await new Promise((resolve) => setTimeout(resolve, 30));
          return WorkerResults.ok();
        },
        { maxAttempts: 3 }
      )
    );

    await queue.start();
    const jobs = await Promise.all(
      Array.from({ length: 6 }, (_, i) => queue.insert('slow', { args: { i } }))
    );

    await queue.drain();

    const counts = new Map<number, number>();
    for (const id of executedJobIds) counts.set(id, (counts.get(id) ?? 0) + 1);

    const finals = await Promise.all(jobs.map((job) => queue.getJob(job.id)));
    await queue.shutdown();

    for (const [index, job] of jobs.entries()) {
      expect(counts.get(job.id)).toBe(1);
      expect(finals[index]?.attempt).toBe(1);
      expect(finals[index]?.state).toBe('completed');
    }
  }, 20000);

  it('returns only once every claimed job has actually finished executing', async () => {
    // The old implementation fired queue.dispatch() and a fixed 100ms sleep,
    // so it could return while dispatched jobs were still running
    // asynchronously in the background. A job that takes longer than that
    // sleep must still be finished, and no longer counted as running, by the
    // time drain() resolves.
    const queue = queueWith(
      defineWorker('slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return WorkerResults.ok();
      })
    );
    await startPaused(queue);
    const inserted = await queue.insert('slow', { args: {} });
    queue.resumeQueue('default');

    const tally = await queue.drain();

    expect(tally.success).toBe(1);
    expect(queue.getQueueStatus('default')?.running).toBe(0);

    const final = await queue.getJob(inserted.id);
    expect(final?.state).toBe('completed');

    await queue.shutdown();
  }, 20000);
});
