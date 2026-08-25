import Database from 'better-sqlite3';
import {
  createIziQueue,
  createLifelinePlugin,
  createPrunerPlugin,
  createSQLiteAdapter,
  clearWorkers
} from '../src/index.js';
import { DEFAULT_BATCH_SIZE } from '../src/database/adapter.js';
import type { PluginContext } from '../src/plugins/plugin.js';
import { stayFalse, waitFor } from './helpers/wait.js';

/**
 * Leader-gating as the rest of the system sees it: who stages, who runs the
 * maintenance plugins, and what a follower must still keep doing (#26).
 */
describe('Leadership', () => {
  let db: Database.Database;
  let adapter: ReturnType<typeof createSQLiteAdapter>;

  /** A job that became due a minute ago and is waiting on the stager. */
  function insertOverdueJob(worker = 'DueWorker'): void {
    db.prepare(`
      INSERT INTO izi_jobs (state, queue, worker, args, scheduled_at)
      VALUES ('scheduled', 'default', ?, '{}', datetime('now', '-1 minute'))
    `).run(worker);
  }

  function stateOf(worker: string): string {
    return (db.prepare('SELECT state FROM izi_jobs WHERE worker = ?').get(worker) as { state: string }).state;
  }

  beforeEach(async () => {
    db = new Database(':memory:');
    adapter = createSQLiteAdapter(db);
    await adapter.migrate();
    clearWorkers();
  });

  afterEach(async () => {
    await adapter.close();
  });

  describe('election across instances', () => {
    it('elects exactly one of two instances sharing a database', async () => {
      const a = createIziQueue({ database: adapter, queues: { default: 1 }, node: 'node-a' });
      const b = createIziQueue({ database: adapter, queues: { default: 1 }, node: 'node-b' });

      await a.start();
      await b.start();

      expect([a, b].filter(q => q.isLeader())).toHaveLength(1);
      expect((await a.getLeader())?.node).toBe('node-a');

      await a.stop();
      await b.stop();
    });

    it('reports leadership through queue status', async () => {
      const queue = createIziQueue({ database: adapter, queues: { default: 1 }, node: 'node-a' });
      await queue.start();

      expect(queue.getQueueStatus('default')?.isLeader).toBe(true);
      expect(queue.getAllQueueStatus()[0].isLeader).toBe(true);

      await queue.stop();
    });

    it('hands the lease back on shutdown so the next instance leads', async () => {
      const a = createIziQueue({ database: adapter, queues: { default: 1 }, node: 'node-a' });
      await a.start();
      await a.stop();

      const b = createIziQueue({ database: adapter, queues: { default: 1 }, node: 'node-b' });
      await b.start();

      expect(b.isLeader()).toBe(true);
      await b.stop();
    });
  });

  describe('staging', () => {
    it('stages due jobs on the leader', async () => {
      insertOverdueJob();

      const leader = createIziQueue({
        database: adapter,
        queues: { default: 1 },
        node: 'node-a',
        stageInterval: 1000
      });
      await leader.start();

      // Staging nudges the queue to poll immediately, so the job may already
      // have been claimed by the time this observes it -- what matters is that
      // it left `scheduled`, which only the stager can do.
      await waitFor(async () => stateOf('DueWorker') !== 'scheduled', {
        describe: 'the leader to stage the overdue job'
      });

      await leader.stop();
    });

    it('does not stage on a follower', async () => {
      // Another node already holds the lease with plenty of time left, so the
      // instance under test can only ever come up as a follower.
      await adapter.acquireLeadership('default', 'someone-else', 300);
      insertOverdueJob();

      const follower = createIziQueue({
        database: adapter,
        queues: { default: 1 },
        node: 'node-b',
        stageInterval: 20
      });
      await follower.start();
      expect(follower.isLeader()).toBe(false);

      await stayFalse(async () => stateOf('DueWorker') !== 'scheduled', { duration: 300 });

      await follower.stop();
    });

    it('stages on every node when leadership is disabled', async () => {
      await adapter.acquireLeadership('default', 'someone-else', 300);
      insertOverdueJob();

      const queue = createIziQueue({
        database: adapter,
        queues: { default: 1 },
        node: 'node-b',
        stageInterval: 20,
        leadership: false
      });
      await queue.start();
      expect(queue.isLeader()).toBe(true);

      await waitFor(async () => stateOf('DueWorker') !== 'scheduled', {
        describe: 'staging with leadership disabled'
      });

      await queue.stop();
    });

    it('still stages inside drain() on a follower', async () => {
      // drain() is an explicit, synchronous request from the caller -- gating
      // it on leadership would make it silently do nothing on a follower.
      await adapter.acquireLeadership('default', 'someone-else', 300);
      insertOverdueJob();

      const follower = createIziQueue({
        database: adapter,
        queues: { default: 1 },
        node: 'node-b',
        stageInterval: 60000
      });
      await follower.start();
      expect(follower.isLeader()).toBe(false);

      await follower.drain('default');

      // No worker is registered, so the job is discarded rather than completed
      // -- what matters is that it was staged and fetched at all.
      expect(stateOf('DueWorker')).toBe('discarded');

      await follower.stop();
    });

    it('keeps fetching jobs on a follower', async () => {
      await adapter.acquireLeadership('default', 'someone-else', 300);

      const follower = createIziQueue({
        database: adapter,
        queues: { default: 1 },
        node: 'node-b',
        pollInterval: 20
      });
      follower.register({
        name: 'FollowerWorker',
        perform: async () => undefined
      });
      await follower.start();

      await follower.insert('FollowerWorker', { args: {} });

      await waitFor(async () => stateOf('FollowerWorker') === 'completed', {
        describe: 'a follower to execute an available job'
      });

      await follower.stop();
    });
  });

  describe('plugin gating', () => {
    function contextFor(isLeader: boolean): PluginContext {
      return {
        database: adapter,
        node: 'node-a',
        queues: ['default'],
        isLeader: () => isLeader
      };
    }

    it('prunes on the leader and not on a follower', async () => {
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, completed_at)
        VALUES ('completed', 'default', 'OldWorker', '{}', datetime('now', '-10 days'))
      `).run();

      const follower = createPrunerPlugin({ interval: 60000, maxAge: 86400 });
      (follower as unknown as { config: unknown }).config = {
        interval: 20,
        maxAge: 86400,
        batchSize: DEFAULT_BATCH_SIZE
      };
      await follower.start(contextFor(false));
      await stayFalse(
        async () => db.prepare('SELECT * FROM izi_jobs WHERE worker = ?').all('OldWorker').length === 0,
        { duration: 200 }
      );
      await follower.stop();

      const leader = createPrunerPlugin({ interval: 60000, maxAge: 86400 });
      (leader as unknown as { config: unknown }).config = {
        interval: 20,
        maxAge: 86400,
        batchSize: DEFAULT_BATCH_SIZE
      };
      await leader.start(contextFor(true));
      await waitFor(
        async () => db.prepare('SELECT * FROM izi_jobs WHERE worker = ?').all('OldWorker').length === 0,
        { describe: 'the leader to prune the old job' }
      );
      await leader.stop();
    });

    it('rescues on the leader and not on a follower', async () => {
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, attempted_at)
        VALUES ('executing', 'default', 'StuckWorker', '{}', datetime('now', '-10 minutes'))
      `).run();

      const follower = createLifelinePlugin({ interval: 60000, rescueAfter: 300 });
      await follower.start(contextFor(false));
      expect(stateOf('StuckWorker')).toBe('executing');
      await follower.stop();

      const leader = createLifelinePlugin({ interval: 60000, rescueAfter: 300 });
      await leader.start(contextFor(true));
      expect(stateOf('StuckWorker')).toBe('available');
      await leader.stop();
    });

    it('treats a context without isLeader as leading', async () => {
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, attempted_at)
        VALUES ('executing', 'default', 'StuckWorker', '{}', datetime('now', '-10 minutes'))
      `).run();

      const plugin = createLifelinePlugin({ interval: 60000, rescueAfter: 300 });
      await plugin.start({ database: adapter, node: 'node-a', queues: ['default'] });

      expect(stateOf('StuckWorker')).toBe('available');
      await plugin.stop();
    });
  });
});
