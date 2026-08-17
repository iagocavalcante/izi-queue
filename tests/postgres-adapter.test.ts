import pg from 'pg';
import { randomBytes } from 'crypto';
import { waitFor } from './helpers/wait.js';
import { createPostgresAdapter, PostgresAdapter } from '../src/database/postgres.js';
import type { Job, Logger } from '../src/types.js';

/**
 * These tests need a real PostgreSQL server; the dialect differences that matter
 * (SKIP LOCKED, JSONB, ON CONFLICT, interval arithmetic) cannot be exercised
 * against SQLite. Set IZI_TEST_POSTGRES_URL to run them.
 *
 *   docker run -d --rm -e POSTGRES_PASSWORD=izi -e POSTGRES_DB=izi -p 55432:5432 postgres:16-alpine
 *   IZI_TEST_POSTGRES_URL=postgres://postgres:izi@localhost:55432/izi npm test
 */
const CONNECTION_STRING = process.env.IZI_TEST_POSTGRES_URL;
const describePostgres = CONNECTION_STRING ? describe : describe.skip;

function jobData(overrides: Partial<Omit<Job, 'id' | 'insertedAt'>> = {}): Omit<Job, 'id' | 'insertedAt'> {
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
    attemptedBy: null,
    uniqueKey: null,
    completedAt: null,
    discardedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

describePostgres('PostgresAdapter', () => {
  let pool: pg.Pool;
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: CONNECTION_STRING });
    adapter = createPostgresAdapter(pool);
    await adapter.migrate();
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS izi_jobs, izi_nodes, izi_migrations');
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE izi_jobs, izi_nodes');
  });

  it('applies every migration', async () => {
    const status = await adapter.getMigrationStatus();
    expect(status.length).toBeGreaterThan(0);
    expect(status.every((m) => m.applied)).toBe(true);
  });

  it('claims jobs and stamps the fetching node', async () => {
    await adapter.insertJob(jobData());

    const jobs = await adapter.fetchJobs('default', 5, 'node-a');

    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe('executing');
    expect(jobs[0].attempt).toBe(1);
    expect(jobs[0].attemptedBy).toBe('node-a');
  });

  it('orders claimed jobs by priority', async () => {
    await adapter.insertJob(jobData({ priority: 5, args: { order: 'last' } }));
    await adapter.insertJob(jobData({ priority: -5, args: { order: 'first' } }));

    const jobs = await adapter.fetchJobs('default', 2, 'node-a');

    expect((jobs[0].args as { order: string }).order).toBe('first');
  });

  it('stages both scheduled and retryable jobs once due', async () => {
    await pool.query(
      `INSERT INTO izi_jobs (state, queue, worker, args, scheduled_at)
       VALUES ('scheduled', 'default', 'W', '{}', NOW() - INTERVAL '1 second'),
              ('retryable', 'default', 'W', '{}', NOW() - INTERVAL '1 second'),
              ('retryable', 'default', 'W', '{}', NOW() + INTERVAL '1 hour')`
    );

    const staged = await adapter.stageJobs();

    expect(staged).toBe(2);
    const { rows } = await pool.query(
      `SELECT state, COUNT(*)::int AS count FROM izi_jobs GROUP BY state ORDER BY state`
    );
    expect(rows).toEqual([
      { state: 'available', count: 2 },
      { state: 'retryable', count: 1 },
    ]);
  });

  it('stages at most `limit` rows per call, leaving the rest for the next batch', async () => {
    for (let i = 0; i < 12; i++) {
      await pool.query(
        `INSERT INTO izi_jobs (state, queue, worker, args, scheduled_at)
         VALUES ('scheduled', 'default', 'W', '{}', NOW() - INTERVAL '1 minute')`
      );
    }
    await pool.query(
      `INSERT INTO izi_jobs (state, queue, worker, args, scheduled_at)
       VALUES ('scheduled', 'default', 'FutureW', '{}', NOW() + INTERVAL '1 hour')`
    );

    expect(await adapter.stageJobs(5)).toBe(5);
    expect(await adapter.stageJobs(5)).toBe(5);
    expect(await adapter.stageJobs(5)).toBe(2);
    expect(await adapter.stageJobs(5)).toBe(0);

    const { rows } = await pool.query(
      `SELECT state, COUNT(*)::int AS count FROM izi_jobs GROUP BY state ORDER BY state`
    );
    expect(rows).toEqual([
      { state: 'available', count: 12 },
      { state: 'scheduled', count: 1 },
    ]);
  });

  it('prunes only terminal jobs past the age cutoff', async () => {
    await pool.query(
      `INSERT INTO izi_jobs (state, queue, worker, args, completed_at)
       VALUES ('completed', 'default', 'W', '{}', NOW() - INTERVAL '2 hours')`
    );
    await adapter.insertJob(jobData());

    const pruned = await adapter.pruneJobs(3600);

    expect(pruned).toBe(1);
    const { rows } = await pool.query(
      `SELECT state, COUNT(*)::int AS count FROM izi_jobs GROUP BY state ORDER BY state`
    );
    expect(rows).toEqual([{ state: 'available', count: 1 }]);
  });

  it('deletes at most `limit` rows per call, leaving the rest for the next batch', async () => {
    for (let i = 0; i < 12; i++) {
      await pool.query(
        `INSERT INTO izi_jobs (state, queue, worker, args, completed_at)
         VALUES ('completed', 'default', 'W', '{}', NOW() - INTERVAL '2 hours')`
      );
    }
    await adapter.insertJob(jobData());

    expect(await adapter.pruneJobs(3600, 5)).toBe(5);
    expect(await adapter.pruneJobs(3600, 5)).toBe(5);
    expect(await adapter.pruneJobs(3600, 5)).toBe(2);
    expect(await adapter.pruneJobs(3600, 5)).toBe(0);

    const { rows } = await pool.query(
      `SELECT state, COUNT(*)::int AS count FROM izi_jobs GROUP BY state ORDER BY state`
    );
    expect(rows).toEqual([{ state: 'available', count: 1 }]);
  });

  it('rescues orphans but leaves jobs owned by a live node alone', async () => {
    await adapter.heartbeat('live-node');
    await pool.query(
      `INSERT INTO izi_jobs (state, queue, worker, args, attempt, max_attempts, attempted_at, attempted_by)
       VALUES ('executing', 'default', 'W', '{}', 1, 20, NOW() - INTERVAL '1 hour', 'live-node'),
              ('executing', 'default', 'W', '{}', 1, 20, NOW() - INTERVAL '1 hour', 'dead-node'),
              ('executing', 'default', 'W', '{}', 3, 3,  NOW() - INTERVAL '1 hour', 'dead-node'),
              ('executing', 'default', 'W', '{}', 1, 20, NOW() - INTERVAL '1 hour', NULL)`
    );

    const rescued = await adapter.rescueStuckJobs(300);

    expect(rescued).toBe(3);
    const { rows } = await pool.query(
      `SELECT state, COUNT(*)::int AS count FROM izi_jobs GROUP BY state ORDER BY state`
    );
    expect(rows).toEqual([
      { state: 'available', count: 2 },
      { state: 'discarded', count: 1 },
      { state: 'executing', count: 1 },
    ]);
  });

  it('treats a node with a stale heartbeat as dead', async () => {
    await adapter.heartbeat('stale-node');
    await pool.query(`UPDATE izi_nodes SET heartbeat_at = NOW() - INTERVAL '1 hour'`);
    await pool.query(
      `INSERT INTO izi_jobs (state, queue, worker, args, attempt, attempted_at, attempted_by)
       VALUES ('executing', 'default', 'W', '{}', 1, NOW() - INTERVAL '1 hour', 'stale-node')`
    );

    expect(await adapter.rescueStuckJobs(300)).toBe(1);
  });

  it('upserts a single row per node and removes it on deregistration', async () => {
    await adapter.heartbeat('node-a');
    await adapter.heartbeat('node-a');

    const { rows } = await pool.query('SELECT name FROM izi_nodes');
    expect(rows).toHaveLength(1);

    await adapter.removeNode('node-a');
    const after = await pool.query('SELECT name FROM izi_nodes');
    expect(after.rows).toHaveLength(0);
  });

  describe('listJobs', () => {
    it('filters by queue, worker, state, and ids', async () => {
      const a = await adapter.insertJob(jobData({ queue: 'default', worker: 'WorkerA', state: 'available' }));
      await adapter.insertJob(jobData({ queue: 'other', worker: 'WorkerB', state: 'completed' }));

      expect(await adapter.listJobs({ queue: 'default' })).toHaveLength(1);
      expect(await adapter.listJobs({ worker: 'WorkerA' })).toHaveLength(1);
      expect(await adapter.listJobs({ state: ['completed'] })).toHaveLength(1);
      expect((await adapter.listJobs({ ids: [a.id] }))[0].id).toBe(a.id);
    });

    it('matches tags with array-overlap (match-any) semantics', async () => {
      await adapter.insertJob(jobData({ tags: ['billing'] }));
      await adapter.insertJob(jobData({ tags: ['urgent'] }));
      await adapter.insertJob(jobData({ tags: ['other'] }));
      await adapter.insertJob(jobData({ tags: [] }));

      const jobs = await adapter.listJobs({ tags: ['billing', 'urgent'] });

      expect(jobs).toHaveLength(2);
      expect(jobs.map((j) => j.tags).sort()).toEqual([['billing'], ['urgent']]);
    });

    it('combines multiple criteria with AND', async () => {
      await adapter.insertJob(jobData({ queue: 'default', worker: 'WorkerA' }));
      await adapter.insertJob(jobData({ queue: 'default', worker: 'WorkerB' }));

      expect(await adapter.listJobs({ queue: 'default', worker: 'WorkerA' })).toHaveLength(1);
    });

    it('orders by insertedAt desc by default', async () => {
      const first = await adapter.insertJob(jobData({ args: { order: 1 } }));
      await pool.query(`UPDATE izi_jobs SET inserted_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [first.id]);
      const second = await adapter.insertJob(jobData({ args: { order: 2 } }));

      const jobs = await adapter.listJobs({});

      expect(jobs.map((j) => j.id)).toEqual([second.id, first.id]);
    });

    it('orders by a whitelisted field and direction', async () => {
      await adapter.insertJob(jobData({ priority: 5 }));
      await adapter.insertJob(jobData({ priority: 1 }));
      await adapter.insertJob(jobData({ priority: 3 }));

      const jobs = await adapter.listJobs({ orderBy: { field: 'priority', direction: 'asc' } });

      expect(jobs.map((j) => j.priority)).toEqual([1, 3, 5]);
    });

    it('rejects an orderBy field outside the whitelist', async () => {
      await expect(
        adapter.listJobs({ orderBy: { field: 'args' as never, direction: 'asc' } })
      ).rejects.toThrow(/invalid listJobs orderBy\.field/);
    });

    it('applies limit and offset for pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.insertJob(jobData({ priority: i }));
      }

      const page1 = await adapter.listJobs({ limit: 2, offset: 0, orderBy: { field: 'priority', direction: 'asc' } });
      const page2 = await adapter.listJobs({ limit: 2, offset: 2, orderBy: { field: 'priority', direction: 'asc' } });

      expect(page1.map((j) => j.priority)).toEqual([0, 1]);
      expect(page2.map((j) => j.priority)).toEqual([2, 3]);
    });

    it('returns full Job objects shaped like getJob', async () => {
      const inserted = await adapter.insertJob(jobData({ args: { a: 1 }, meta: { b: 2 } }));

      const [job] = await adapter.listJobs({ ids: [inserted.id] });
      const viaGetJob = await adapter.getJob(inserted.id);

      expect(job).toEqual(viaGetJob);
    });
  });

  describe('countJobs', () => {
    it('groups counts by state, with every state present even at zero', async () => {
      await adapter.insertJob(jobData({ state: 'available' }));
      await adapter.insertJob(jobData({ state: 'available' }));
      await adapter.insertJob(jobData({ state: 'completed' }));

      const counts = await adapter.countJobs({});

      expect(counts).toEqual({
        scheduled: 0,
        available: 2,
        executing: 0,
        retryable: 0,
        completed: 1,
        discarded: 0,
        cancelled: 0
      });
    });

    it('applies criteria before grouping, including tags with the same match-any semantics as listJobs', async () => {
      await adapter.insertJob(jobData({ queue: 'default', tags: ['billing'], state: 'available' }));
      await adapter.insertJob(jobData({ queue: 'default', tags: ['other'], state: 'available' }));
      await adapter.insertJob(jobData({ queue: 'other', tags: ['billing'], state: 'available' }));

      const counts = await adapter.countJobs({ queue: 'default', tags: ['billing'] });

      expect(counts.available).toBe(1);
    });
  });

  describe('unique jobs', () => {
    const unique = { period: 60 };

    it('inserts only one job when many nodes race on the same unique job', async () => {
      // The real failure mode: concurrent inserts on separate connections, each
      // seeing "no conflict" before any of them has committed.
      const attempts = 20;
      const results = await Promise.all(
        Array.from({ length: attempts }, () =>
          adapter.insertUnique(jobData({ args: { userId: 7 } }), unique)
        )
      );

      const inserted = results.filter((r) => !r.conflict);
      const conflicted = results.filter((r) => r.conflict);

      expect(inserted).toHaveLength(1);
      expect(conflicted).toHaveLength(attempts - 1);

      const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM izi_jobs');
      expect(rows[0].count).toBe(1);

      // Every caller gets a usable job back, and they all point at the same row.
      const ids = new Set(results.map((r) => r.job.id));
      expect(ids.size).toBe(1);
    });

    it('does not conflate distinct unique jobs inserted concurrently', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          adapter.insertUnique(jobData({ args: { userId: i } }), unique)
        )
      );

      expect(results.filter((r) => r.conflict)).toHaveLength(0);
      const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM izi_jobs');
      expect(rows[0].count).toBe(10);
    });

    it('treats args differing only in key order as the same job', async () => {
      const first = await adapter.insertUnique(jobData({ args: { a: 1, b: 2 } }), unique);
      const second = await adapter.insertUnique(jobData({ args: { b: 2, a: 1 } }), unique);

      expect(first.conflict).toBe(false);
      expect(second.conflict).toBe(true);
      expect(second.job.id).toBe(first.job.id);
    });

    it('ignores jobs outside the uniqueness period', async () => {
      const first = await adapter.insertUnique(jobData({ args: { userId: 1 } }), unique);
      await pool.query(`UPDATE izi_jobs SET inserted_at = NOW() - INTERVAL '1 hour'`);

      const second = await adapter.insertUnique(jobData({ args: { userId: 1 } }), unique);

      expect(second.conflict).toBe(false);
      expect(second.job.id).not.toBe(first.job.id);
    });

    it('ignores jobs in states outside the configured set', async () => {
      await adapter.insertUnique(jobData({ args: { userId: 1 } }), unique);
      await pool.query(`UPDATE izi_jobs SET state = 'completed'`);

      const second = await adapter.insertUnique(jobData({ args: { userId: 1 } }), unique);

      expect(second.conflict).toBe(false);
    });

    it('accepts payloads far larger than a btree index entry', async () => {
      // Incompressible, so it cannot slip under the limit by being TOASTed.
      const blob = randomBytes(4000).toString('base64');

      const result = await adapter.insertUnique(jobData({ args: { blob } }), unique);

      expect(result.conflict).toBe(false);
      expect(((await adapter.getJob(result.job.id))?.args as { blob: string }).blob).toHaveLength(
        blob.length
      );
    });

    it('accepts a large payload on a plain insert too', async () => {
      const blob = randomBytes(4000).toString('base64');

      const job = await adapter.insertJob(jobData({ args: { blob } }));

      expect(job.id).toBeGreaterThan(0);
    });
  });

  describe('concurrent migrations', () => {
    it('lets several nodes migrate at once without failing', async () => {
      await pool.query('DROP TABLE IF EXISTS izi_jobs, izi_nodes, izi_migrations');

      const pools = Array.from({ length: 4 }, () => new pg.Pool({ connectionString: CONNECTION_STRING }));
      try {
        const results = await Promise.allSettled(
          pools.map((p) => createPostgresAdapter(p).migrate())
        );

        const rejected = results.filter((r) => r.status === 'rejected');
        expect(rejected).toHaveLength(0);

        const { rows } = await pool.query('SELECT version FROM izi_migrations ORDER BY version');
        const versions = rows.map((r) => Number(r.version));
        expect(new Set(versions).size).toBe(versions.length);
      } finally {
        await Promise.all(pools.map((p) => p.end()));
      }
    });
  });

  describe('transactional insert', () => {
    it('discards the job when the caller rolls back', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await adapter.insertJob(jobData({ args: { orderId: 1 } }), client);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM izi_jobs');
      expect(rows[0].count).toBe(0);
    });

    it('keeps the job when the caller commits', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await adapter.insertJob(jobData({ args: { orderId: 1 } }), client);
        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM izi_jobs');
      expect(rows[0].count).toBe(1);
    });

    it('does not make the job visible to other connections before commit', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await adapter.insertJob(jobData(), client);

        // A worker on another connection must not be able to claim it yet.
        const claimedEarly = await adapter.fetchJobs('default', 5, 'node-a');
        expect(claimedEarly).toHaveLength(0);

        await client.query('COMMIT');
      } finally {
        client.release();
      }

      const claimedAfter = await adapter.fetchJobs('default', 5, 'node-a');
      expect(claimedAfter).toHaveLength(1);
    });

    it('holds the wake-up notification until commit', async () => {
      const listener = await pool.connect();
      const received: string[] = [];
      try {
        await listener.query('LISTEN izi_jobs_insert');
        listener.on('notification', msg => received.push(msg.payload ?? ''));

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await adapter.insertJob(jobData(), client);
          await adapter.notify('default', client);

          // PostgreSQL defers NOTIFY until commit, which is exactly what is
          // wanted: waking a worker early sends it looking for an invisible row.
          await new Promise(resolve => setTimeout(resolve, 150));
          expect(received).toHaveLength(0);

          await client.query('COMMIT');
        } finally {
          client.release();
        }

        await new Promise(resolve => setTimeout(resolve, 250));
        expect(received.length).toBeGreaterThan(0);
      } finally {
        await listener.query('UNLISTEN izi_jobs_insert');
        listener.release();
      }
    });

    it('drops the notification entirely when the caller rolls back', async () => {
      const listener = await pool.connect();
      const received: string[] = [];
      try {
        await listener.query('LISTEN izi_jobs_insert');
        listener.on('notification', msg => received.push(msg.payload ?? ''));

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await adapter.insertJob(jobData(), client);
          await adapter.notify('default', client);
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }

        await new Promise(resolve => setTimeout(resolve, 250));
        expect(received).toHaveLength(0);
      } finally {
        await listener.query('UNLISTEN izi_jobs_insert');
        listener.release();
      }
    });

    it('rolls a unique job back with its transaction, leaving no phantom conflict', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await adapter.insertUnique(jobData({ args: { userId: 1 } }), { period: 60 }, client);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      const after = await adapter.insertUnique(jobData({ args: { userId: 1 } }), { period: 60 });
      expect(after.conflict).toBe(false);
    });

    it('still deduplicates unique jobs inside a transaction', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const first = await adapter.insertUnique(jobData({ args: { userId: 1 } }), { period: 60 }, client);
        const second = await adapter.insertUnique(jobData({ args: { userId: 1 } }), { period: 60 }, client);
        await client.query('COMMIT');

        expect(first.conflict).toBe(false);
        expect(second.conflict).toBe(true);
      } finally {
        client.release();
      }

      const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM izi_jobs');
      expect(rows[0].count).toBe(1);
    });
  });

  describe('listener resilience', () => {
    it('re-subscribes after its connection is dropped', async () => {
      const listenerAdapter = createPostgresAdapter(new pg.Pool({ connectionString: CONNECTION_STRING }));
      const received: string[] = [];

      try {
        await listenerAdapter.listen(({ queue }) => received.push(queue));

        // Sanity: notifications arrive before anything is broken.
        await adapter.notify('before');
        await waitFor(() => received.includes('before'), {
          describe: 'the first notification',
        });

        // Kill the listener's backend from another connection, the way a
        // failover, an idle-connection reaper or a network blip would.
        const { rows } = await pool.query(
          `SELECT pid FROM pg_stat_activity
           WHERE query LIKE 'LISTEN%' AND pid <> pg_backend_pid()`
        );
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          await pool.query('SELECT pg_terminate_backend($1)', [row.pid]);
        }

        // Without re-subscribing, notifications are silently lost from here on
        // and the queue degrades to poll-only with no indication.
        await waitFor(
          async () => {
            await adapter.notify('after');
            return received.includes('after');
          },
          { timeout: 20000, interval: 500, describe: 'notifications to resume' }
        );

        expect(received).toContain('after');
      } finally {
        await listenerAdapter.close().catch(() => {});
      }
    }, 40000);
  });

  describe('logging (#40)', () => {
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

    it('routes migration progress through an injected logger instead of console.log', async () => {
      await pool.query('DROP TABLE IF EXISTS izi_jobs, izi_nodes, izi_migrations');

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const logger = createMockLogger();
      const migratePool = new pg.Pool({ connectionString: CONNECTION_STRING });

      try {
        await createPostgresAdapter(migratePool, logger).migrate();

        expect(logger.info).toHaveBeenCalledWith(
          'Applying migration',
          expect.objectContaining({ version: expect.any(Number), name: expect.any(String) })
        );
        expect(logSpy).not.toHaveBeenCalled();
      } finally {
        await migratePool.end();
        logSpy.mockRestore();
      }
    });

    it('routes a pool error to logger.error, reconnect attempts to logger.debug, and recovery to logger.info', async () => {
      const logger = createMockLogger();
      const reconnectPool = new pg.Pool({ connectionString: CONNECTION_STRING });
      // One adapter for the whole test: PostgresAdapter registers its pool
      // 'error' listener in the constructor, so a second instance on the same
      // pool would double up the handler and the assertions below.
      const reconnectAdapter = createPostgresAdapter(reconnectPool, logger);
      await reconnectAdapter.migrate();
      logger.info.mockClear();

      try {
        // Simulates a dropped connection the way the underlying `pg` driver
        // itself would report one -- the pool is otherwise healthy, so the
        // adapter's first reconnect attempt succeeds immediately.
        reconnectPool.emit('error', new Error('simulated connection loss'));

        expect(logger.error).toHaveBeenCalledWith(
          'PostgreSQL pool error',
          expect.objectContaining({ error: 'simulated connection loss' })
        );

        await waitFor(() => logger.info.mock.calls.length > 0, {
          describe: 'the reconnect to report success via logger.info',
          timeout: 15000
        });

        expect(logger.debug).toHaveBeenCalledWith(
          'Attempting to reconnect',
          expect.objectContaining({ attempt: 1, maxAttempts: expect.any(Number) })
        );
        expect(logger.info).toHaveBeenCalledWith('Reconnected successfully');

        // Reconnect-progress logging is debug-level so a console-backed
        // logger stays quiet under repeated attempts; only the pool error and
        // final outcome are console.error/console.log by default.
        expect(logger.error).toHaveBeenCalledTimes(1);
      } finally {
        await reconnectPool.end();
      }
    }, 20000);
  });
});
