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
import { BaseAdapter, DEFAULT_NODE_TTL, SQL, rowToJob } from './adapter.js';
import { computeUniqueKey } from '../core/unique.js';

/** Arbitrary but fixed: all izi-queue instances must agree on this value. */
const MIGRATION_LOCK_NAME = 'izi_queue_migrations';
import { mysqlMigrations } from './migrations.js';

export class MySQLAdapter extends BaseAdapter {
  private pool: Pool;

  constructor(pool: Pool) {
    super();
    this.pool = pool;
  }

  async migrate(): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      // Serialises concurrent boots; without it two instances racing the same
      // version both apply it and the second fails on the primary key.
      await connection.query('SELECT GET_LOCK(?, ?)', [MIGRATION_LOCK_NAME, 60]);
      await this.runMigrations(connection);
    } finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [MIGRATION_LOCK_NAME]).catch(() => {});
      connection.release();
    }
  }

  private async runMigrations(connection: PoolConnection): Promise<void> {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS izi_migrations (
        version INT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const [rows] = await connection.query<RowDataPacket[]>('SELECT version FROM izi_migrations ORDER BY version');
    const appliedVersions = new Set(rows.map((r: RowDataPacket) => r.version as number));

    for (const migration of mysqlMigrations) {
      if (appliedVersions.has(migration.version)) continue;

      console.warn(`[izi-queue] Applying migration ${migration.version}: ${migration.name}`);

      // DDL is not transactional in MySQL, so a failure part-way leaves the
      // schema changed but the version unrecorded. The lock at least stops two
      // nodes doing it at the same time.
      for (const statement of migration.up) {
        await connection.query(statement);
      }

      await connection.query(
        'INSERT INTO izi_migrations (version, name) VALUES (?, ?)',
        [migration.version, migration.name]
      );
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
          for (const statement of migration.down) {
            await connection.query(statement);
          }
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
      job.scheduledAt,
      job.uniqueKey ?? null
    ]);

    const insertedJob = await this.getJob(result.insertId);
    if (!insertedJob) {
      throw new Error('Failed to retrieve inserted job');
    }
    return insertedJob;
  }

  async fetchJobs(queue: string, limit: number, node?: string): Promise<Job[]> {
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
      await connection.query(SQL.mysql.updateFetched, [node ?? null, ids]);

      await connection.commit();

      // Fetch the updated jobs. The ORDER BY matters: without it the rows come
      // back in whatever order the server chooses, so a high-priority job could
      // be handed to the executor after a low-priority one from the same batch.
      const [updatedRows] = await connection.query<RowDataPacket[]>(
        `SELECT * FROM izi_jobs WHERE id IN (?)
         ORDER BY priority ASC, scheduled_at ASC, id ASC`,
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

  async rescueStuckJobs(rescueAfter: number, nodeTtl = DEFAULT_NODE_TTL): Promise<number> {
    const [result] = await this.pool.query<ResultSetHeader>(SQL.mysql.rescueStuckJobs, [
      rescueAfter,
      nodeTtl
    ]);
    return result.affectedRows;
  }

  async heartbeat(node: string): Promise<void> {
    await this.pool.query(SQL.mysql.heartbeat, [node]);

    // Node names are per-process, so a long-lived deployment would otherwise
    // accumulate one dead row per restart.
    await this.pool.query(SQL.mysql.pruneNodes, [DEFAULT_NODE_TTL * 20]);
  }

  async removeNode(node: string): Promise<void> {
    await this.pool.query(SQL.mysql.removeNode, [node]);
  }

  private uniqueLookupSql(withPeriod: boolean): string {
    return `
      SELECT * FROM izi_jobs
      WHERE unique_key = ?
        AND state IN (?)
        ${withPeriod ? 'AND inserted_at > DATE_SUB(NOW(), INTERVAL ? SECOND)' : ''}
      ORDER BY id ASC
      LIMIT 1
    `;
  }

  async checkUnique(options: UniqueOptions, job: Omit<Job, 'id' | 'insertedAt'>): Promise<Job | null> {
    const { states, period } = this.uniqueLookup(options);
    const uniqueKey = job.uniqueKey ?? computeUniqueKey(job, options);
    const params: unknown[] = period !== null ? [uniqueKey, states, period] : [uniqueKey, states];

    const [rows] = await this.pool.query<RowDataPacket[]>(this.uniqueLookupSql(period !== null), params);
    return rows[0] ? rowToJob(rows[0] as Record<string, unknown>) : null;
  }

  async insertUnique(
    job: Omit<Job, 'id' | 'insertedAt'>,
    options: UniqueOptions
  ): Promise<{ job: Job; conflict: boolean }> {
    const { states, period } = this.uniqueLookup(options);
    const uniqueKey = job.uniqueKey ?? computeUniqueKey(job, options);
    // GET_LOCK names are capped at 64 characters; the digest is 32.
    const lockName = `izi_unique_${uniqueKey}`;

    const connection = await this.pool.getConnection();
    try {
      // Connection-scoped rather than transaction-scoped, so it must be
      // released explicitly -- see the finally block.
      await connection.query('SELECT GET_LOCK(?, ?)', [lockName, 10]);
      await connection.beginTransaction();

      const params: unknown[] = period !== null ? [uniqueKey, states, period] : [uniqueKey, states];
      const [existing] = await connection.query<RowDataPacket[]>(
        this.uniqueLookupSql(period !== null),
        params
      );

      if (existing[0]) {
        await connection.commit();
        return { job: rowToJob(existing[0] as Record<string, unknown>), conflict: true };
      }

      const [result] = await connection.query<ResultSetHeader>(SQL.mysql.insertJob, [
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
        job.scheduledAt,
        uniqueKey
      ]);

      await connection.commit();

      const [rows] = await connection.query<RowDataPacket[]>(SQL.mysql.getJob, [result.insertId]);
      return { job: rowToJob(rows[0] as Record<string, unknown>), conflict: false };
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
      connection.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createMySQLAdapter(pool: Pool): MySQLAdapter {
  return new MySQLAdapter(pool);
}
