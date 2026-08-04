import mysql from 'mysql2/promise';
import { createMySQLAdapter, MySQLAdapter } from '../src/database/mysql.js';
import type { Job } from '../src/types.js';

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

  it('detects a duplicate unique job', async () => {
    await adapter.insertJob(jobData({ args: { userId: 1 } }));

    const conflict = await adapter.checkUnique({ period: 60 }, jobData({ args: { userId: 1 } }));
    const distinct = await adapter.checkUnique({ period: 60 }, jobData({ args: { userId: 2 } }));

    expect(conflict).not.toBeNull();
    expect(distinct).toBeNull();
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
});
