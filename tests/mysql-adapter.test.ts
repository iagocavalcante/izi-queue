import mysql from 'mysql2/promise';
import { createMySQLAdapter, MySQLAdapter, INSERT_JOBS_CHUNK_SIZE } from '../src/database/mysql.js';
import type { BulkJobInsert, Job } from '../src/types.js';

/**
 * These tests need a real MySQL server (8.0.1+ for FOR UPDATE SKIP LOCKED).
 * Set IZI_TEST_MYSQL_URL to run them.
 *
 *   docker run -d --rm -e MYSQL_ROOT_PASSWORD=izi -e MYSQL_DATABASE=izi \
 *     -p 33306:3306 mysql:8
 *   IZI_TEST_MYSQL_URL=mysql://root:izi@localhost:33306/izi npm test
 */
const CONNECTION_STRING = process.env.IZI_TEST_MYSQL_URL;
const describeMySQL = CONNECTION_STRING ? describe : describe.skip;

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

describeMySQL('MySQLAdapter', () => {
  let pool: mysql.Pool;
  let adapter: MySQLAdapter;

  beforeAll(async () => {
    // `timezone: 'Z'` keeps JS Dates and the server's NOW() on the same clock;
    // scheduled_at is a TIMESTAMP and is otherwise interpreted in local time.
    pool = mysql.createPool({ uri: CONNECTION_STRING, timezone: 'Z' });
    adapter = createMySQLAdapter(pool as never);
    await adapter.migrate();
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS izi_jobs, izi_nodes, izi_migrations');
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM izi_jobs');
    await pool.query('DELETE FROM izi_nodes');
  });

  async function countByState(): Promise<Record<string, number>> {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT state, COUNT(*) AS count FROM izi_jobs GROUP BY state'
    );
    return Object.fromEntries(rows.map((r) => [r.state as string, Number(r.count)]));
  }

  it('applies every migration', async () => {
    const status = await adapter.getMigrationStatus();
    expect(status.length).toBeGreaterThan(0);
    expect(status.every((m) => m.applied)).toBe(true);
  });

  it('round-trips a job through insert and read', async () => {
    const inserted = await adapter.insertJob(
      jobData({
        args: { userId: 123, nested: { deep: true } },
        meta: { source: 'api' },
        tags: ['urgent', 'email'],
        priority: -5,
        maxAttempts: 3,
      })
    );

    const job = await adapter.getJob(inserted.id);

    expect(job?.args).toEqual({ userId: 123, nested: { deep: true } });
    expect(job?.meta).toEqual({ source: 'api' });
    expect(job?.tags).toEqual(['urgent', 'email']);
    expect(job?.priority).toBe(-5);
    expect(job?.maxAttempts).toBe(3);
  });

  it('claims jobs and stamps the fetching node', async () => {
    await adapter.insertJob(jobData());

    const jobs = await adapter.fetchJobs('default', 5, 'node-a');

    expect(jobs).toHaveLength(1);
    expect(jobs[0].state).toBe('executing');
    expect(jobs[0].attempt).toBe(1);
    expect(jobs[0].attemptedBy).toBe('node-a');
  });

  it('claims no more than the requested limit', async () => {
    for (let i = 0; i < 5; i++) await adapter.insertJob(jobData());

    const jobs = await adapter.fetchJobs('default', 2, 'node-a');

    expect(jobs).toHaveLength(2);
    expect(await countByState()).toEqual({ available: 3, executing: 2 });
  });

  it('orders claimed jobs by priority', async () => {
    await adapter.insertJob(jobData({ priority: 5, args: { order: 'last' } }));
    await adapter.insertJob(jobData({ priority: -5, args: { order: 'first' } }));

    const jobs = await adapter.fetchJobs('default', 2, 'node-a');

    expect((jobs[0].args as { order: string }).order).toBe('first');
  });

  it('stages both scheduled and retryable jobs once due', async () => {
    await pool.query(
      `INSERT INTO izi_jobs (state, queue, worker, args, meta, tags, errors, scheduled_at)
       VALUES ('scheduled', 'default', 'W', '{}', '{}', '[]', '[]', NOW() - INTERVAL 1 SECOND),
              ('retryable', 'default', 'W', '{}', '{}', '[]', '[]', NOW() - INTERVAL 1 SECOND),
              ('retryable', 'default', 'W', '{}', '{}', '[]', '[]', NOW() + INTERVAL 1 HOUR)`
    );

    const staged = await adapter.stageJobs();

    expect(staged).toBe(2);
    expect(await countByState()).toEqual({ available: 2, retryable: 1 });
  });

  it('stages at most `limit` rows per call, leaving the rest for the next batch', async () => {
    for (let i = 0; i < 12; i++) {
      await pool.query(
        `INSERT INTO izi_jobs (state, queue, worker, args, meta, tags, errors, scheduled_at)
         VALUES ('scheduled', 'default', 'W', '{}', '{}', '[]', '[]', NOW() - INTERVAL 1 MINUTE)`
      );
    }
    await pool.query(
      `INSERT INTO izi_jobs (state, queue, worker, args, meta, tags, errors, scheduled_at)
       VALUES ('scheduled', 'default', 'FutureW', '{}', '{}', '[]', '[]', NOW() + INTERVAL 1 HOUR)`
    );

    expect(await adapter.stageJobs(5)).toBe(5);
    expect(await adapter.stageJobs(5)).toBe(5);
    expect(await adapter.stageJobs(5)).toBe(2);
    expect(await adapter.stageJobs(5)).toBe(0);

    expect(await countByState()).toEqual({ available: 12, scheduled: 1 });
  });

  it('updates a job and preserves untouched columns', async () => {
    const job = await adapter.insertJob(jobData({ args: { keep: true } }));

    const updated = await adapter.updateJob(job.id, {
      state: 'completed',
      completedAt: new Date(),
    });

    expect(updated?.state).toBe('completed');
    expect(updated?.args).toEqual({ keep: true });
    expect(updated?.completedAt).toBeInstanceOf(Date);
  });

  it('rescues orphans but leaves jobs owned by a live node alone', async () => {
    await adapter.heartbeat('live-node');
    await pool.query(
      `INSERT INTO izi_jobs (state, queue, worker, args, meta, tags, errors, attempt, max_attempts, attempted_at, attempted_by)
       VALUES ('executing', 'default', 'W', '{}', '{}', '[]', '[]', 1, 20, NOW() - INTERVAL 1 HOUR, 'live-node'),
              ('executing', 'default', 'W', '{}', '{}', '[]', '[]', 1, 20, NOW() - INTERVAL 1 HOUR, 'dead-node'),
              ('executing', 'default', 'W', '{}', '{}', '[]', '[]', 3, 3,  NOW() - INTERVAL 1 HOUR, 'dead-node'),
              ('executing', 'default', 'W', '{}', '{}', '[]', '[]', 1, 20, NOW() - INTERVAL 1 HOUR, NULL)`
    );

    const rescued = await adapter.rescueStuckJobs(300);

    expect(rescued).toBe(3);
    expect(await countByState()).toEqual({ available: 2, discarded: 1, executing: 1 });
  });

  it('treats a node with a stale heartbeat as dead', async () => {
    await adapter.heartbeat('stale-node');
    await pool.query('UPDATE izi_nodes SET heartbeat_at = NOW() - INTERVAL 1 HOUR');
    await pool.query(
      `INSERT INTO izi_jobs (state, queue, worker, args, meta, tags, errors, attempt, attempted_at, attempted_by)
       VALUES ('executing', 'default', 'W', '{}', '{}', '[]', '[]', 1, NOW() - INTERVAL 1 HOUR, 'stale-node')`
    );

    expect(await adapter.rescueStuckJobs(300)).toBe(1);
  });

  it('does not rescue a job still inside the rescue window', async () => {
    await pool.query(
      `INSERT INTO izi_jobs (state, queue, worker, args, meta, tags, errors, attempt, attempted_at, attempted_by)
       VALUES ('executing', 'default', 'W', '{}', '{}', '[]', '[]', 1, NOW() - INTERVAL 10 SECOND, 'dead-node')`
    );

    expect(await adapter.rescueStuckJobs(300)).toBe(0);
  });

  it('upserts a single row per node and removes it on deregistration', async () => {
    await adapter.heartbeat('node-a');
    await adapter.heartbeat('node-a');

    const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT name FROM izi_nodes');
    expect(rows).toHaveLength(1);

    await adapter.removeNode('node-a');
    const [after] = await pool.query<mysql.RowDataPacket[]>('SELECT name FROM izi_nodes');
    expect(after).toHaveLength(0);
  });

  it('cancels jobs by criteria without touching terminal ones', async () => {
    await adapter.insertJob(jobData({ worker: 'A' }));
    await adapter.insertJob(jobData({ worker: 'B' }));
    await adapter.insertJob(jobData({ worker: 'A', state: 'completed' }));

    const cancelled = await adapter.cancelJobs({ worker: 'A' });

    expect(cancelled).toBe(1);
    expect(await countByState()).toEqual({ available: 1, cancelled: 1, completed: 1 });
  });

  it('does not unique-track jobs inserted without unique options', async () => {
    // Deliberate: uniqueness is a property of how a job was enqueued, so a
    // plain insert carries no key and cannot conflict with a later one.
    await adapter.insertJob(jobData({ args: { userId: 1 } }));

    const result = await adapter.insertUnique(jobData({ args: { userId: 1 } }), { period: 60 });

    expect(result.conflict).toBe(false);
  });

  it('prunes only terminal jobs past the age cutoff', async () => {
    await pool.query(
      `INSERT INTO izi_jobs (state, queue, worker, args, meta, tags, errors, completed_at)
       VALUES ('completed', 'default', 'W', '{}', '{}', '[]', '[]', NOW() - INTERVAL 2 HOUR)`
    );
    await adapter.insertJob(jobData());

    const pruned = await adapter.pruneJobs(3600);

    expect(pruned).toBe(1);
    expect(await countByState()).toEqual({ available: 1 });
  });

  it('deletes at most `limit` rows per call, leaving the rest for the next batch', async () => {
    for (let i = 0; i < 12; i++) {
      await pool.query(
        `INSERT INTO izi_jobs (state, queue, worker, args, meta, tags, errors, completed_at)
         VALUES ('completed', 'default', 'W', '{}', '{}', '[]', '[]', NOW() - INTERVAL 2 HOUR)`
      );
    }
    await adapter.insertJob(jobData());

    expect(await adapter.pruneJobs(3600, 5)).toBe(5);
    expect(await adapter.pruneJobs(3600, 5)).toBe(5);
    expect(await adapter.pruneJobs(3600, 5)).toBe(2);
    expect(await adapter.pruneJobs(3600, 5)).toBe(0);

    expect(await countByState()).toEqual({ available: 1 });
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

    it('matches tags with JSON_OVERLAPS (match-any) semantics, identical to Postgres', async () => {
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
      await pool.query('UPDATE izi_jobs SET inserted_at = NOW(6) - INTERVAL 1 MINUTE WHERE id = ?', [first.id]);
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
      const attempts = 15;
      const results = await Promise.all(
        Array.from({ length: attempts }, () =>
          adapter.insertUnique(jobData({ args: { userId: 7 } }), unique)
        )
      );

      expect(results.filter((r) => !r.conflict)).toHaveLength(1);
      expect(results.filter((r) => r.conflict)).toHaveLength(attempts - 1);
      expect(new Set(results.map((r) => r.job.id)).size).toBe(1);

      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS c FROM izi_jobs');
      expect(Number(rows[0].c)).toBe(1);
    });

    it('does not conflate distinct unique jobs inserted concurrently', async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          adapter.insertUnique(jobData({ args: { userId: i } }), unique)
        )
      );

      expect(results.filter((r) => r.conflict)).toHaveLength(0);
      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS c FROM izi_jobs');
      expect(Number(rows[0].c)).toBe(10);
    });

    it('treats args differing only in key order as the same job', async () => {
      const first = await adapter.insertUnique(jobData({ args: { a: 1, b: 2 } }), unique);
      const second = await adapter.insertUnique(jobData({ args: { b: 2, a: 1 } }), unique);

      expect(first.conflict).toBe(false);
      expect(second.conflict).toBe(true);
      expect(second.job.id).toBe(first.job.id);
    });

    it('ignores jobs outside the uniqueness period', async () => {
      await adapter.insertUnique(jobData({ args: { userId: 1 } }), unique);
      await pool.query('UPDATE izi_jobs SET inserted_at = NOW() - INTERVAL 1 HOUR');

      const second = await adapter.insertUnique(jobData({ args: { userId: 1 } }), unique);

      expect(second.conflict).toBe(false);
    });
  });

  describe('insertJobs', () => {
    it('returns an empty array for an empty batch', async () => {
      expect(await adapter.insertJobs([])).toEqual([]);
    });

    it('inserts every job in one call, in order', async () => {
      const entries: BulkJobInsert[] = [
        { job: jobData({ args: { id: 1 } }) },
        { job: jobData({ args: { id: 2 } }) },
        { job: jobData({ args: { id: 3 } }) },
      ];

      const results = await adapter.insertJobs(entries);

      expect(results.map((r) => r.conflict)).toEqual([false, false, false]);
      expect(results.map((r) => (r.job.args as { id: number }).id)).toEqual([1, 2, 3]);

      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS c FROM izi_jobs');
      expect(Number(rows[0].c)).toBe(3);
    });

    it('round-trips a batch spanning multiple chunks, recovering ids by range', async () => {
      // One row past two full chunks, to prove the chunk boundary itself does
      // not drop or misorder a row, and that the id-range recovery lines up
      // with the VALUES order across statements.
      const total = INSERT_JOBS_CHUNK_SIZE * 2 + 1;
      const entries: BulkJobInsert[] = Array.from({ length: total }, (_, i) => ({
        job: jobData({ args: { i } }),
      }));

      const results = await adapter.insertJobs(entries);

      expect(results).toHaveLength(total);
      expect(results.map((r) => (r.job.args as { i: number }).i)).toEqual(
        Array.from({ length: total }, (_, i) => i)
      );

      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS c FROM izi_jobs');
      expect(Number(rows[0].c)).toBe(total);
    }, 60000);

    it('checks a unique entry against a pre-existing row and reports a conflict', async () => {
      const existing = await adapter.insertUnique(
        jobData({ worker: 'UniqueWorker', args: { userId: 1 } }),
        { period: 60 }
      );

      const results = await adapter.insertJobs([
        { job: jobData({ args: { plain: true } }) },
        { job: jobData({ worker: 'UniqueWorker', args: { userId: 1 } }), unique: { period: 60 } },
      ]);

      expect(results[0].conflict).toBe(false);
      expect(results[1].conflict).toBe(true);
      expect(results[1].job.id).toBe(existing.job.id);

      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS c FROM izi_jobs');
      expect(Number(rows[0].c)).toBe(2);
    });

    it('does not conflate distinct unique entries inserted in the same batch', async () => {
      const results = await adapter.insertJobs([
        { job: jobData({ worker: 'UniqueWorker', args: { userId: 1 } }), unique: { period: 60 } },
        { job: jobData({ worker: 'UniqueWorker', args: { userId: 2 } }), unique: { period: 60 } },
      ]);

      expect(results.every((r) => !r.conflict)).toBe(true);
      expect(results[0].job.id).not.toBe(results[1].job.id);
    });

    it('rolls back the whole batch when a later statement fails', async () => {
      const entries: BulkJobInsert[] = [
        { job: jobData({ args: { id: 1 } }) },
        { job: jobData({ worker: 'UniqueWorker', args: { userId: 1 } }), unique: { period: 60 } },
        // A circular reference cannot be JSON.stringify'd, so this fails
        // while the third statement is being built -- after the first two
        // have already been written inside the (uncommitted) transaction.
        { job: jobData({ args: (() => { const a: Record<string, unknown> = {}; a.self = a; return a; })() }) },
      ];

      await expect(adapter.insertJobs(entries)).rejects.toThrow();

      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS c FROM izi_jobs');
      expect(Number(rows[0].c)).toBe(0);
    });

    it('commits together with the caller-supplied transaction (no unique entries)', async () => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const results = await adapter.insertJobs(
          [{ job: jobData({ args: { id: 1 } }) }, { job: jobData({ args: { id: 2 } }) }],
          conn
        );
        expect(results).toHaveLength(2);
        await conn.commit();
      } finally {
        conn.release();
      }

      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS c FROM izi_jobs');
      expect(Number(rows[0].c)).toBe(2);
    });

    it('rolls back together with the caller-supplied transaction (no unique entries)', async () => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await adapter.insertJobs(
          [{ job: jobData({ args: { id: 1 } }) }, { job: jobData({ args: { id: 2 } }) }],
          conn
        );
        await conn.rollback();
      } finally {
        conn.release();
      }

      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS c FROM izi_jobs');
      expect(Number(rows[0].c)).toBe(0);
    });

    it('refuses a batch with a unique entry inside a caller transaction', async () => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await expect(
          adapter.insertJobs(
            [{ job: jobData({ args: { userId: 1 } }), unique: { period: 60 } }],
            conn
          )
        ).rejects.toThrow(/unique/i);
        await conn.rollback();
      } finally {
        conn.release();
      }
    });
  });

  describe('concurrent migrations', () => {
    it('lets several nodes migrate at once without failing', async () => {
      await pool.query('DROP TABLE IF EXISTS izi_jobs, izi_nodes, izi_migrations');

      const pools = Array.from({ length: 4 }, () =>
        mysql.createPool({ uri: CONNECTION_STRING, timezone: 'Z' })
      );
      try {
        const results = await Promise.allSettled(
          pools.map((p) => createMySQLAdapter(p as never).migrate())
        );

        expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);

        const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT version FROM izi_migrations');
        const versions = rows.map((r) => Number(r.version));
        expect(new Set(versions).size).toBe(versions.length);
      } finally {
        await Promise.all(pools.map((p) => p.end()));
      }
    });
  });

  describe('transactional insert', () => {
    it('discards the job when the caller rolls back', async () => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await adapter.insertJob(jobData({ args: { orderId: 1 } }), conn);
        await conn.rollback();
      } finally {
        conn.release();
      }

      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS c FROM izi_jobs');
      expect(Number(rows[0].c)).toBe(0);
    });

    it('keeps the job when the caller commits', async () => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await adapter.insertJob(jobData({ args: { orderId: 1 } }), conn);
        await conn.commit();
      } finally {
        conn.release();
      }

      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS c FROM izi_jobs');
      expect(Number(rows[0].c)).toBe(1);
    });

    it('does not make the job visible to other connections before commit', async () => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await adapter.insertJob(jobData(), conn);

        expect(await adapter.fetchJobs('default', 5, 'node-a')).toHaveLength(0);

        await conn.commit();
      } finally {
        conn.release();
      }

      expect(await adapter.fetchJobs('default', 5, 'node-a')).toHaveLength(1);
    });

    it('refuses a unique insert inside a caller transaction rather than weakening the guarantee', async () => {
      // GET_LOCK is connection-scoped and not transactional, so it cannot be
      // held across the caller's commit. Releasing it at insert time would let
      // a concurrent node insert a duplicate -- exactly the race that was fixed
      // for the non-transactional path. Refusing is honest; silently degrading
      // is not.
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await expect(
          adapter.insertUnique(jobData({ args: { userId: 1 } }), { period: 60 }, conn)
        ).rejects.toThrow(/unique/i);
        await conn.rollback();
      } finally {
        conn.release();
      }
    });
  });
});
