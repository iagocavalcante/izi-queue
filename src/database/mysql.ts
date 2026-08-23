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
  BulkJobInsert,
  Job,
  JobCriteria,
  JobListCriteria,
  JobState,
  JobStateCounts,
  LeaderInfo,
  Logger,
  TransactionHandle,
  UniqueOptions
} from '../types.js';
import {
  BaseAdapter,
  DEFAULT_BATCH_SIZE,
  DEFAULT_NODE_TTL,
  INSERT_JOB_COLUMNS,
  SQL,
  buildStateCounts,
  chunkArray,
  criteriaClause,
  groupBulkRuns,
  maxRowsPerStatement,
  orderByClause,
  resolveListLimit,
  resolveListOffset,
  rowToJob
} from './adapter.js';
import { computeUniqueKey } from '../core/unique.js';

/** Arbitrary but fixed: all izi-queue instances must agree on this value. */
const MIGRATION_LOCK_NAME = 'izi_queue_migrations';

/**
 * mysql2's `.query()` (used throughout this adapter, unlike `.execute()`)
 * interpolates values into the SQL text client-side rather than binding them
 * through a server-side prepared statement, so there is no protocol-level
 * parameter cap here the way there is for PostgreSQL. The same 65535 ceiling
 * is reused anyway, as a predictable, defensive chunk size against
 * `max_allowed_packet` and so a future move to `.execute()` would not
 * silently regress this: floor(65535 / 12 columns) = 5461 rows per statement.
 */
