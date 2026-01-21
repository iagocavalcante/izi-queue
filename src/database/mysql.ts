// Type definitions for mysql2
interface RowDataPacket {
  [column: string]: unknown;
  [column: number]: unknown;
}

interface ResultSetHeader {
  affectedRows: number;
  insertId: number;
  warningStatus: number;
}

interface PoolConnection {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  query<T>(sql: string, values?: unknown[]): Promise<[T, unknown]>;
  release(): void;
}

interface Pool {
  query<T>(sql: string, values?: unknown[]): Promise<[T, unknown]>;
  getConnection(): Promise<PoolConnection>;
  end(): Promise<void>;
}
import type { Job, JobState, UniqueOptions } from '../types.js';
import { BaseAdapter, SQL, rowToJob } from './adapter.js';
import { mysqlMigrations } from './migrations.js';

export class MySQLAdapter extends BaseAdapter {
  private pool: Pool;

  constructor(pool: Pool) {
    super();
    this.pool = pool;
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS izi_migrations (
        version INT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT version FROM izi_migrations ORDER BY version');
    const appliedVersions = new Set(rows.map((r: RowDataPacket) => r.version as number));

    for (const migration of mysqlMigrations) {
      if (!appliedVersions.has(migration.version)) {
        console.warn(`[izi-queue] Applying migration ${migration.version}: ${migration.name}`);

        const connection = await this.pool.getConnection();
        try {
          await connection.beginTransaction();

          const statements = migration.up.split(';').filter(s => s.trim());
          for (const stmt of statements) {
            if (stmt.trim()) {
              await connection.query(stmt);
            }
          }

          await connection.query(
            'INSERT INTO izi_migrations (version, name) VALUES (?, ?)',
            [migration.version, migration.name]
          );

          await connection.commit();
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
      }
    }
  }

  async rollback(targetVersion = 0): Promise<void> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT version FROM izi_migrations WHERE version > ? ORDER BY version DESC',
      [targetVersion]
    );

    for (const row of rows) {
      const migration = mysqlMigrations.find(m => m.version === row.version);
      if (migration?.down) {
        console.warn(`[izi-queue] Rolling back migration ${migration.version}: ${migration.name}`);

        const connection = await this.pool.getConnection();
        try {
          await connection.beginTransaction();
          await connection.query(migration.down);
          await connection.query('DELETE FROM izi_migrations WHERE version = ?', [migration.version]);
          await connection.commit();
        } catch (error) {
          await connection.rollback();
          throw error;
        } finally {
          connection.release();
        }
      }
    }
  }

  async getMigrationStatus(): Promise<{ version: number; name: string; applied: boolean }[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT version, name FROM izi_migrations');
    const applied = new Map(rows.map((r: RowDataPacket) => [r.version as number, r.name as string]));

    return mysqlMigrations.map(m => ({
      version: m.version,
      name: m.name,
      applied: applied.has(m.version)
    }));
  }

  async insertJob(job: Omit<Job, 'id' | 'insertedAt'>): Promise<Job> {
    const [result] = await this.pool.query<ResultSetHeader>(SQL.mysql.insertJob, [
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
      job.scheduledAt
    ]);

    const insertedJob = await this.getJob(result.insertId);
    if (!insertedJob) {
      throw new Error('Failed to retrieve inserted job');
    }
    return insertedJob;
  }

  async fetchJobs(queue: string, limit: number): Promise<Job[]> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      // Select jobs with FOR UPDATE SKIP LOCKED
      const [rows] = await connection.query<RowDataPacket[]>(SQL.mysql.fetchJobs, [queue, limit]);

      if (rows.length === 0) {
        await connection.commit();
        return [];
      }

      const ids = rows.map((r: RowDataPacket) => r.id as number);

      // Update the selected jobs
      await connection.query(
        `UPDATE izi_jobs SET state = 'executing', attempted_at = NOW(6), attempt = attempt + 1 WHERE id IN (?)`,
        [ids]
      );

      await connection.commit();

      // Fetch the updated jobs
      const [updatedRows] = await connection.query<RowDataPacket[]>(
        `SELECT * FROM izi_jobs WHERE id IN (?)`,
        [ids]
      );

      return updatedRows.map((row: RowDataPacket) => rowToJob(row as Record<string, unknown>));
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async updateJob(id: number, updates: Partial<Job>): Promise<Job | null> {
    await this.pool.query(SQL.mysql.updateJob, [
      updates.state ?? null,
      updates.errors ? JSON.stringify(updates.errors) : null,
      updates.completedAt ?? null,
      updates.discardedAt ?? null,
      updates.cancelledAt ?? null,
      updates.scheduledAt ?? null,
      updates.meta ? JSON.stringify(updates.meta) : null,
      id
    ]);

    return this.getJob(id);
  }

  async getJob(id: number): Promise<Job | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(SQL.mysql.getJob, [id]);
    return rows[0] ? rowToJob(rows[0] as Record<string, unknown>) : null;
  }

  async pruneJobs(maxAge: number): Promise<number> {
    const [result] = await this.pool.query<ResultSetHeader>(SQL.mysql.pruneJobs, [maxAge]);
    return result.affectedRows;
  }

  async stageJobs(): Promise<number> {
    const [result] = await this.pool.query<ResultSetHeader>(SQL.mysql.stageJobs);
    return result.affectedRows;
  }

  async cancelJobs(criteria: { queue?: string; worker?: string; state?: JobState[] }): Promise<number> {
    let sql = SQL.mysql.cancelJobs;
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
      sql += ' AND state IN (?)';
      params.push(criteria.state);
    }

    const [result] = await this.pool.query<ResultSetHeader>(sql, params);
    return result.affectedRows;
  }

  async rescueStuckJobs(rescueAfter: number): Promise<number> {
    const [result] = await this.pool.query<ResultSetHeader>(SQL.mysql.rescueStuckJobs, [rescueAfter]);
    return result.affectedRows;
  }

  async checkUnique(options: UniqueOptions, job: Omit<Job, 'id' | 'insertedAt'>): Promise<Job | null> {
    const fields = options.fields ?? ['worker', 'queue', 'args'];
    const states = options.states ?? ['available', 'scheduled', 'executing', 'retryable'];
    const period = options.period === 'infinity' ? 999999999 : (options.period ?? 60);

    let sql = 'SELECT * FROM izi_jobs WHERE state IN (?)';
    const params: unknown[] = [states];

    if (period !== 999999999) {
      sql += ' AND inserted_at > DATE_SUB(NOW(), INTERVAL ? SECOND)';
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
          sql += ` AND JSON_EXTRACT(args, '$.${key}') = ?`;
          params.push(JSON.stringify((job.args as Record<string, unknown>)[key] ?? null));
        }
      } else {
        sql += ' AND args = CAST(? AS JSON)';
        params.push(JSON.stringify(job.args));
      }
    }

    sql += ' LIMIT 1';

    const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
    return rows[0] ? rowToJob(rows[0] as Record<string, unknown>) : null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createMySQLAdapter(pool: Pool): MySQLAdapter {
  return new MySQLAdapter(pool);
}
