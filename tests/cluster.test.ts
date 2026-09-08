import Database from 'better-sqlite3';
import { fork } from 'child_process';
import { once } from 'events';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  IziQueue, createSQLiteAdapter, createPostgresAdapter, createMySQLAdapter,
  clearWorkers, defineWorker, shutdownIsolatedWorkers, telemetry
} from '../src/index.js';
import type { DatabaseAdapter, IziQueueConfig, Logger } from '../src/types.js';
import { waitFor, stayFalse } from './helpers/wait.js';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

for (const dialect of ['sqlite', 'postgres', 'mysql'] as const) {
  const url = dialect === 'postgres' ? process.env.IZI_TEST_POSTGRES_URL : process.env.IZI_TEST_MYSQL_URL;
  const suite = dialect === 'sqlite' || url ? describe : describe.skip;
  suite(`cluster operations (${dialect})`, () => {
    let adapters: DatabaseAdapter[];
    let childConfig: { dialect: string; connection: string; options?: string };
    let nodes: IziQueue[];
    let cleanup: () => Promise<void>;
    let sql: (statement: string) => Promise<unknown>;

    beforeEach(async () => {
      clearWorkers();
      nodes = [];
      const name = `izi_cluster_${randomUUID().replaceAll('-', '')}`;
      if (dialect === 'sqlite') {
        const dir = mkdtempSync(join(tmpdir(), 'izi-cluster-'));
        childConfig = { dialect, connection: join(dir, 'jobs.db') };
        const dbs = [new Database(childConfig.connection), new Database(childConfig.connection)];
        dbs.forEach(db => db.pragma('journal_mode = WAL'));
        adapters = dbs.map(db => createSQLiteAdapter(db, logger));
        sql = async statement => dbs[0].exec(statement);
        cleanup = async () => { await Promise.all(adapters.map(a => a.close())); rmSync(dir, { recursive: true }); };
      } else if (dialect === 'postgres') {
        const admin = new pg.Pool({ connectionString: url });
        await admin.query(`CREATE SCHEMA ${name}`);
        childConfig = { dialect, connection: url!, options: `-c search_path=${name}` };
        const pools = [0, 1].map(() => new pg.Pool({ connectionString: url, options: `-c search_path=${name}`, max: 5 }));
        adapters = pools.map(pool => createPostgresAdapter(pool, logger));
        sql = statement => pools[0].query(statement);
        cleanup = async () => {
          await Promise.all(adapters.map(a => a.close()));
          await admin.query(`DROP SCHEMA ${name} CASCADE`);
          await admin.end();
        };
      } else {
        const admin = mysql.createPool(url!);
        await admin.query(`CREATE DATABASE ${name}`);
        const scoped = new URL(url!);
        scoped.pathname = `/${name}`;
        childConfig = { dialect, connection: scoped.toString() };
        const pools = [0, 1].map(() => mysql.createPool(scoped.toString()));
        adapters = pools.map(pool => createMySQLAdapter(pool as any, logger));
        sql = statement => pools[0].query(statement);
        cleanup = async () => {
          await Promise.all(adapters.map(a => a.close()));
          await admin.query(`DROP DATABASE ${name}`);
          await admin.end();
        };
      }
      await adapters[0].migrate();
    });

    afterEach(async () => {
      await nodes[0]?.cancelJobs({ all: true });
      await waitFor(() => nodes.every(node => node.getAllQueueStatus().every(q => q.running === 0)));
      await Promise.all(nodes.map(node => node.stop()));
      await shutdownIsolatedWorkers();
      telemetry.off();
      await cleanup();
      jest.restoreAllMocks();
    });

    function node(index: number, options: Partial<IziQueueConfig> = {}): IziQueue {
      const queue = new IziQueue({
        database: adapters[index], node: `node-${index}`, queues: { default: 2 },
        cluster: true, pollInterval: 20, controlInterval: 20, heartbeatInterval: 50,
        shutdownGracePeriod: 100, leadership: false, logger, ...options
      });
      nodes.push(queue);
      return queue;
    }

    it('preserves the synchronous 0.9.0 API and works on the 0.9.0 schema by default', async () => {
      await sql('DROP TABLE izi_queue_controls');
      await sql('ALTER TABLE izi_nodes DROP COLUMN queues');
      await sql(`DELETE FROM izi_migrations WHERE version = ${dialect === 'postgres' ? 9 : 8}`);
      const reads = adapters.map(adapter => jest.spyOn(adapter, 'getQueueControls'));
      const snapshots = adapters.map(adapter => jest.spyOn(adapter, 'recordQueueStatus'));
      const a = node(0, { cluster: undefined }), b = node(1, { cluster: undefined });
      a.register(defineWorker('legacy', async () => {}));
      await a.start(); await b.start();
      // These assignments also assert the public return types remain void.
      const paused: void = a.pauseQueue('default');
      expect(paused).toBeUndefined();
      expect(a.getQueueStatus('default')?.state).toBe('paused');
      expect(b.getQueueStatus('default')?.state).toBe('running');
      const scaled: void = a.scaleQueue('default', 0);
      expect(scaled).toBeUndefined();
      expect(a.getQueueStatus('default')?.limit).toBe(0);
      a.scaleQueue('default', 7);
      expect(b.getQueueStatus('default')?.limit).toBe(2);
      const resumed: void = a.resumeQueue('default');
      expect(resumed).toBeUndefined();
      expect(a.getQueueStatus('default')?.state).toBe('running');
      expect(() => a.pauseQueue('unknown')).not.toThrow();
      expect(() => a.scaleQueue('unknown', -1)).not.toThrow();
      const job = await a.insert('legacy', { args: {} });
      await waitFor(async () => (await a.getJob(job.id))?.state === 'completed');
      await a.stop(); await a.start();
      expect(a.getQueueStatus('default')?.limit).toBe(7);
      await a.stop(); await b.stop();
      reads.forEach(read => expect(read).not.toHaveBeenCalled());
      snapshots.forEach(snapshot => expect(snapshot).not.toHaveBeenCalled());
      await adapters[0].migrate();
      expect((await a.getJob(job.id))?.state).toBe('completed');
      expect(await adapters[0].getQueueControls!()).toEqual([]);
    });

    it('applies cluster controls only on nodes that opted in', async () => {
      const a = node(0, { cluster: undefined }), b = node(1);
      await a.start(); await b.start();
      await a.pauseClusterQueue('default');
      await waitFor(() => b.getQueueStatus('default')?.state === 'paused');
      expect(a.getQueueStatus('default')?.state).toBe('running');
      a.pauseQueue('default');
      a.resumeQueue('default');
      expect(a.getQueueStatus('default')?.state).toBe('running');
      expect(b.getQueueStatus('default')?.state).toBe('paused');
    });

    it('propagates global and targeted controls and keeps local controls local', async () => {
      const a = node(0), b = node(1);
      await a.start(); await b.start();
      await a.pauseClusterQueue('default');
      await waitFor(() => b.getQueueStatus('default')?.state === 'paused');
      await a.resumeClusterQueue('default', { node: b.node });
      await waitFor(() => b.getQueueStatus('default')?.state === 'running');
      expect(a.getQueueStatus('default')?.state).toBe('paused');
      await a.scaleClusterQueue('default', 3, { node: b.node });
      await waitFor(() => b.getQueueStatus('default')?.limit === 3);
      expect(a.getQueueStatus('default')?.limit).toBe(2);
      await a.resumeClusterQueue('default');
      await a.scaleClusterQueue('default', 4);
      await waitFor(() => b.getQueueStatus('default')?.limit === 4);
      a.pauseQueue('default');
      await stayFalse(() => b.getQueueStatus('default')?.state !== 'running', { duration: 80 });
      expect(a.getQueueStatus('default')?.state).toBe('paused');
      // A persisted command supersedes the ephemeral local override.
      await b.resumeClusterQueue('default');
      await waitFor(() => a.getQueueStatus('default')?.state === 'running');
    });

    it('applies a persisted pause before fetching on startup and restart', async () => {
      const a = node(0, { queues: {} }), b = node(1);
      let ran = false;
      a.register(defineWorker('work', async () => { ran = true; }));
      await a.pauseClusterQueue('default'); // A producer/admin need not run a worker queue.
      await a.insert('work', { args: {} });
      await b.start();
      expect(b.getQueueStatus('default')?.state).toBe('paused');
      await b.stop(); await b.start();
      await stayFalse(() => ran, { duration: 80 });
      await a.resumeClusterQueue('default');
      await waitFor(() => ran);
    });

    it('serializes concurrent commands without losing independent fields', async () => {
      const a = node(0), b = node(1);
      await Promise.all([
        a.pauseClusterQueue('default'), b.scaleClusterQueue('default', 7),
        a.scaleClusterQueue('default', 9, { node: 'special' })
      ]);
      const [control] = await adapters[0].getQueueControls!();
      expect(control.paused).toBe(true);
      expect(control.limit).toBe(7);
      expect(control.revision).toBe(3);
      await a.start(); await b.start();
      expect(b.getQueueStatus('default')).toMatchObject({ state: 'paused', limit: 7 });
    });

    it('recovers a missed notification and a failed reconciliation read', async () => {
      const a = node(0), b = node(1);
      await a.start(); await b.start();
      if (adapters[0].notifyControl) jest.spyOn(adapters[0], 'notifyControl').mockRejectedValue(new Error('offline'));
      jest.spyOn(adapters[1], 'getQueueControls').mockRejectedValueOnce(new Error('connection lost'));
      await a.pauseClusterQueue('default');
      await waitFor(() => b.getQueueStatus('default')?.state === 'paused');
    });

    it('cancels remote work by id and filters without interrupting unrelated work', async () => {
      const a = node(0, { queues: {} }), b = node(1, { queues: { default: 3 } });
      const signals = new Map<number, AbortSignal>();
      a.register(defineWorker('wait', async (job, { signal }) => {
        signals.set(job.id, signal);
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      }));
      await a.start(); await b.start();
      const first = await a.insert('wait', { args: {}, tags: ['cancel'] });
      const second = await a.insert('wait', { args: {}, tags: ['cancel'] });
      const keep = await a.insert('wait', { args: {}, tags: ['keep'] });
      await waitFor(() => signals.size === 3);
      expect(await a.cancelJob(first.id)).toBe(true);
      await waitFor(() => signals.get(first.id)?.aborted);
      expect(await a.cancelJobs({ tags: ['cancel'], state: ['executing'] })).toBe(1);
      await waitFor(() => signals.get(second.id)?.aborted);
      expect(signals.get(keep.id)?.aborted).toBe(false);
      expect((await a.getJob(second.id))?.state).toBe('cancelled');
      await a.cancelJob(keep.id);
    });

    it('refuses an old completion after cancellation and retry, even on the same node', async () => {
      const a = node(0);
      const inserted = await a.insert('work', { args: {} });
      const [old] = await adapters[0].fetchJobs('default', 1, 'same-node');
      await a.cancelJob(inserted.id);
      await a.retryJob(inserted.id);
      const [fresh] = await adapters[1].fetchJobs('default', 1, 'same-node');
      expect(await adapters[0].updateJob(old.id, { state: 'completed' }, ['executing'], old)).toBeNull();
      expect(await adapters[1].updateJob(fresh.id, { state: 'completed' }, ['executing'], fresh)).not.toBeNull();
    });

    it('does not start work cancelled between the claim and execution', async () => {
      const a = node(0, { queues: {} }), b = node(1);
      const perform = jest.fn(async () => {});
      a.register(defineWorker('work', perform));
      const fetch = adapters[1].fetchJobs.bind(adapters[1]);
      jest.spyOn(adapters[1], 'fetchJobs').mockImplementation(async (...args) => {
        const jobs = await fetch(...args);
        if (jobs.length) await adapters[0].cancelJobs({ ids: jobs.map(job => job.id) });
        return jobs;
      });
      await a.start(); await b.start();
      const job = await a.insert('work', { args: {} });
      await waitFor(async () => (await a.getJob(job.id))?.state === 'cancelled');
      await waitFor(() => b.getQueueStatus('default')?.running === 0);
      expect(perform).not.toHaveBeenCalled();
    });

    it('keeps a retry tracked when the old cooperative execution has not settled', async () => {
      const a = node(0, { queues: {} }), b = node(1);
      const signals = new Map<number, AbortSignal>();
      let releaseOld!: () => void, releaseNew!: () => void;
      const oldDone = new Promise<void>(resolve => { releaseOld = resolve; });
      const newDone = new Promise<void>(resolve => { releaseNew = resolve; });
      a.register(defineWorker('work', async (job, { signal }) => {
        signals.set(job.attempt, signal);
        await (job.attempt === 1 ? oldDone : newDone);
      }));
      try {
        await a.start(); await b.start();
        const job = await a.insert('work', { args: {} });
        await waitFor(() => signals.has(1));
        await a.cancelJob(job.id);
        await a.retryJob(job.id);
        await waitFor(async () => (await a.getJob(job.id))?.attempt === 2);
        await waitFor(() => signals.get(1)?.aborted);
        releaseOld();
        await waitFor(() => signals.has(2));
        expect((await a.getJob(job.id))?.state).toBe('executing');
        expect(b.getQueueStatus('default')?.running).toBe(1);
        releaseNew();
        await waitFor(async () => (await a.getJob(job.id))?.state === 'completed');
      } finally { releaseOld(); releaseNew(); }
    });

    it('reports heartbeat and queue snapshots and removes gracefully stopped nodes', async () => {
      const a = node(0, { queues: [{ name: 'default', limit: 2, paused: true }] }), b = node(1);
      const signals: AbortSignal[] = [];
      a.register(defineWorker('wait', async (_job, { signal }) => {
        signals.push(signal);
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      }));
      await a.start(); await b.start();
      await a.pauseClusterQueue('default', { node: a.node });
      const job = await a.insert('wait', { args: {} });
      await waitFor(async () => (await a.getClusterStatus()).find(n => n.node === b.node)?.queues[0].running === 1);
      const status = await a.getClusterStatus();
      expect(status).toHaveLength(2);
      expect(status[0].heartbeatAt).toBeInstanceOf(Date);
      expect(Math.abs(Date.now() - status[0].heartbeatAt.getTime())).toBeLessThan(3000);
      expect(status[0].queues[0]).toMatchObject({ state: 'paused', limit: 2 });
      await a.cancelJob(job.id);
      await waitFor(() => signals[0]?.aborted);
      await b.stop();
      expect((await a.getClusterStatus()).map(n => n.node)).toEqual([a.node]);
    });

    it('rejects invalid control arguments without writing desired state', async () => {
      const a = node(0);
      for (const limit of [0, -1, 1.2, Infinity, NaN]) await expect(a.scaleClusterQueue('default', limit)).rejects.toThrow();
      await expect(a.pauseClusterQueue('')).rejects.toThrow();
      await expect(a.pauseClusterQueue('default', { node: '' })).rejects.toThrow();
      expect(await adapters[0].getQueueControls!()).toEqual([]);
    });

    it('terminates remote isolated jobs, including ones waiting for a thread', async () => {
      const a = node(0, { queues: {} }), b = node(1, { isolation: { maxThreads: 1 } });
      a.register(defineWorker('isolated', async () => {}, {
        timeout: 30000,
        isolation: { isolated: true, workerPath: join(__dirname, 'fixtures/test-isolated-worker.js') }
      }));
      const started: number[] = [];
      telemetry.on('job:isolated:start', ({ job }) => { if (job) started.push(job.id); });
      await a.start(); await b.start();
      const first = await a.insert('isolated', { args: { action: 'delay', delay: 20000 } });
      await waitFor(() => started.includes(first.id));
      const waiting = await a.insert('isolated', { args: { action: 'success' } });
      await waitFor(() => b.getQueueStatus('default')?.running === 2);
      await a.cancelJob(waiting.id);
      await waitFor(() => b.getQueueStatus('default')?.running === 1);
      expect(started).not.toContain(waiting.id);
      await a.cancelJob(first.id);
      await waitFor(() => b.getQueueStatus('default')?.running === 0);
      expect((await a.getJob(first.id))?.state).toBe('cancelled');
      const next = await a.insert('isolated', { args: { action: 'success' } });
      await waitFor(async () => (await a.getJob(next.id))?.state === 'completed');
    });

    it('recovers jobs owned by a failed node without letting its old attempt overwrite them', async () => {
      const a = node(0);
      const inserted = await a.insert('work', { args: {} });
      await adapters[0].heartbeat!('dead-node');
      const [old] = await adapters[0].fetchJobs('default', 1, 'dead-node');
      const oldTime = dialect === 'sqlite' ? "datetime('now', '-10 minutes')" : dialect === 'postgres' ? "NOW() - INTERVAL '10 minutes'" : 'NOW() - INTERVAL 10 MINUTE';
      await sql(`UPDATE izi_nodes SET heartbeat_at = ${oldTime}`);
      await sql(`UPDATE izi_jobs SET attempted_at = ${oldTime}`);
      expect((await a.getClusterStatus())[0].heartbeatAt.getTime()).toBeLessThan(Date.now() - 500000);
      expect(await adapters[1].rescueStuckJobs(1, 1)).toBe(1);
      const [fresh] = await adapters[1].fetchJobs('default', 1, 'new-node');
      expect(await adapters[0].updateJob(old.id, { state: 'completed' }, ['executing'], old)).toBeNull();
      expect(await adapters[1].updateJob(fresh.id, { state: 'completed' }, ['executing'], fresh)).not.toBeNull();
      expect((await a.getJob(inserted.id))?.attempt).toBe(2);
    });

    it('controls a separate process and recovers its work after SIGKILL', async () => {
      const a = node(0, { queues: {} });
      const child = fork(join(__dirname, 'fixtures/cluster-node.js'), [JSON.stringify(childConfig)], { silent: true });
      const messages: Array<{ event: string; id?: number }> = [];
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr += chunk; });
      child.on('message', message => messages.push(message as { event: string; id?: number }));
      const exited = once(child, 'exit');
      try {
        await waitFor(() => {
          if (child.exitCode !== null) throw new Error(`Child exited: ${stderr}`);
          return messages.some(message => message.event === 'ready');
        });
        await a.pauseClusterQueue('default', { node: 'process-worker' });
        await waitFor(async () => (await a.getClusterStatus())[0]?.queues[0]?.state === 'paused');
        const first = await a.insert('remote-wait', { args: {} });
        await a.resumeClusterQueue('default');
        await waitFor(() => messages.some(message => message.event === 'started' && message.id === first.id));
        await a.cancelJob(first.id);
        await waitFor(() => messages.some(message => message.event === 'aborted' && message.id === first.id));
        const orphan = await a.insert('remote-wait', { args: {} });
        await waitFor(() => messages.some(message => message.event === 'started' && message.id === orphan.id));
        child.kill('SIGKILL');
        await exited;
        // Advance the persisted timestamps instead of sleeping through the node TTL.
        const oldTime = dialect === 'sqlite' ? "datetime('now', '-10 minutes')" : dialect === 'postgres' ? "NOW() - INTERVAL '10 minutes'" : 'NOW() - INTERVAL 10 MINUTE';
        await sql(`UPDATE izi_nodes SET heartbeat_at = ${oldTime}`);
        await sql(`UPDATE izi_jobs SET attempted_at = ${oldTime}`);
        expect(await a.rescueStuckJobs(1)).toBe(1);
        const b = node(1);
        b.register(defineWorker('remote-wait', async () => {}));
        await b.start();
        await waitFor(async () => (await b.getJob(orphan.id))?.state === 'completed');
        expect((await b.getJob(orphan.id))?.attempt).toBe(2);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      }
    });

    if (dialect === 'postgres') {
      it('delivers controls over NOTIFY before the fallback poll', async () => {
        const a = node(0, { controlInterval: 60000 }), b = node(1, { controlInterval: 60000 });
        await a.start(); await b.start();
        await a.pauseClusterQueue('default');
        await waitFor(() => b.getQueueStatus('default')?.state === 'paused', { timeout: 3000 });
      });

      it('re-subscribes to controls after its LISTEN connection is terminated', async () => {
        const a = node(0, { controlInterval: 60000 }), b = node(1, { controlInterval: 60000 });
        await a.start(); await b.start();
        const adapter = adapters[1] as any;
        const pid = adapter.client.processID;
        await sql(`SELECT pg_terminate_backend(${Number(pid)})`);
        await waitFor(() => adapter.client && adapter.client.processID !== pid && !adapter.resubscribing);
        await a.pauseClusterQueue('default');
        await waitFor(() => b.getQueueStatus('default')?.state === 'paused', { timeout: 3000 });
      });
    }
  });
}
