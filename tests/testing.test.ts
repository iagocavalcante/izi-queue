import { AssertionError } from 'node:assert';
import { fork } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  IziQueue, createSQLiteAdapter, defineWorker, registerWorker, getWorker,
  clearWorkers, shutdownIsolatedWorkers, WorkerResults
} from '../src/index.js';
import { allEnqueued, assertEnqueued, refuteEnqueued, buildJob, performJob } from '../src/testing.js';

// Tests use Jest, while the helpers themselves only depend on Node's assertions.
describe('testing helpers', () => {
  let database: ReturnType<typeof createSQLiteAdapter>;
  let queue: IziQueue;

  beforeEach(async () => {
    clearWorkers();
    database = createSQLiteAdapter(new Database(':memory:'));
    await database.migrate();
    queue = new IziQueue({ database, queues: [{ name: 'default', limit: 2, paused: true }] });
  });

  afterEach(async () => {
    await queue.stop();
    await shutdownIsolatedWorkers();
    await database.close();
    clearWorkers();
  });

  it('builds a detached executing job with worker defaults and JSON-normalized args', () => {
    const worker = defineWorker('mail', async () => {}, { queue: 'emails', priority: 3, maxAttempts: 4 });
    const args = { nested: { value: 1 }, created: new Date('2026-01-01T00:00:00Z') };
    const job = buildJob(worker, args, { attempt: 2 });
    expect(job).toMatchObject({ worker: 'mail', queue: 'emails', priority: 3, maxAttempts: 4, state: 'executing', attempt: 2 });
    expect(job.id).toBeLessThan(0);
    expect(buildJob(worker, args).id).not.toBe(job.id);
    expect(job.args.created).toBe('2026-01-01T00:00:00.000Z');
    job.args.nested.value = 5;
    expect(args.nested.value).toBe(1);
    expect(job.attemptedAt).toBeInstanceOf(Date);
    expect(getWorker('mail')).toBeUndefined();
    expect(buildJob(worker, {}, { queue: 'other', priority: 0, maxAttempts: 1, id: 42 })).toMatchObject({
      queue: 'other', priority: 0, maxAttempts: 1, id: 42
    });
  });

  it('rejects invalid workers, job options and unserializable args', () => {
    const worker = defineWorker('work', async () => {});
    expect(() => buildJob('unknown', {})).toThrow(AssertionError);
    for (const options of [{ attempt: 0 }, { maxAttempts: 0 }, { priority: -1 }, { id: NaN }, { scheduledAt: new Date(NaN) }, { tags: 'bad' as any }]) {
      expect(() => buildJob(worker, {}, options)).toThrow(AssertionError);
    }
    expect(() => buildJob(worker, { n: BigInt(1) })).toThrow();
  });

  it('performs concurrent definitions with the same name without changing the registry', async () => {
    const original = defineWorker('same', async () => WorkerResults.ok('registered'));
    registerWorker(original);
    const first = defineWorker<{ n: number }>('same', async (job, { signal }) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return WorkerResults.ok(job.args.n + job.attempt);
    });
    const second = defineWorker('same', async () => WorkerResults.ok('second'));
    expect(await Promise.all([
      performJob(first, { n: 4 }, { attempt: 2 }), performJob(second, {}), performJob('same', {})
    ])).toEqual([WorkerResults.ok(6), WorkerResults.ok('second'), WorkerResults.ok('registered')]);
    expect(getWorker('same')).toBe(original);
    expect(await allEnqueued(queue)).toEqual([]);
  });

  it('normalizes void and thrown errors using the production execution path', async () => {
    expect(await performJob(defineWorker('void', async () => {}), {})).toEqual({ status: 'ok' });
    const error = new Error('worker failed');
    expect(await performJob(defineWorker('throws', async () => { throw error; }), {})).toEqual({ status: 'error', error });
    expect(await performJob(defineWorker('snooze', async () => WorkerResults.snooze(10)), {})).toEqual({ status: 'snooze', seconds: 10 });
    expect(await performJob(defineWorker('cancel', async () => WorkerResults.cancel('stop')), {})).toEqual({ status: 'cancel', reason: 'stop' });
  });

  it('uses the production timeout and AbortSignal', async () => {
    let signal: AbortSignal | undefined;
    const worker = defineWorker('timeout', async (_job, context) => {
      signal = context.signal;
      await new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }));
    }, { timeout: 10 });
    const result = await performJob(worker, {});
    expect(result.status).toBe('error');
    expect(signal?.aborted).toBe(true);
  });

  it('fails clearly on invalid worker results', async () => {
    for (const result of [null, 4, { status: 'unknown' }, { status: 'snooze', seconds: -1 }, { status: 'error', error: 5 }]) {
      const worker = defineWorker('invalid', async () => result as any);
      await expect(performJob(worker, {})).rejects.toThrow(/invalid result/);
    }
  });

  it('executes isolated workers with distinct test job ids', async () => {
    const worker = defineWorker('isolated', async () => { throw new Error('must run in a thread'); }, {
      isolation: { isolated: true, workerPath: join(__dirname, 'fixtures/test-isolated-worker.js') }
    });
    const results = await Promise.all([performJob(worker, { action: 'success' }), performJob(worker, { action: 'success' })]);
    expect(results).toEqual([
      { status: 'ok', value: { processed: true, isMainThread: false, jobId: expect.any(Number) } },
      { status: 'ok', value: { processed: true, isMainThread: false, jobId: expect.any(Number) } }
    ]);
    expect((results[0] as any).value.jobId).not.toBe((results[1] as any).value.jobId);
  });

  it('matches nested args, metadata, tags and priority without matching missing keys or different arrays', async () => {
    const job = await queue.insert('mail', {
      args: { user: { id: 1, name: 'Iago' }, ids: [1, 2], nil: null },
      meta: { trace: { id: 'abc', extra: true } }, tags: ['email', 'urgent'], priority: 2
    });
    expect((await assertEnqueued(queue, { worker: 'mail', args: { user: { id: 1 } }, meta: { trace: { id: 'abc' } }, tags: ['urgent'], priority: 2 })).id).toBe(job.id);
    await refuteEnqueued(database, { args: { missing: undefined } });
    await refuteEnqueued(database, { args: { ids: [1] } });
    await refuteEnqueued(database, { args: { nil: {} } });
    await refuteEnqueued(database, { args: { ids: {} } });
    await refuteEnqueued(database, { priority: 3 });
    expect((await assertEnqueued(database, { args: { ids: [1, 2], nil: null } })).id).toBe(job.id);
  });

  it('includes available and future scheduled jobs, excluding all other states', async () => {
    const available = await queue.insert('work', { args: {} });
    const scheduled = await queue.insert('work', { args: {}, scheduledAt: new Date(Date.now() + 3600000) });
    for (const state of ['executing', 'retryable', 'completed', 'cancelled', 'discarded'] as const) {
      const job = await queue.insert('work', { args: {} });
      await database.updateJob(job.id, { state });
    }
    expect((await allEnqueued(database)).map(job => job.id)).toEqual([scheduled.id, available.id]);
  });

  it('searches beyond the adapters first page instead of returning false negatives', async () => {
    const oldest = await queue.insert('bulk', { args: { match: true } });
    await queue.insertAll('bulk', Array.from({ length: 1000 }, () => ({ args: { match: false } })));
    expect((await allEnqueued(queue, { worker: 'bulk' })).length).toBe(1001);
    expect((await assertEnqueued(queue, { args: { match: true } })).id).toBe(oldest.id);
    await expect(refuteEnqueued(queue, { args: { match: true } })).rejects.toThrow(AssertionError);
  });

  it('reports standard assertion failures with the criteria and matching job', async () => {
    await expect(assertEnqueued(queue, { worker: 'missing' })).rejects.toMatchObject({
      code: 'ERR_ASSERTION', operator: 'assertEnqueued', actual: null, expected: { worker: 'missing' }
    });
    const job = await queue.insert('work', { args: {} });
    await expect(refuteEnqueued(queue, { worker: 'work' })).rejects.toMatchObject({
      code: 'ERR_ASSERTION', operator: 'refuteEnqueued', actual: { id: job.id }
    });
    await expect(allEnqueued({})).rejects.toThrow(/listJobs support/);
    await expect(assertEnqueued({ listJobs: async () => { throw new Error('offline'); } })).rejects.toThrow('offline');
  });

  it('waits for an insertion and observes absence for the whole timeout window', async () => {
    const found = assertEnqueued(queue, { worker: 'later' }, { timeout: 500 });
    await queue.insert('later', { args: {} });
    expect((await found).worker).toBe('later');
    const absent = refuteEnqueued(queue, { worker: 'unexpected' }, { timeout: 500 });
    await queue.insert('unexpected', { args: {} });
    await expect(absent).rejects.toThrow(AssertionError);
    const start = performance.now();
    await refuteEnqueued(queue, { worker: 'never' }, { timeout: 15, interval: 5 });
    expect(performance.now() - start).toBeGreaterThanOrEqual(15);
    await expect(assertEnqueued(queue, { worker: 'never' }, { timeout: 5 })).rejects.toThrow(AssertionError);
  });

  it('rejects invalid assertion timing options', async () => {
    for (const options of [{ timeout: -1 }, { timeout: Infinity }, { interval: 0 }, { interval: NaN }]) {
      await expect(assertEnqueued(queue, {}, options)).rejects.toThrow(AssertionError);
      await expect(refuteEnqueued(queue, {}, options)).rejects.toThrow(AssertionError);
    }
  });

  it('works with the existing paused queue and drain API', async () => {
    queue.register(defineWorker('work', async () => WorkerResults.ok()));
    await queue.start();
    await queue.insert('work', { args: { id: 1 } });
    await assertEnqueued(queue, { worker: 'work', args: { id: 1 } });
    expect(await queue.drain()).toMatchObject({ success: 1 });
    await refuteEnqueued(queue);
    expect(queue.getQueueStatus('default')?.state).toBe('paused');
  });

  it('exports the built testing entry point to an ESM consumer using only Node assertions', async () => {
    const child = fork(join(__dirname, 'fixtures/testing-consumer.js'), [], { silent: true });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += chunk; });
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
  });
});
