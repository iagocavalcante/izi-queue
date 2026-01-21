import type { Database } from 'better-sqlite3';
import type { Job, JobState, UniqueOptions } from '../types.js';
import { BaseAdapter, rowToJob } from './adapter.js';
import { sqliteMigrations } from './migrations.js';

export class SQLiteAdapter extends BaseAdapter {
  private db: Database;

  constructor(db: Database) {
    super();
    this.db = db;
  }

  async migrate(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS izi_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const stmt = this.db.prepare('SELECT version FROM izi_migrations ORDER BY version');
    const appliedVersions = new Set((stmt.all() as { version: number }[]).map(r => r.version));

    const applyMigration = this.db.transaction((migration: typeof sqliteMigrations[0]) => {
      const statements = migration.up.split(';').filter(s => s.trim());
      for (const sql of statements) {
        if (sql.trim()) {
          this.db.exec(sql);
        }
      }

      this.db.prepare('INSERT INTO izi_migrations (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name
      );
    });

    for (const migration of sqliteMigrations) {
      if (!appliedVersions.has(migration.version)) {
        console.log(`[izi-queue] Applying migration ${migration.version}: ${migration.name}`);
        applyMigration(migration);
      }
    }
  }

  async rollback(targetVersion = 0): Promise<void> {
    const stmt = this.db.prepare('SELECT version FROM izi_migrations WHERE version > ? ORDER BY version DESC');
    const rows = stmt.all(targetVersion) as { version: number }[];

    const rollbackMigration = this.db.transaction((version: number) => {
      const migration = sqliteMigrations.find(m => m.version === version);
      if (migration?.down) {
        console.log(`[izi-queue] Rolling back migration ${migration.version}: ${migration.name}`);
        this.db.exec(migration.down);
        this.db.prepare('DELETE FROM izi_migrations WHERE version = ?').run(version);
      }
    });

    for (const row of rows) {
      rollbackMigration(row.version);
    }
  }

  async getMigrationStatus(): Promise<{ version: number; name: string; applied: boolean }[]> {
    const stmt = this.db.prepare('SELECT version, name FROM izi_migrations');
    const applied = new Map((stmt.all() as { version: number; name: string }[]).map(r => [r.version, r.name]));

    return sqliteMigrations.map(m => ({
      version: m.version,
      name: m.name,
      applied: applied.has(m.version)
    }));
  }