const MYSQL_MAX_BIND_PARAMS = 65535;
export const INSERT_JOBS_CHUNK_SIZE = maxRowsPerStatement(MYSQL_MAX_BIND_PARAMS);

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

  /**
   * See `BaseAdapter.electLeader`. The renewal's row count is trustworthy on
   * either of MySQL's accountings -- it matches only when this node may hold
   * the lease, and it always moves `expires_at` forward when it does -- but
   * the claim's is not, which is why the outcome is read back instead.
   */
  async acquireLeadership(name: string, node: string, ttlSeconds: number): Promise<boolean> {
    return this.electLeader(
      node,
      async () => {
        const [renewed] = await this.pool.query<ResultSetHeader>(SQL.mysql.renewLeadership, [
          node,
          node,
          ttlSeconds,
          name,
          node
        ]);
        return renewed.affectedRows;
      },
      async () => {
        await this.pool.query(SQL.mysql.claimLeadership, [name, node, ttlSeconds]);
      },
      () => this.getLeader(name)
    );
  }

  async releaseLeadership(name: string, node: string): Promise<void> {
    await this.pool.query(SQL.mysql.releaseLeadership, [name, node]);
  }

  async getLeader(name: string): Promise<LeaderInfo | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(SQL.mysql.getLeader, [name]);
    const row = rows[0];
    if (!row) return null;

    return {
      node: row.node as string,
      electedAt: new Date(row.elected_at as string),
      expiresAt: new Date(row.expires_at as string)
    };
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

  /**
   * One multi-row `INSERT ... VALUES (...), (...), ...` with no `RETURNING`,
   * followed by recovering the inserted rows by id range.
   *
   * This is safe because of how InnoDB allocates AUTO_INCREMENT values for a
   * "simple insert" -- an `INSERT ... VALUES` statement (no `INSERT ...
   * SELECT`, no `ON DUPLICATE KEY UPDATE`, no trigger side effects) whose row
   * count is known before any value is generated:
   *
   *   - Because the number of ids needed (`batch.length`) is known up front,
   *     InnoDB reserves one contiguous block for the whole statement in a
   *     single allocation, rather than one id at a time.
   *   - `result.insertId` is the value assigned to the *first* row of that
   *     block (mysql2's documented behavior, matching `LAST_INSERT_ID()`
   *     semantics for a multi-row insert).
   *   - Row *i* of the VALUES list gets `insertId + i`, in order. This holds
   *     under every `innodb_autoinc_lock_mode`: modes 0/1 (traditional /
   *     consecutive) hold the table-level auto-increment lock for the whole
   *     statement, so nothing else can interleave; mode 2 (interleaved) only
   *     lets *other statements* interleave their own blocks with this one --
   *     it cannot fragment a single simple insert's own block, because that
   *     statement already knows exactly how many values it needs and
   *     reserves them together up front. (Interleaving only produces gaps
   *     *between* statements/sessions, which is irrelevant here since we only
   *     rely on our own statement's block being contiguous.)
   *
   * So `[insertId, insertId + affectedRows - 1]` is exactly this chunk's
   * rows, and ordering by id recovers the original VALUES order. The
   * `rows.length` check below is a hard guard against this reasoning ever
   * being silently wrong for a future MySQL version or statement shape.
   */
  private async insertPlainChunk(
    executor: Pool | PoolConnection,
    batch: Omit<Job, 'id' | 'insertedAt'>[]
  ): Promise<Job[]> {
    const rowPlaceholder = `(${Array(INSERT_JOB_COLUMNS).fill('?').join(', ')})`;
    const params: unknown[] = [];

    for (const job of batch) {
      params.push(
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
      );
    }

    const [result] = await executor.query<ResultSetHeader>(
      `
        INSERT INTO izi_jobs (state, queue, worker, args, meta, tags, errors, attempt, max_attempts, priority, scheduled_at, unique_key)
        VALUES ${batch.map(() => rowPlaceholder).join(', ')}
      `,
      params
    );

    const firstId = result.insertId;
    const lastId = firstId + result.affectedRows - 1;

    const [rows] = await executor.query<RowDataPacket[]>(
      'SELECT * FROM izi_jobs WHERE id BETWEEN ? AND ? ORDER BY id ASC',
      [firstId, lastId]
    );

    if (rows.length !== batch.length) {
      throw new Error(
        `izi-queue: expected to recover ${batch.length} inserted job(s) by id range [${firstId}, ${lastId}] but found ${rows.length}`
      );
    }

    return rows.map(row => rowToJob(row as Record<string, unknown>));
  }

  /** Chunks `jobs` (all non-unique) across as many `insertPlainChunk` calls as needed. */
  private async insertPlainRun(
    executor: Pool | PoolConnection,
    jobs: Omit<Job, 'id' | 'insertedAt'>[]
  ): Promise<{ job: Job; conflict: boolean }[]> {
    const out: { job: Job; conflict: boolean }[] = [];
    for (const batch of chunkArray(jobs, INSERT_JOBS_CHUNK_SIZE)) {
      const inserted = await this.insertPlainChunk(executor, batch);
      out.push(...inserted.map(job => ({ job, conflict: false })));
    }
    return out;
  }

  async insertJobs(
    jobs: BulkJobInsert[],
    tx?: TransactionHandle
  ): Promise<{ job: Job; conflict: boolean }[]> {
    if (jobs.length === 0) return [];

    const runs = groupBulkRuns(jobs);
    const hasUnique = runs.some(run => run.kind === 'unique');

    if (tx !== undefined) {
      if (hasUnique) {
        // Same restriction as `insertUnique`: GET_LOCK is connection-scoped,
        // not transactional, so it cannot be held across the caller's own,
        // later commit. Releasing it before that commit reopens the race
        // atomic insertion exists to close -- see `insertUnique` above.
        throw new Error(
          'izi-queue: unique jobs cannot be inserted inside a caller-managed transaction on MySQL, ' +
            'because the advisory lock cannot span the commit. Insert unique jobs outside the ' +
            'transaction, or use PostgreSQL, where the lock is transaction-scoped.'
        );
      }
      return this.insertPlainRun(this.executor(tx), jobs.map(entry => entry.job));
    }

    const connection = await this.pool.getConnection();
    const heldLocks: string[] = [];
    try {
      await connection.beginTransaction();
      const out: { job: Job; conflict: boolean }[] = [];

      for (const run of runs) {
        if (run.kind === 'plain') {
          out.push(...await this.insertPlainRun(connection, run.jobs));
          continue;
        }

        const { states, period } = this.uniqueLookup(run.unique);
        const uniqueKey = run.job.uniqueKey ?? computeUniqueKey(run.job, run.unique);
        // GET_LOCK names are capped at 64 characters; the digest is 32.
        const lockName = `izi_unique_${uniqueKey}`;

        // Connection-scoped, not transactional, so taking it mid-transaction
        // does not affect the transaction itself -- it just has to run on
        // this same connection. Released together with every other lock this
        // batch took, in `finally`, once the whole batch's outcome (commit or
        // rollback) is decided -- exactly as long as `insertUnique` holds it
        // for a single insert.
        await connection.query('SELECT GET_LOCK(?, ?)', [lockName, 10]);
        heldLocks.push(lockName);

        const params: unknown[] = period !== null ? [uniqueKey, states, period] : [uniqueKey, states];
        const [existing] = await connection.query<RowDataPacket[]>(
          this.uniqueLookupSql(period !== null),
          params
        );

        if (existing[0]) {
          out.push({ job: rowToJob(existing[0] as Record<string, unknown>), conflict: true });
          continue;
        }

        const [result] = await connection.query<ResultSetHeader>(SQL.mysql.insertJob, [
          run.job.state,
          run.job.queue,
          run.job.worker,
          JSON.stringify(run.job.args),
          JSON.stringify(run.job.meta),
          JSON.stringify(run.job.tags),
          JSON.stringify(run.job.errors),
          run.job.attempt,
          run.job.maxAttempts,
          run.job.priority,
          run.job.scheduledAt,
          uniqueKey
        ]);

        const [rows] = await connection.query<RowDataPacket[]>(SQL.mysql.getJob, [result.insertId]);
        out.push({ job: rowToJob(rows[0] as Record<string, unknown>), conflict: false });
      }

      await connection.commit();
      return out;
    } catch (error) {
      await connection.rollback().catch(() => {});
      throw error;
    } finally {
      for (const lockName of heldLocks) {
        await connection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
      }
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
