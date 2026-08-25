import Database from 'better-sqlite3';
import { Peer } from '../src/core/peer.js';
import { createSQLiteAdapter } from '../src/index.js';
import { telemetry } from '../src/core/telemetry.js';
import type {
  DatabaseAdapter,
  LeadershipConfig,
  Logger,
  TelemetryPayload
} from '../src/types.js';
import { waitFor } from './helpers/wait.js';

/**
 * A class instance's methods live on its prototype, so spreading one into an
 * object literal drops every method it has. Overriding through a proxy keeps
 * the rest of the adapter intact, which is what makes these fakes exercise
 * the real SQL underneath.
 */
function adapterWith(
  adapter: DatabaseAdapter,
  overrides: Partial<Record<keyof DatabaseAdapter, unknown>>
): DatabaseAdapter {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop in overrides) return overrides[prop as keyof DatabaseAdapter];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
};

describe('Peer (leader election)', () => {
  let db: Database.Database;
  let adapter: ReturnType<typeof createSQLiteAdapter>;
  const peers: Peer[] = [];

  function peer(node: string, config?: boolean | LeadershipConfig): Peer {
    const created = new Peer(adapter, node, config, silentLogger);
    peers.push(created);
    return created;
  }

  beforeEach(async () => {
    db = new Database(':memory:');
    adapter = createSQLiteAdapter(db);
    await adapter.migrate();
  });

  afterEach(async () => {
    await Promise.all(peers.splice(0).map(p => p.stop()));
    await adapter.close();
  });

  describe('election', () => {
    it('elects the only candidate', async () => {
      const only = peer('node-a', { interval: 1000, ttl: 30 });
      await only.start();

      expect(only.isLeader()).toBe(true);
    });

    it('elects exactly one of several candidates', async () => {
      const a = peer('node-a', { interval: 1000, ttl: 30 });
      const b = peer('node-b', { interval: 1000, ttl: 30 });
      const c = peer('node-c', { interval: 1000, ttl: 30 });

      await Promise.all([a.start(), b.start(), c.start()]);

      expect([a, b, c].filter(p => p.isLeader())).toHaveLength(1);
    });

    it('renews its own lease rather than standing down', async () => {
      const a = peer('node-a', { interval: 1000, ttl: 30 });
      await a.start();

      // Three more rounds through the same statement every node runs.
      for (let i = 0; i < 3; i++) {
        expect(await adapter.acquireLeadership('default', 'node-a', 30)).toBe(true);
      }

      expect(a.isLeader()).toBe(true);
    });

    it('reports the lease holder through getLeader', async () => {
      const a = peer('node-a', { interval: 1000, ttl: 30 });
      await a.start();

      const leader = await a.getLeader();
      expect(leader?.node).toBe('node-a');
      expect(leader?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('leaves an unexpired lease alone', async () => {
      const a = peer('node-a', { interval: 1000, ttl: 30 });
      await a.start();

      expect(await adapter.acquireLeadership('default', 'node-b', 30)).toBe(false);
      expect((await a.getLeader())?.node).toBe('node-a');
    });

    it('hands leadership to another node once the lease expires', async () => {
      const a = peer('node-a', { interval: 1000, ttl: 30 });
      await a.start();
      expect(a.isLeader()).toBe(true);

      // Standing in for a node that stopped renewing -- a crash, a partition,
      // a process wedged long enough to miss every renewal.
      db.prepare(`UPDATE izi_peers SET expires_at = datetime('now', '-1 minute')`).run();

      expect(await adapter.acquireLeadership('default', 'node-b', 30)).toBe(true);
      expect((await a.getLeader())?.node).toBe('node-b');
    });

    it('records when leadership changed hands, not when it was last renewed', async () => {
      await adapter.acquireLeadership('default', 'node-a', 30);
      const first = await adapter.getLeader('default');

      await adapter.acquireLeadership('default', 'node-a', 30);
      const renewed = await adapter.getLeader('default');
      expect(renewed?.electedAt.getTime()).toBe(first?.electedAt.getTime());

      db.prepare(`UPDATE izi_peers SET expires_at = datetime('now', '-1 minute'), elected_at = datetime('now', '-1 hour')`).run();
      await adapter.acquireLeadership('default', 'node-b', 30);
      const takeover = await adapter.getLeader('default');

      expect(takeover?.node).toBe('node-b');
      expect(takeover?.electedAt.getTime()).toBeGreaterThan(first!.electedAt.getTime() - 3600_000);
    });

    it('treats a lapsed lease as vacant', async () => {
      await adapter.acquireLeadership('default', 'node-a', 30);
      db.prepare(`UPDATE izi_peers SET expires_at = datetime('now', '-1 minute')`).run();

      expect(await adapter.getLeader('default')).toBeNull();
    });

    it('keeps separate scopes independent', async () => {
      const a = peer('node-a', { interval: 1000, ttl: 30, name: 'app' });
      const b = peer('node-b', { interval: 1000, ttl: 30, name: 'worker' });

      await a.start();
      await b.start();

      expect(a.isLeader()).toBe(true);
      expect(b.isLeader()).toBe(true);
    });
  });

  describe('stopping', () => {
    it('releases the lease so a successor takes over immediately', async () => {
      const a = peer('node-a', { interval: 1000, ttl: 300 });
      await a.start();
      await a.stop();

      expect(a.isLeader()).toBe(false);
      expect(await adapter.getLeader('default')).toBeNull();
      expect(await adapter.acquireLeadership('default', 'node-b', 30)).toBe(true);
    });

    it('does not release a lease held by another node', async () => {
      await adapter.acquireLeadership('default', 'node-a', 300);

      const b = peer('node-b', { interval: 1000, ttl: 300 });
      await b.start();
      expect(b.isLeader()).toBe(false);
      await b.stop();

      expect((await adapter.getLeader('default'))?.node).toBe('node-a');
    });

    it('ignores an election round that lands after stop', async () => {
      let release!: (value: boolean) => void;
      const slow = adapterWith(adapter, {
        acquireLeadership: () => new Promise<boolean>(resolve => { release = resolve; })
      });

      const a = new Peer(slow, 'node-a', { interval: 1000, ttl: 30 }, silentLogger);
      const starting = a.start();
      await a.stop();

      release(true);
      await starting;

      expect(a.isLeader()).toBe(false);
      // The renewal timer must not be installed after the fact either: nothing
      // would ever clear it, and it would hold the process open forever.
      expect((a as unknown as { timer?: unknown }).timer).toBeUndefined();
    });
  });

  describe('telemetry', () => {
    it('emits peer:elected on taking leadership', async () => {
      const events: TelemetryPayload[] = [];
      const unsubscribe = telemetry.on('peer:elected', p => events.push(p));

      const a = peer('node-a', { interval: 1000, ttl: 30 });
      await a.start();

      expect(events).toHaveLength(1);
      expect(events[0].node).toBe('node-a');

      unsubscribe();
    });

    it('emits peer:lost when standing down', async () => {
      const events: TelemetryPayload[] = [];
      const unsubscribe = telemetry.on('peer:lost', p => events.push(p));

      const a = peer('node-a', { interval: 1000, ttl: 30 });
      await a.start();
      await a.stop();

      expect(events).toHaveLength(1);
      expect(events[0].node).toBe('node-a');

      unsubscribe();
    });

    it('does not re-emit peer:elected while it keeps leading', async () => {
      const events: TelemetryPayload[] = [];
      const unsubscribe = telemetry.on('peer:elected', p => events.push(p));

      const a = peer('node-a', { interval: 1000, ttl: 30 });
      await a.start();
      await (a as unknown as { elect(): Promise<void> }).elect();
      await (a as unknown as { elect(): Promise<void> }).elect();

      expect(events).toHaveLength(1);

      unsubscribe();
    });
  });

  describe('failure handling', () => {
    it('stands down when it cannot prove it still holds the lease', async () => {
      const errors: TelemetryPayload[] = [];
      const unsubscribeError = telemetry.on('peer:error', p => errors.push(p));
      const lost: TelemetryPayload[] = [];
      const unsubscribeLost = telemetry.on('peer:lost', p => lost.push(p));

      let fail = false;
      const flaky = adapterWith(adapter, {
        acquireLeadership: async (name: string, node: string, ttl: number) => {
          if (fail) throw new Error('connection reset');
          return adapter.acquireLeadership(name, node, ttl);
        }
      });

      const a = new Peer(flaky, 'node-a', { interval: 1000, ttl: 30 }, silentLogger);
      await a.start();
      expect(a.isLeader()).toBe(true);

      fail = true;
      await (a as unknown as { elect(): Promise<void> }).elect();

      expect(a.isLeader()).toBe(false);
      expect(errors).toHaveLength(1);
      expect(lost).toHaveLength(1);

      unsubscribeError();
      unsubscribeLost();
      await a.stop();
    });

    it('re-takes leadership once the database recovers', async () => {
      let fail = true;
      const flaky = adapterWith(adapter, {
        acquireLeadership: async (name: string, node: string, ttl: number) => {
          if (fail) throw new Error('connection reset');
          return adapter.acquireLeadership(name, node, ttl);
        }
      });

      const a = new Peer(flaky, 'node-a', { interval: 1000, ttl: 30 }, silentLogger);
      await a.start();
      expect(a.isLeader()).toBe(false);

      fail = false;
      await (a as unknown as { elect(): Promise<void> }).elect();

      expect(a.isLeader()).toBe(true);
      await a.stop();
    });
  });

  describe('configuration', () => {
    it('leads unconditionally when leadership is disabled', async () => {
      const a = peer('node-a', false);
      const b = peer('node-b', false);

      await a.start();
      await b.start();

      expect(a.isLeader()).toBe(true);
      expect(b.isLeader()).toBe(true);
      expect(db.prepare('SELECT COUNT(*) AS n FROM izi_peers').get()).toEqual({ n: 0 });
    });

    it('leads unconditionally when the adapter cannot elect', async () => {
      const unsupported = adapterWith(adapter, { acquireLeadership: undefined });

      const a = new Peer(unsupported, 'node-a', { interval: 1000, ttl: 30 }, silentLogger);
      await a.start();

      expect(a.isEnabled).toBe(false);
      expect(a.isLeader()).toBe(true);
      await a.stop();
    });

    it('rejects an interval below a second', () => {
      expect(() => new Peer(adapter, 'node-a', { interval: 500 }, silentLogger)).toThrow(
        /interval must be at least 1000ms/
      );
    });

    it('rejects a lease that expires faster than it is renewed', () => {
      expect(() => new Peer(adapter, 'node-a', { interval: 20000, ttl: 30 }, silentLogger)).toThrow(
        /must be at least twice/
      );
    });
  });

  describe('renewal loop', () => {
    it('keeps the lease alive across ticks', async () => {
      const a = peer('node-a', { interval: 1000, ttl: 30 });
      await a.start();

      const first = await adapter.getLeader('default');

      const extended = await waitFor(
        async () => {
          const leader = await adapter.getLeader('default');
          return leader && leader.expiresAt.getTime() > first!.expiresAt.getTime() ? leader : null;
        },
        { timeout: 5000, describe: 'the lease to be renewed' }
      );

      expect(extended?.node).toBe('node-a');
      expect(a.isLeader()).toBe(true);
    });
  });
});
