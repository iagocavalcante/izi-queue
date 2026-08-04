import pg from 'pg';
import { createPostgresAdapter, PostgresAdapter } from '../src/database/postgres.js';
import type { Job } from '../src/types.js';

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
});
