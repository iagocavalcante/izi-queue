import type { Pool, PoolClient } from 'pg';
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
import { advisoryLockKey, computeUniqueKey } from '../core/unique.js';
import { telemetry } from '../core/telemetry.js';

/** Arbitrary but fixed: all izi-queue instances must agree on this value. */
const MIGRATION_LOCK_KEY = '7451092386401173';

/**
 * PostgreSQL's extended query protocol encodes the bound-parameter count as a
 * signed 16-bit integer, so a single statement cannot bind more than 65535
 * parameters. `insertJobs` chunks its multi-row INSERTs to stay under it:
 * floor(65535 / 12 columns) = 5461 rows per statement.
 */
const PG_MAX_BIND_PARAMS = 65535;
export const INSERT_JOBS_CHUNK_SIZE = maxRowsPerStatement(PG_MAX_BIND_PARAMS);

function uniqueLookupSql(withPeriod: boolean): string {
  return `
    SELECT * FROM izi_jobs
    WHERE unique_key = $1
      AND state = ANY($2)
      ${withPeriod ? "AND inserted_at > NOW() - INTERVAL '1 second' * $3" : ''}
    ORDER BY id ASC
    LIMIT 1
  `;
}
import { postgresMigrations } from './migrations.js';

export class PostgresAdapter extends BaseAdapter {
  private pool: Pool;
  private client?: PoolClient;
  private listening = false;
  private resubscribing = false;
  private notificationHandler?: (event: { queue: string }) => void;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;

  constructor(pool: Pool, logger?: Logger) {
    super(logger);
    this.pool = pool;
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.pool.on('error', (err) => {
      this.logger.error('PostgreSQL pool error', { error: err.message });
      this.handleConnectionError();
    });
  }

  private async handleConnectionError(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    while (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      // High-volume under a flapping connection -- debug rather than info so
      // a console-backed logger stays quiet while a structured one can still
      // capture every attempt.
      this.logger.debug('Attempting to reconnect', {
        attempt: this.reconnectAttempts,
        maxAttempts: this.maxReconnectAttempts
      });

      try {
        await this.pool.query('SELECT 1');
        this.logger.info('Reconnected successfully');
        this.reconnecting = false;
        this.reconnectAttempts = 0;
        return;
      } catch {
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        await new Promise(resolve => setTimeout(resolve, Math.min(delay, 30000)));
      }
    }

    this.logger.error('Failed to reconnect after maximum attempts', {
      maxAttempts: this.maxReconnectAttempts
    });
    this.reconnecting = false;
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Serialises concurrent boots. Without it, two instances starting at once
      // both see the same version missing, both run it, and the second fails on
      // the primary key -- so a rolling deploy can crash a fresh node.
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      await this.runMigrations(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
      client.release();
    }
  }