  async insertJob(job: Omit<Job, 'id' | 'insertedAt'>): Promise<Job> {
    const stmt = this.db.prepare(`
      INSERT INTO izi_jobs (state, queue, worker, args, meta, tags, errors, attempt, max_attempts, priority, scheduled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      job.state,
      job.queue,
      job.worker,
      JSON.stringify(job.args),
      JSON.stringify(job.meta),
      JSON.stringify(job.tags),
      JSON.stringify(job.errors),
      job.attempt,
      job.maxAttempts,
      job.priority,
      job.scheduledAt.toISOString()
    );

    const getStmt = this.db.prepare('SELECT * FROM izi_jobs WHERE id = ?');
    const row = getStmt.get(result.lastInsertRowid) as Record<string, unknown>;
    return rowToJob(row);
  }

  async fetchJobs(queue: string, limit: number): Promise<Job[]> {
    const transaction = this.db.transaction(() => {
      const selectStmt = this.db.prepare(`
        SELECT id FROM izi_jobs
        WHERE queue = ? AND state = 'available'
        ORDER BY priority ASC, scheduled_at ASC, id ASC
        LIMIT ?
      `);
      const rows = selectStmt.all(queue, limit) as { id: number }[];

      if (rows.length === 0) return [];

      const ids = rows.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');

      const updateStmt = this.db.prepare(`
        UPDATE izi_jobs
        SET state = 'executing', attempted_at = datetime('now'), attempt = attempt + 1
        WHERE id IN (${placeholders})
      `);
      updateStmt.run(...ids);

      const fetchStmt = this.db.prepare(`
        SELECT * FROM izi_jobs WHERE id IN (${placeholders})
        ORDER BY priority ASC, scheduled_at ASC, id ASC
      `);
      return fetchStmt.all(...ids) as Record<string, unknown>[];
    });

    const rows = transaction();
    return rows.map(rowToJob);
  }

  async updateJob(id: number, updates: Partial<Job>): Promise<Job | null> {
    const stmt = this.db.prepare(`
      UPDATE izi_jobs
      SET state = COALESCE(?, state),
          errors = COALESCE(?, errors),
          completed_at = COALESCE(?, completed_at),
          discarded_at = COALESCE(?, discarded_at),
          cancelled_at = COALESCE(?, cancelled_at),
          scheduled_at = COALESCE(?, scheduled_at),
          meta = COALESCE(?, meta)
      WHERE id = ?
    `);

    stmt.run(
      updates.state ?? null,
      updates.errors ? JSON.stringify(updates.errors) : null,
      updates.completedAt?.toISOString() ?? null,
      updates.discardedAt?.toISOString() ?? null,
      updates.cancelledAt?.toISOString() ?? null,
      updates.scheduledAt?.toISOString() ?? null,
      updates.meta ? JSON.stringify(updates.meta) : null,
      id
    );

    const getStmt = this.db.prepare('SELECT * FROM izi_jobs WHERE id = ?');
    const row = getStmt.get(id) as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : null;
  }

  async getJob(id: number): Promise<Job | null> {
    const stmt = this.db.prepare('SELECT * FROM izi_jobs WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : null;
  }

  async pruneJobs(maxAge: number): Promise<number> {
    const stmt = this.db.prepare(`
      DELETE FROM izi_jobs
      WHERE state IN ('completed', 'discarded', 'cancelled')
        AND datetime(COALESCE(completed_at, discarded_at, cancelled_at)) < datetime('now', '-' || ? || ' seconds')
    `);
    const result = stmt.run(maxAge);
    return result.changes;
  }

  async stageJobs(): Promise<number> {
    const stmt = this.db.prepare(`
      UPDATE izi_jobs
      SET state = 'available'
      WHERE state = 'scheduled' AND datetime(scheduled_at) <= datetime('now')
    `);
    const result = stmt.run();
    return result.changes;
  }

  async cancelJobs(criteria: { queue?: string; worker?: string; state?: JobState[] }): Promise<number> {
    let sql = `
      UPDATE izi_jobs
      SET state = 'cancelled', cancelled_at = datetime('now')
      WHERE state NOT IN ('completed', 'discarded', 'cancelled')
    `;
    const params: unknown[] = [];

    if (criteria.queue) {
      sql += ' AND queue = ?';
      params.push(criteria.queue);
    }
    if (criteria.worker) {
      sql += ' AND worker = ?';
      params.push(criteria.worker);
    }
    if (criteria.state && criteria.state.length > 0) {
      sql += ` AND state IN (${criteria.state.map(() => '?').join(',')})`;
      params.push(...criteria.state);
    }

    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params);
    return result.changes;
  }

  async rescueStuckJobs(rescueAfter: number): Promise<number> {
    const stmt = this.db.prepare(`
      UPDATE izi_jobs
      SET state = 'available', scheduled_at = datetime('now')
      WHERE state = 'executing'
        AND datetime(attempted_at) < datetime('now', '-' || ? || ' seconds')
    `);
    const result = stmt.run(rescueAfter);
    return result.changes;
  }

  async checkUnique(options: UniqueOptions, job: Omit<Job, 'id' | 'insertedAt'>): Promise<Job | null> {
    const fields = options.fields ?? ['worker', 'queue', 'args'];
    const states = options.states ?? ['available', 'scheduled', 'executing', 'retryable'];
    const period = options.period === 'infinity' ? 999999999 : (options.period ?? 60);

    let sql = `SELECT * FROM izi_jobs WHERE state IN (${states.map(() => '?').join(',')})`;
    const params: unknown[] = [...states];

    if (period !== 999999999) {
      sql += ` AND datetime(inserted_at) > datetime('now', '-' || ? || ' seconds')`;
      params.push(period);
    }

    if (fields.includes('worker')) {
      sql += ' AND worker = ?';
      params.push(job.worker);
    }

    if (fields.includes('queue')) {
      sql += ' AND queue = ?';
      params.push(job.queue);
    }

    if (fields.includes('args')) {
      if (options.keys && options.keys.length > 0) {
        for (const key of options.keys) {
          sql += ` AND json_extract(args, '$.${key}') = ?`;
          params.push((job.args as Record<string, unknown>)[key] ?? null);
        }
      } else {
        sql += ' AND args = ?';
        params.push(JSON.stringify(job.args));
      }
    }

    sql += ' LIMIT 1';

    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : null;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export function createSQLiteAdapter(db: Database): SQLiteAdapter {
  return new SQLiteAdapter(db);
}
