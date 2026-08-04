import Database from 'better-sqlite3';
import { createSQLiteAdapter, SQLiteAdapter } from '../src/database/sqlite.js';
import type { Job } from '../src/types.js';

function jobData(overrides: Partial<Job> = {}): Omit<Job, 'id' | 'insertedAt'> {
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

/** Inserts a job that has been executing on `node` for longer than any rescue window. */
function insertStuckJob(
  db: Database.Database,
  node: string | null,
  overrides: { attempt?: number; maxAttempts?: number } = {}
): number {
  const { attempt = 1, maxAttempts = 20 } = overrides;
  const result = db
    .prepare(
      `INSERT INTO izi_jobs (state, queue, worker, args, attempt, max_attempts, attempted_at, attempted_by)
       VALUES ('executing', 'default', 'StuckWorker', '{}', ?, ?, datetime('now', '-1 hour'), ?)`
    )
    .run(attempt, maxAttempts, node);
  return Number(result.lastInsertRowid);
}

function stateOf(db: Database.Database, id: number): string {
  return (db.prepare('SELECT state FROM izi_jobs WHERE id = ?').get(id) as { state: string }).state;
}

describe('orphan rescue', () => {
  let db: Database.Database;
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    db = new Database(':memory:');
    adapter = createSQLiteAdapter(db);
    await adapter.migrate();
  });

  afterEach(async () => {
    await adapter.close();
  });

  describe('job ownership', () => {
    it('stamps the fetching node onto the job', async () => {
      await adapter.insertJob(jobData());

      const [job] = await adapter.fetchJobs('default', 1, 'node-a');

      expect(job.attemptedBy).toBe('node-a');
      const row = db
        .prepare('SELECT attempted_by FROM izi_jobs WHERE id = ?')
        .get(job.id) as { attempted_by: string };
      expect(row.attempted_by).toBe('node-a');
    });
  });

  describe('rescueStuckJobs', () => {
    it('does not rescue a job whose node is still alive', async () => {
      const id = insertStuckJob(db, 'node-a');
      await adapter.heartbeat('node-a');

      const rescued = await adapter.rescueStuckJobs(300);

      expect(rescued).toBe(0);
      expect(stateOf(db, id)).toBe('executing');
    });

    it('rescues a job whose node has stopped heartbeating', async () => {
      const id = insertStuckJob(db, 'node-gone');
      await adapter.heartbeat('node-gone');
      // Age the heartbeat past the node TTL.
      db.prepare(`UPDATE izi_nodes SET heartbeat_at = datetime('now', '-1 hour') WHERE name = ?`).run(
        'node-gone'
      );

      const rescued = await adapter.rescueStuckJobs(300);

      expect(rescued).toBe(1);
      expect(stateOf(db, id)).toBe('available');
    });

    it('rescues a job whose node never registered', async () => {
      const id = insertStuckJob(db, 'node-never-seen');

      const rescued = await adapter.rescueStuckJobs(300);

      expect(rescued).toBe(1);
      expect(stateOf(db, id)).toBe('available');
    });

    it('rescues legacy jobs with no recorded node', async () => {
      const id = insertStuckJob(db, null);

      const rescued = await adapter.rescueStuckJobs(300);

      expect(rescued).toBe(1);
      expect(stateOf(db, id)).toBe('available');
    });

    it('does not rescue a job that has not exceeded the rescue window', async () => {
      const result = db
        .prepare(
          `INSERT INTO izi_jobs (state, queue, worker, args, attempt, attempted_at, attempted_by)
           VALUES ('executing', 'default', 'RecentWorker', '{}', 1, datetime('now', '-10 seconds'), 'node-gone')`
        )
        .run();
      const id = Number(result.lastInsertRowid);

      const rescued = await adapter.rescueStuckJobs(300);

      expect(rescued).toBe(0);
      expect(stateOf(db, id)).toBe('executing');
    });

    it('discards an orphan whose attempts are exhausted instead of re-queueing it', async () => {
      const id = insertStuckJob(db, 'node-gone', { attempt: 3, maxAttempts: 3 });

      const rescued = await adapter.rescueStuckJobs(300);

      expect(rescued).toBe(1);
      expect(stateOf(db, id)).toBe('discarded');
      const row = db
        .prepare('SELECT discarded_at FROM izi_jobs WHERE id = ?')
        .get(id) as { discarded_at: string | null };
      expect(row.discarded_at).not.toBeNull();
    });
  });

  describe('node registry', () => {
    it('keeps one row per node and refreshes its heartbeat', async () => {
      await adapter.heartbeat('node-a');
      db.prepare(`UPDATE izi_nodes SET heartbeat_at = datetime('now', '-1 hour') WHERE name = ?`).run(
        'node-a'
      );
      await adapter.heartbeat('node-a');

      const rows = db.prepare('SELECT name, heartbeat_at FROM izi_nodes').all() as {
        name: string;
        heartbeat_at: string;
      }[];
      expect(rows).toHaveLength(1);

      // A refreshed node is live again, so its jobs are not rescued.
      const id = insertStuckJob(db, 'node-a');
      expect(await adapter.rescueStuckJobs(300)).toBe(0);
      expect(stateOf(db, id)).toBe('executing');
    });

    it('removes a node on deregistration', async () => {
      await adapter.heartbeat('node-a');
      await adapter.removeNode('node-a');

      const rows = db.prepare('SELECT name FROM izi_nodes').all();
      expect(rows).toHaveLength(0);
    });
  });
});