  private async runMigrations(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS izi_migrations (
        version INTEGER PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);

    const result = await client.query('SELECT version FROM izi_migrations ORDER BY version');
    const appliedVersions = new Set(result.rows.map(r => r.version));

    for (const migration of postgresMigrations) {
      if (appliedVersions.has(migration.version)) continue;

      this.logger.info('Applying migration', { version: migration.version, name: migration.name });

      try {
        await client.query('BEGIN');

        for (const statement of migration.up) {
          await client.query(statement);
        }

        await client.query(
          'INSERT INTO izi_migrations (version, name) VALUES ($1, $2)',
          [migration.version, migration.name]
        );

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  }

  async rollback(targetVersion = 0): Promise<void> {
    const result = await this.pool.query(
      'SELECT version FROM izi_migrations WHERE version > $1 ORDER BY version DESC',
      [targetVersion]
    );

    for (const row of result.rows) {
      const migration = postgresMigrations.find(m => m.version === row.version);
      if (migration?.down) {
        this.logger.info('Rolling back migration', { version: migration.version, name: migration.name });

        const client = await this.pool.connect();
        try {
          await client.query('BEGIN');
          for (const statement of migration.down) {
            await client.query(statement);
          }
          await client.query('DELETE FROM izi_migrations WHERE version = $1', [migration.version]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      }
    }
  }

  async getMigrationStatus(): Promise<{ version: number; name: string; applied: boolean }[]> {
    const result = await this.pool.query('SELECT version, name FROM izi_migrations');
    const applied = new Map(result.rows.map(r => [r.version, r.name]));

    return postgresMigrations.map(m => ({
      version: m.version,
      name: m.name,
      applied: applied.has(m.version)
    }));
  }

  /**
   * Resolves where a statement should run. With a caller transaction the work
   * has to go through their client -- the pool would hand back a different
   * connection, which commits independently of them.
   */
  private executor(tx?: TransactionHandle): Pool | PoolClient {
    if (tx === undefined) return this.pool;

    if (typeof (tx as PoolClient)?.query !== 'function') {
      throw new Error('izi-queue: the transaction handle must be a pg PoolClient or Client');
    }

    return tx as PoolClient;
  }

  async insertJob(job: Omit<Job, 'id' | 'insertedAt'>, tx?: TransactionHandle): Promise<Job> {
    const result = await this.executor(tx).query(SQL.postgres.insertJob, [
      job.state,
      job.queue,
      job.worker,
      JSON.stringify(job.args),
      JSON.stringify(job.meta),
      job.tags,
      JSON.stringify(job.errors),
      job.attempt,
      job.maxAttempts,
      job.priority,
      job.scheduledAt,
      job.uniqueKey ?? null
    ]);
    return rowToJob(result.rows[0]);
  }

  async fetchJobs(queue: string, limit: number, node?: string): Promise<Job[]> {
    const result = await this.pool.query(SQL.postgres.fetchJobs, [queue, limit, node ?? null]);
    return result.rows.map(rowToJob);
  }

  async updateJob(
    id: number,
    updates: Partial<Job>,
    expectedStates?: JobState[]
  ): Promise<Job | null> {
    const params: unknown[] = [
      id,
      updates.state ?? null,
      updates.errors ? JSON.stringify(updates.errors) : null,
      updates.completedAt ?? null,
      updates.discardedAt ?? null,
      updates.cancelledAt ?? null,
      updates.scheduledAt ?? null,
      updates.meta ? JSON.stringify(updates.meta) : null,
      updates.attempt ?? null,
      updates.maxAttempts ?? null
    ];

    let guard = '';
    if (expectedStates?.length) {
      params.push(expectedStates);
      guard = ` AND state = ANY($${params.length})`;
    }

    const result = await this.pool.query(
      `
        UPDATE izi_jobs
        SET state = COALESCE($2, state),
            errors = COALESCE($3, errors),
            completed_at = COALESCE($4, completed_at),
            discarded_at = COALESCE($5, discarded_at),
            cancelled_at = COALESCE($6, cancelled_at),
            scheduled_at = COALESCE($7, scheduled_at),
            meta = COALESCE($8, meta),
            attempt = COALESCE($9, attempt),
            max_attempts = COALESCE($10, max_attempts)
        WHERE id = $1${guard}
        RETURNING *
      `,
      params
    );

    return result.rows[0] ? rowToJob(result.rows[0]) : null;
  }

  async getJob(id: number): Promise<Job | null> {
    const result = await this.pool.query(SQL.postgres.getJob, [id]);
    return result.rows[0] ? rowToJob(result.rows[0]) : null;
  }

  async pruneJobs(maxAge: number, limit: number = DEFAULT_BATCH_SIZE): Promise<number> {
    const result = await this.pool.query(SQL.postgres.pruneJobs, [maxAge, limit]);
    return result.rowCount ?? 0;
  }

  async stageJobs(limit: number = DEFAULT_BATCH_SIZE): Promise<number> {
    const result = await this.pool.query(SQL.postgres.stageJobs, [limit]);
    return result.rowCount ?? 0;
  }

  async cancelJobs(criteria: JobCriteria): Promise<number> {
    const { clause, params } = criteriaClause(criteria, i => `$${i}`, 'postgres');
    const result = await this.pool.query(
      `${SQL.postgres.cancelJobs}${clause}`,
      params
    );
    return result.rowCount ?? 0;
  }

  async retryJobs(criteria: JobCriteria): Promise<number> {
    const { clause, params } = criteriaClause(criteria, i => `$${i}`, 'postgres');
    // Raising max_attempts matters for jobs discarded after exhausting them:
    // without headroom the job is discarded again on its very next fetch.
    const result = await this.pool.query(
      `
        UPDATE izi_jobs
        SET state = 'available',
            scheduled_at = NOW(),
            discarded_at = NULL,
            cancelled_at = NULL,
            max_attempts = CASE WHEN attempt >= max_attempts THEN attempt + 1 ELSE max_attempts END
        WHERE state IN ('discarded', 'cancelled')${clause}
      `,
      params
    );
    return result.rowCount ?? 0;
  }

  async listJobs(criteria: JobListCriteria = {}): Promise<Job[]> {
    const { clause, params } = criteriaClause(criteria, i => `$${i}`, 'postgres');
    const limit = resolveListLimit(criteria.limit);
    const offset = resolveListOffset(criteria.offset);
    const order = orderByClause(criteria.orderBy);

    const result = await this.pool.query(
      `SELECT * FROM izi_jobs WHERE 1=1${clause} ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    return result.rows.map(rowToJob);
  }

  async countJobs(criteria: JobCriteria = {}): Promise<JobStateCounts> {
    const { clause, params } = criteriaClause(criteria, i => `$${i}`, 'postgres');
    const result = await this.pool.query(
      `SELECT state, COUNT(*)::int AS count FROM izi_jobs WHERE 1=1${clause} GROUP BY state`,
      params
    );
    return buildStateCounts(result.rows);
  }

  async rescueStuckJobs(rescueAfter: number, nodeTtl = DEFAULT_NODE_TTL): Promise<number> {
    const result = await this.pool.query(SQL.postgres.rescueStuckJobs, [rescueAfter, nodeTtl]);
    return result.rowCount ?? 0;
  }

  async heartbeat(node: string): Promise<void> {
    await this.pool.query(SQL.postgres.heartbeat, [node]);

    // Node names are per-process, so a long-lived deployment would otherwise
    // accumulate one dead row per restart.
    await this.pool.query(SQL.postgres.pruneNodes, [DEFAULT_NODE_TTL * 20]);
  }

  async removeNode(node: string): Promise<void> {
    await this.pool.query(SQL.postgres.removeNode, [node]);
  }

  /** See `BaseAdapter.electLeader` for why this is shaped the way it is. */
  async acquireLeadership(name: string, node: string, ttlSeconds: number): Promise<boolean> {
    return this.electLeader(
      node,
      async () => {
        const renewed = await this.pool.query(SQL.postgres.renewLeadership, [name, node, ttlSeconds]);
        return renewed.rowCount ?? 0;
      },
      async () => {
        await this.pool.query(SQL.postgres.claimLeadership, [name, node, ttlSeconds]);
      },
      () => this.getLeader(name)
    );
  }

  async releaseLeadership(name: string, node: string): Promise<void> {
    await this.pool.query(SQL.postgres.releaseLeadership, [name, node]);
  }

  async getLeader(name: string): Promise<LeaderInfo | null> {
    const result = await this.pool.query(SQL.postgres.getLeader, [name]);
    const row = result.rows[0];
    if (!row) return null;

    return {
      node: row.node as string,
      electedAt: new Date(row.elected_at as string),
      expiresAt: new Date(row.expires_at as string)
    };
  }

  async checkUnique(options: UniqueOptions, job: Omit<Job, 'id' | 'insertedAt'>): Promise<Job | null> {
    const { states, period } = this.uniqueLookup(options);
    const uniqueKey = job.uniqueKey ?? computeUniqueKey(job, options);
    const result = await this.pool.query(
      uniqueLookupSql(period !== null),
      period !== null ? [uniqueKey, states, period] : [uniqueKey, states]
    );
    return result.rows[0] ? rowToJob(result.rows[0]) : null;
  }

  /**
   * Checks `job`/`options` against pre-existing rows under an advisory lock
   * and inserts unless one is found. Shared by `insertUnique` (called with
   * whichever client owns the transaction) and `insertJobs` (called once per
   * unique run within the batch's transaction).
   */
  private async claimUnique(
    client: Pool | PoolClient,
    job: Omit<Job, 'id' | 'insertedAt'>,
    options: UniqueOptions
  ): Promise<{ job: Job; conflict: boolean }> {
    const { states, period } = this.uniqueLookup(options);
    const uniqueKey = job.uniqueKey ?? computeUniqueKey(job, options);

    // Transaction-scoped, so it is held until whoever owns the transaction
    // commits -- the caller when they supplied one, otherwise us.
    await client.query('SELECT pg_advisory_xact_lock($1)', [advisoryLockKey(uniqueKey)]);

    const existing = await client.query(
      uniqueLookupSql(period !== null),
      period !== null ? [uniqueKey, states, period] : [uniqueKey, states]
    );

    if (existing.rows[0]) {
      return { job: rowToJob(existing.rows[0]), conflict: true };
    }

    const inserted = await client.query(SQL.postgres.insertJob, [
      job.state,
      job.queue,
      job.worker,
      JSON.stringify(job.args),
      JSON.stringify(job.meta),
      job.tags,
      JSON.stringify(job.errors),
      job.attempt,
      job.maxAttempts,
      job.priority,
      job.scheduledAt,
      uniqueKey
    ]);

    return { job: rowToJob(inserted.rows[0]), conflict: false };
  }

  async insertUnique(
    job: Omit<Job, 'id' | 'insertedAt'>,
    options: UniqueOptions,
    tx?: TransactionHandle
  ): Promise<{ job: Job; conflict: boolean }> {
    // Inside the caller's transaction: their BEGIN/COMMIT governs atomicity,
    // and issuing our own would end their transaction early.
    if (tx !== undefined) {
      return this.claimUnique(this.executor(tx), job, options);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.claimUnique(client, job, options);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** One multi-row `INSERT ... RETURNING *`, sized to stay under the bind-parameter cap. */
  private async insertPlainChunk(
    client: Pool | PoolClient,
    batch: Omit<Job, 'id' | 'insertedAt'>[]
  ): Promise<Job[]> {
    const values: string[] = [];
    const params: unknown[] = [];

    batch.forEach((job, i) => {
      const base = i * INSERT_JOB_COLUMNS;
      const placeholders = Array.from({ length: INSERT_JOB_COLUMNS }, (_, j) => `$${base + j + 1}`);
      values.push(`(${placeholders.join(', ')})`);
      params.push(
        job.state,
        job.queue,
        job.worker,
        JSON.stringify(job.args),
        JSON.stringify(job.meta),
        job.tags,
        JSON.stringify(job.errors),
        job.attempt,
        job.maxAttempts,
        job.priority,
        job.scheduledAt,
        job.uniqueKey ?? null
      );
    });

    const result = await client.query(
      `
        INSERT INTO izi_jobs (state, queue, worker, args, meta, tags, errors, attempt, max_attempts, priority, scheduled_at, unique_key)
        VALUES ${values.join(', ')}
        RETURNING *
      `,
      params
    );

    return result.rows.map(rowToJob);
  }

  /** Chunks `jobs` (all non-unique) across as many `insertPlainChunk` calls as needed. */
  private async insertPlainRun(
    client: Pool | PoolClient,
    jobs: Omit<Job, 'id' | 'insertedAt'>[]
  ): Promise<{ job: Job; conflict: boolean }[]> {
    const out: { job: Job; conflict: boolean }[] = [];
    for (const batch of chunkArray(jobs, INSERT_JOBS_CHUNK_SIZE)) {
      const inserted = await this.insertPlainChunk(client, batch);
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

    const runAll = async (client: Pool | PoolClient): Promise<{ job: Job; conflict: boolean }[]> => {
      const out: { job: Job; conflict: boolean }[] = [];
      for (const run of runs) {
        if (run.kind === 'plain') {
          out.push(...await this.insertPlainRun(client, run.jobs));
        } else {
          out.push(await this.claimUnique(client, run.job, run.unique));
        }
      }
      return out;
    };

    // Inside the caller's transaction: their BEGIN/COMMIT governs atomicity,
    // same as `insertUnique`.
    if (tx !== undefined) {
      return runAll(this.executor(tx));
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await runAll(client);
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listen(callback: (event: { queue: string }) => void): Promise<void> {
    if (this.listening) return;

    this.listening = true;
    this.notificationHandler = callback;
    await this.subscribe();
  }

  /**
   * Takes a dedicated connection and starts listening on it.
   *
   * The connection is deliberately not returned to the pool: a listener has to
   * keep the same backend to keep receiving notifications.
   */
  private async subscribe(): Promise<void> {
    const client = await this.pool.connect();
    this.client = client;

    // A LISTEN connection dies like any other -- failover, an idle reaper, a
    // network blip. Without re-subscribing, notifications stop arriving
    // silently and the queue degrades to poll-only with nothing to show for it.
    client.on('error', () => this.resubscribe());
    client.on('end', () => this.resubscribe());

    client.on('notification', msg => {
      if (msg.channel === 'izi_jobs_insert' && msg.payload) {
        try {
          const payload = JSON.parse(msg.payload);
          this.notificationHandler?.({ queue: payload.queue });
        } catch {
          // Ignore parse errors
        }
      }
    });

    await client.query('LISTEN izi_jobs_insert');
  }

  private async resubscribe(): Promise<void> {
    if (!this.listening || this.resubscribing) return;
    this.resubscribing = true;

    // The old client is gone; release it so the pool can reclaim the slot.
    try {
      this.client?.release();
    } catch {
      // Already destroyed.
    }
    this.client = undefined;

    telemetry.emit('plugin:error', {
      queue: 'notifier',
      error: new Error('izi-queue: notification listener disconnected, reconnecting')
    });

    for (let attempt = 1; this.listening; attempt++) {
      const delay = Math.min(this.reconnectDelay * 2 ** (attempt - 1), 30000);
      await new Promise(resolve => setTimeout(resolve, delay));

      if (!this.listening) break;

      try {
        await this.subscribe();
        this.resubscribing = false;
        telemetry.emit('plugin:start', { queue: 'notifier' });
        return;
      } catch {
        // Keep trying: polling still drains the queue meanwhile, so this is a
        // degradation rather than an outage.
      }
    }

    this.resubscribing = false;
  }

  async notify(queue: string, tx?: TransactionHandle): Promise<void> {
    const payload = JSON.stringify({ queue });
    // Issued on the caller's connection when there is one. PostgreSQL defers
    // NOTIFY until commit and discards it on rollback, so the wake-up inherits
    // the transaction's fate for free.
    await this.executor(tx).query('SELECT pg_notify($1, $2)', ['izi_jobs_insert', payload]);
  }

  async close(): Promise<void> {
    // Cleared first so an in-flight reconnect gives up instead of racing the
    // pool shutdown.
    this.listening = false;
    this.notificationHandler = undefined;

    if (this.client) {
      try {
        this.client.release();
      } catch {
        // Already destroyed by the disconnect that triggered shutdown.
      }
      this.client = undefined;
    }

    await this.pool.end();
  }
}

export function createPostgresAdapter(pool: Pool, logger?: Logger): PostgresAdapter {
  return new PostgresAdapter(pool, logger);
}
