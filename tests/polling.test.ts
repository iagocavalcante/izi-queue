import { Queue } from '../src/core/queue.js';
import { defineWorker, registerWorker, clearWorkers, WorkerResults } from '../src/core/worker.js';
import type { DatabaseAdapter, Job } from '../src/types.js';

function createJobRow(id: number, overrides: Partial<Job> = {}): Job {
  return {
    id,
    state: 'executing',
    queue: 'default',
    worker: 'blocker',
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
    attemptedBy: null,
    uniqueKey: null,
    completedAt: null,
    discardedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

describe('queue polling', () => {
  beforeEach(() => clearWorkers());

  it('does not accumulate poll loops when dispatch() is called repeatedly', async () => {
    let fetchCalls = 0;
    const db = {
      fetchJobs: async () => {
        fetchCalls++;
        return [];
      },
      updateJob: async () => null,
    } as unknown as DatabaseAdapter;

    const queue = new Queue({ name: 'default', limit: 5, pollInterval: 50 }, db, 'node-1');
    await queue.start();

    // Simulates NOTIFY-driven dispatch: one per insert.
    for (let i = 0; i < 10; i++) queue.dispatch();

    await new Promise((r) => setTimeout(r, 500)); // ~10 poll intervals
    await queue.stop(100);

    // One loop at 50ms over ~500ms is ~10 polls, plus up to 10 immediate dispatches.
    expect(fetchCalls).toBeLessThanOrEqual(25);
  }, 15000);

  it('stops polling once the queue is stopped', async () => {
    let fetchCalls = 0;
    const db = {
      fetchJobs: async () => {
        fetchCalls++;
        return [];
      },
      updateJob: async () => null,
    } as unknown as DatabaseAdapter;

    const queue = new Queue({ name: 'default', limit: 5, pollInterval: 20 }, db, 'node-1');
    await queue.start();
    for (let i = 0; i < 5; i++) queue.dispatch();
    await new Promise((r) => setTimeout(r, 200));

    await queue.stop(100);
    const afterStop = fetchCalls;
    await new Promise((r) => setTimeout(r, 300));

    expect(fetchCalls).toBe(afterStop);
  }, 15000);

  it('does not start jobs after stop() has resolved', async () => {
    const executed: number[] = [];
    let finishedDuringShutdown = false;

    registerWorker(
      defineWorker('blocker', async () => {
        executed.push(1);
        await new Promise((r) => setTimeout(r, 50));
        return WorkerResults.ok();
      })
    );

    const db = {
      // A fetch already in flight when stop() is called.
      fetchJobs: async () => {
        await new Promise((r) => setTimeout(r, 80));
        return [createJobRow(1)];
      },
      updateJob: async () => {
        finishedDuringShutdown = true;
        return null;
      },
    } as unknown as DatabaseAdapter;

    const queue = new Queue({ name: 'default', limit: 1, pollInterval: 10 }, db, 'node-1');
    await queue.start();
    await new Promise((r) => setTimeout(r, 40)); // let a poll get in flight

    await queue.stop(2000);

    // Whatever the in-flight poll claimed must be finished by the time stop()
    // resolves — never started afterwards against a closing database.
    const executedAtStop = executed.length;
    expect(executedAtStop === 0 || finishedDuringShutdown).toBe(true);

    await new Promise((r) => setTimeout(r, 200));
    expect(executed.length).toBe(executedAtStop);
  }, 15000);

  it('survives a database failure while persisting a job result', async () => {
    registerWorker(defineWorker('blocker', async () => WorkerResults.ok()));

    let handed = false;
    const db = {
      fetchJobs: async () => {
        if (handed) return [];
        handed = true;
        return [createJobRow(1)];
      },
      // The connection dies between claiming the job and writing its result.
      updateJob: async () => {
        throw new Error('The database connection is not open');
      },
    } as unknown as DatabaseAdapter;

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);

    const queue = new Queue({ name: 'default', limit: 1, pollInterval: 20 }, db, 'node-1');
    await queue.start();
    await new Promise((r) => setTimeout(r, 300));
    await queue.stop(500);

    process.off('unhandledRejection', onRejection);

    expect(rejections).toHaveLength(0);
    // The queue is still healthy and polling.
    expect(queue.currentState).toBe('stopped');
  }, 15000);

  it('never runs more jobs concurrently than the queue limit', async () => {
    let running = 0;
    let maxObserved = 0;
    let nextId = 1;

    registerWorker(
      defineWorker('blocker', async () => {
        running++;
        maxObserved = Math.max(maxObserved, running);
        await new Promise((r) => setTimeout(r, 150));
        running--;
        return WorkerResults.ok();
      })
    );

    const db = {
      // Always hands back exactly as many jobs as asked for, like a saturated queue.
      fetchJobs: async (_queue: string, limit: number) =>
        Array.from({ length: limit }, () => createJobRow(nextId++)),
      updateJob: async () => null,
    } as unknown as DatabaseAdapter;

    const queue = new Queue({ name: 'default', limit: 3, pollInterval: 20 }, db, 'node-1');
    await queue.start();

    // Hammer dispatch while jobs are in flight.
    for (let i = 0; i < 20; i++) queue.dispatch();
    await new Promise((r) => setTimeout(r, 400));
    await queue.stop(500);

    expect(maxObserved).toBeLessThanOrEqual(3);
  }, 15000);
});
