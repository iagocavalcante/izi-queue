import type { Pool, PoolClient } from 'pg';
import type { Job, JobCriteria, JobState, TransactionHandle, UniqueOptions } from '../types.js';
import { BaseAdapter, DEFAULT_NODE_TTL, SQL, criteriaClause, rowToJob } from './adapter.js';
import { advisoryLockKey, computeUniqueKey } from '../core/unique.js';

/** Arbitrary but fixed: all izi-queue instances must agree on this value. */
const MIGRATION_LOCK_KEY = '7451092386401173';

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
  private reconnecting = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;

  constructor(pool: Pool) {
    super();
    this.pool = pool;
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.pool.on('error', (err) => {
      console.error('[izi-queue] PostgreSQL pool error:', err.message);
      this.handleConnectionError();
    });
  }

  private async handleConnectionError(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;

    while (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`[izi-queue] Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

      try {
        await this.pool.query('SELECT 1');
        console.log('[izi-queue] Reconnected successfully');
        this.reconnecting = false;
        this.reconnectAttempts = 0;
        return;
      } catch {
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        await new Promise(resolve => setTimeout(resolve, Math.min(delay, 30000)));
      }
    }

    console.error('[izi-queue] Failed to reconnect after maximum attempts');
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

      console.log(`[izi-queue] Applying migration ${migration.version}: ${migration.name}`);

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
        console.log(`[izi-queue] Rolling back migration ${migration.version}: ${migration.name}`);

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

  async pruneJobs(maxAge: number): Promise<number> {
    const result = await this.pool.query(SQL.postgres.pruneJobs, [maxAge]);
    return result.rowCount ?? 0;
  }

  async stageJobs(): Promise<number> {
    const result = await this.pool.query(SQL.postgres.stageJobs);
    return result.rowCount ?? 0;
  }

  async cancelJobs(criteria: JobCriteria): Promise<number> {
    const { clause, params } = criteriaClause(criteria, i => `$${i}`);
    const result = await this.pool.query(
      `${SQL.postgres.cancelJobs}${clause}`,
      params
    );
    return result.rowCount ?? 0;
  }

  async retryJobs(criteria: JobCriteria): Promise<number> {
    const { clause, params } = criteriaClause(criteria, i => `$${i}`);
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

  async checkUnique(options: UniqueOptions, job: Omit<Job, 'id' | 'insertedAt'>): Promise<Job | null> {
    const { states, period } = this.uniqueLookup(options);
    const uniqueKey = job.uniqueKey ?? computeUniqueKey(job, options);
    const result = await this.pool.query(
      uniqueLookupSql(period !== null),
      period !== null ? [uniqueKey, states, period] : [uniqueKey, states]
    );
    return result.rows[0] ? rowToJob(result.rows[0]) : null;
  }

  async insertUnique(
    job: Omit<Job, 'id' | 'insertedAt'>,
    options: UniqueOptions,
    tx?: TransactionHandle
  ): Promise<{ job: Job; conflict: boolean }> {
    const { states, period } = this.uniqueLookup(options);
    const uniqueKey = job.uniqueKey ?? computeUniqueKey(job, options);

    const claim = async (client: Pool | PoolClient): Promise<{ job: Job; conflict: boolean }> => {
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
    };

    // Inside the caller's transaction: their BEGIN/COMMIT governs atomicity,
    // and issuing our own would end their transaction early.
    if (tx !== undefined) {
      return claim(this.executor(tx));
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await claim(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listen(callback: (event: { queue: string }) => void): Promise<void> {
    if (this.listening) return;

    this.client = await this.pool.connect();
    await this.client.query('LISTEN izi_jobs_insert');
    this.listening = true;

    this.client.on('notification', (msg) => {
      if (msg.channel === 'izi_jobs_insert' && msg.payload) {
        try {
          const payload = JSON.parse(msg.payload);
          callback({ queue: payload.queue });
        } catch {
          // Ignore parse errors
        }
      }
    });
  }

  async notify(queue: string, tx?: TransactionHandle): Promise<void> {
    const payload = JSON.stringify({ queue });
    // Issued on the caller's connection when there is one. PostgreSQL defers
    // NOTIFY until commit and discards it on rollback, so the wake-up inherits
    // the transaction's fate for free.
    await this.executor(tx).query('SELECT pg_notify($1, $2)', ['izi_jobs_insert', payload]);
  }

  async close(): Promise<void> {
    if (this.client) {
      this.client.release();
      this.client = undefined;
    }
    this.listening = false;
    await this.pool.end();
  }
}

export function createPostgresAdapter(pool: Pool): PostgresAdapter {
  return new PostgresAdapter(pool);
}
