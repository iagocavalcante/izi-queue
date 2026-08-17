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
import type {
  Job,
  JobCriteria,
  JobListCriteria,
  JobState,
  JobStateCounts,
  Logger,
  TransactionHandle,
  UniqueOptions
} from '../types.js';
import {
  BaseAdapter,
  DEFAULT_BATCH_SIZE,
  DEFAULT_NODE_TTL,
  SQL,
  buildStateCounts,
  criteriaClause,
  orderByClause,
  resolveListLimit,
  resolveListOffset,
  rowToJob
} from './adapter.js';
import { computeUniqueKey } from '../core/unique.js';

/** Arbitrary but fixed: all izi-queue instances must agree on this value. */
const MIGRATION_LOCK_NAME = 'izi_queue_migrations';
import { mysqlMigrations } from './migrations.js';

export class MySQLAdapter extends BaseAdapter {
  private pool: Pool;

  constructor(pool: Pool, logger?: Logger) {
    super(logger);
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

      // Unified with the Postgres/SQLite adapters at info level; this was
      // console.warn before #40, which was inconsistent with the other two
      // dialects for the same non-warning progress message.
      this.logger.info('Applying migration', { version: migration.version, name: migration.name });

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
        this.logger.info('Rolling back migration', { version: migration.version, name: migration.name });

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

  /**
   * Resolves where a statement should run. With a caller transaction the work
   * has to go through their connection -- the pool would hand back a different
   * one, which commits independently of them.
   */
  private executor(tx?: TransactionHandle): Pool | PoolConnection {
    if (tx === undefined) return this.pool;

    if (typeof (tx as PoolConnection)?.query !== 'function') {
      throw new Error('izi-queue: the transaction handle must be a mysql2 PoolConnection');
    }

    return tx as PoolConnection;
  }

  async insertJob(job: Omit<Job, 'id' | 'insertedAt'>, tx?: TransactionHandle): Promise<Job> {
    const executor = this.executor(tx);
    const [result] = await executor.query<ResultSetHeader>(SQL.mysql.insertJob, [
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

    // Read back through the same executor: an uncommitted row is invisible to
    // any other connection, so going via the pool would find nothing.
    const [rows] = await executor.query<RowDataPacket[]>(SQL.mysql.getJob, [result.insertId]);
    if (!rows[0]) {
      throw new Error('Failed to retrieve inserted job');
    }
    return rowToJob(rows[0] as Record<string, unknown>);
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

  async updateJob(
    id: number,
    updates: Partial<Job>,
    expectedStates?: JobState[]
  ): Promise<Job | null> {
    const params: unknown[] = [
      updates.state ?? null,
      updates.errors ? JSON.stringify(updates.errors) : null,
      updates.completedAt ?? null,
      updates.discardedAt ?? null,
      updates.cancelledAt ?? null,
      updates.scheduledAt ?? null,
      updates.meta ? JSON.stringify(updates.meta) : null,
      updates.attempt ?? null,
      updates.maxAttempts ?? null,
      id
    ];

    let guard = '';
    if (expectedStates?.length) {
      guard = ` AND state IN (${expectedStates.map(() => '?').join(',')})`;
      params.push(...expectedStates);
    }

    const [result] = await this.pool.query<ResultSetHeader>(
      `
        UPDATE izi_jobs
        SET state = COALESCE(?, state),
            errors = COALESCE(?, errors),
            completed_at = COALESCE(?, completed_at),
            discarded_at = COALESCE(?, discarded_at),
            cancelled_at = COALESCE(?, cancelled_at),
            scheduled_at = COALESCE(?, scheduled_at),
            meta = COALESCE(?, meta),
            attempt = COALESCE(?, attempt),
            max_attempts = COALESCE(?, max_attempts)
        WHERE id = ?${guard}
      `,
      params
    );

    if (result.affectedRows === 0) return null;
    return this.getJob(id);
  }

  async getJob(id: number): Promise<Job | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(SQL.mysql.getJob, [id]);
    return rows[0] ? rowToJob(rows[0] as Record<string, unknown>) : null;
  }

  async pruneJobs(maxAge: number, limit: number = DEFAULT_BATCH_SIZE): Promise<number> {
    const [result] = await this.pool.query<ResultSetHeader>(SQL.mysql.pruneJobs, [maxAge, limit]);
    return result.affectedRows;
  }

  async stageJobs(limit: number = DEFAULT_BATCH_SIZE): Promise<number> {
    const [result] = await this.pool.query<ResultSetHeader>(SQL.mysql.stageJobs, [limit]);
    return result.affectedRows;
  }

  async cancelJobs(criteria: JobCriteria): Promise<number> {
    const { clause, params } = criteriaClause(criteria, () => '?', 'mysql');
    const [result] = await this.pool.query<ResultSetHeader>(
      `${SQL.mysql.cancelJobs}${clause}`,
      params
    );
    return result.affectedRows;
  }

  async retryJobs(criteria: JobCriteria): Promise<number> {
    const { clause, params } = criteriaClause(criteria, () => '?', 'mysql');
    // Raising max_attempts matters for jobs discarded after exhausting them:
    // without headroom the job is discarded again on its very next fetch.
    const [result] = await this.pool.query<ResultSetHeader>(
      `
        UPDATE izi_jobs
        SET state = 'available',
            scheduled_at = NOW(6),
            discarded_at = NULL,
            cancelled_at = NULL,
            max_attempts = CASE WHEN attempt >= max_attempts THEN attempt + 1 ELSE max_attempts END
        WHERE state IN ('discarded', 'cancelled')${clause}
      `,
      params
    );
    return result.affectedRows;
  }

  async listJobs(criteria: JobListCriteria = {}): Promise<Job[]> {
    const { clause, params } = criteriaClause(criteria, () => '?', 'mysql');
    const limit = resolveListLimit(criteria.limit);
    const offset = resolveListOffset(criteria.offset);
    const order = orderByClause(criteria.orderBy);

    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM izi_jobs WHERE 1=1${clause} ${order} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return rows.map((row: RowDataPacket) => rowToJob(row as Record<string, unknown>));
  }

  async countJobs(criteria: JobCriteria = {}): Promise<JobStateCounts> {
    const { clause, params } = criteriaClause(criteria, () => '?', 'mysql');
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT state, COUNT(*) AS count FROM izi_jobs WHERE 1=1${clause} GROUP BY state`,
      params
    );
    return buildStateCounts(rows as { state: string; count: number }[]);
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
    options: UniqueOptions,
    tx?: TransactionHandle
  ): Promise<{ job: Job; conflict: boolean }> {
    if (tx !== undefined) {
      // MySQL's GET_LOCK is connection-scoped and not transactional, so it
      // cannot be held across the caller's commit. Releasing it at insert time
      // would leave a window for a concurrent node to insert a duplicate --
      // reintroducing the exact race that atomic insertion exists to close.
      // Degrading silently would be worse than refusing.
      throw new Error(
        'izi-queue: unique jobs cannot be inserted inside a caller-managed transaction on MySQL, ' +
          'because the advisory lock cannot span the commit. Insert unique jobs outside the ' +
          'transaction, or use PostgreSQL, where the lock is transaction-scoped.'
      );
    }

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

export function createMySQLAdapter(pool: Pool, logger?: Logger): MySQLAdapter {
  return new MySQLAdapter(pool, logger);
}
