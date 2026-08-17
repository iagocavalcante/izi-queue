import type {
  DatabaseAdapter,
  Job,
  JobOrderBy,
  JobOrderByField,
  JobState,
  JobStateCounts,
  Logger
} from '../types.js';
import { DEFAULT_UNIQUE_PERIOD, DEFAULT_UNIQUE_STATES } from '../core/unique.js';
import { consoleLogger } from '../core/logger.js';

/** SQL dialects `criteriaClause`'s tags handling branches on. */
export type SqlDialect = 'postgres' | 'mysql' | 'sqlite';

/**
 * Seconds a node may go without a heartbeat before it is presumed dead and its
 * in-flight jobs become eligible for rescue. Four missed beats at the default
 * 15s heartbeat interval.
 */
export const DEFAULT_NODE_TTL = 60;

/**
 * Default number of rows `pruneJobs`/`stageJobs` touch per statement. Both
 * operations run in bounded batches rather than one unbounded, heavily-locking
 * DELETE/UPDATE over the whole backlog -- see `runInBatches`.
 */
export const DEFAULT_BATCH_SIZE = 5000;

/**
 * Repeatedly calls `operation(limit)` -- which should perform at most `limit`
 * rows of work and return how many it actually touched -- until a call
 * touches fewer than `limit` rows, i.e. the backlog is exhausted. Yields to
 * the event loop between calls so a large backlog is worked as many short
 * statements instead of a single long-running one that locks the table for
 * its entire duration.
 */
export async function runInBatches(
  operation: (limit: number) => Promise<number>,
  limit: number
): Promise<number> {
  // A non-positive or non-finite limit can never be exceeded by `affected`,
  // which would otherwise turn the loop below into one that never stops:
  // fail loudly instead of hanging with a runaway timer.
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`runInBatches: limit must be a positive number, got ${limit}`);
  }

  let total = 0;

  for (;;) {
    const affected = await operation(limit);
    total += affected;

    if (affected < limit) return total;

    // Give the event loop -- and any queue polling the same table -- a chance
    // to run between batches instead of monopolizing it.
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

export const SQL = {
  postgres: {
    createTable: `
      CREATE TABLE IF NOT EXISTS izi_jobs (
        id BIGSERIAL PRIMARY KEY,
        state VARCHAR(20) NOT NULL DEFAULT 'available',
        queue VARCHAR(255) NOT NULL DEFAULT 'default',
        worker VARCHAR(255) NOT NULL,
        args JSONB NOT NULL DEFAULT '{}',
        meta JSONB NOT NULL DEFAULT '{}',
        tags TEXT[] NOT NULL DEFAULT '{}',
        errors JSONB NOT NULL DEFAULT '[]',
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 20,
        priority INTEGER NOT NULL DEFAULT 0,
        inserted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        attempted_at TIMESTAMP WITH TIME ZONE,
        completed_at TIMESTAMP WITH TIME ZONE,
        discarded_at TIMESTAMP WITH TIME ZONE,
        cancelled_at TIMESTAMP WITH TIME ZONE
      )
    `,
    createIndexes: [
      'CREATE INDEX IF NOT EXISTS izi_jobs_queue_state_idx ON izi_jobs (queue, state)',
      'CREATE INDEX IF NOT EXISTS izi_jobs_scheduled_at_idx ON izi_jobs (scheduled_at) WHERE state = \'scheduled\'',
      'CREATE INDEX IF NOT EXISTS izi_jobs_state_idx ON izi_jobs (state)'
    ],
    insertJob: `
      INSERT INTO izi_jobs (state, queue, worker, args, meta, tags, errors, attempt, max_attempts, priority, scheduled_at, unique_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `,
    fetchJobs: `
      WITH claimed AS (
        UPDATE izi_jobs
        SET state = 'executing', attempted_at = NOW(), attempt = attempt + 1, attempted_by = $3
        WHERE id IN (
          SELECT id FROM izi_jobs
          WHERE queue = $1 AND state = 'available'
          ORDER BY priority ASC, scheduled_at ASC, id ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      )
      SELECT * FROM claimed ORDER BY priority ASC, scheduled_at ASC, id ASC
    `,
    updateJob: `
      UPDATE izi_jobs
      SET state = COALESCE($2, state),
          errors = COALESCE($3, errors),
          completed_at = COALESCE($4, completed_at),
          discarded_at = COALESCE($5, discarded_at),
          cancelled_at = COALESCE($6, cancelled_at),
          scheduled_at = COALESCE($7, scheduled_at),
          meta = COALESCE($8, meta)
      WHERE id = $1
      RETURNING *
    `,
    getJob: 'SELECT * FROM izi_jobs WHERE id = $1',
    // Postgres has no issue reading the target table in a DELETE/UPDATE's own
    // subquery (unlike MySQL), so a plain `id IN (SELECT ...)` is enough to
    // bound the statement to one batch.
    pruneJobs: `
      DELETE FROM izi_jobs
      WHERE id IN (
        SELECT id FROM izi_jobs
        WHERE state IN ('completed', 'discarded', 'cancelled')
          AND COALESCE(completed_at, discarded_at, cancelled_at) < NOW() - INTERVAL '1 second' * $1
        LIMIT $2
      )
    `,
    stageJobs: `
      UPDATE izi_jobs
      SET state = 'available'
      WHERE id IN (
        SELECT id FROM izi_jobs
        WHERE state IN ('scheduled', 'retryable') AND scheduled_at <= NOW()
        LIMIT $1
      )
    `,
    cancelJobs: `
      UPDATE izi_jobs
      SET state = 'cancelled', cancelled_at = NOW()
      WHERE state NOT IN ('completed', 'discarded', 'cancelled')
    `,
    rescueStuckJobs: `
      UPDATE izi_jobs
      SET state = CASE WHEN attempt >= max_attempts THEN 'discarded' ELSE 'available' END,
          scheduled_at = NOW(),
          discarded_at = CASE WHEN attempt >= max_attempts THEN NOW() ELSE discarded_at END
      WHERE state = 'executing'
        AND attempted_at < NOW() - INTERVAL '1 second' * $1
        AND (
          attempted_by IS NULL
          OR attempted_by NOT IN (
            SELECT name FROM izi_nodes
            WHERE heartbeat_at > NOW() - INTERVAL '1 second' * $2
          )
        )
      RETURNING *
    `,
    heartbeat: `
      INSERT INTO izi_nodes (name, heartbeat_at) VALUES ($1, NOW())
      ON CONFLICT (name) DO UPDATE SET heartbeat_at = NOW()
    `,
    removeNode: 'DELETE FROM izi_nodes WHERE name = $1',
    pruneNodes: `DELETE FROM izi_nodes WHERE heartbeat_at < NOW() - INTERVAL '1 second' * $1`,
    checkUnique: `
      SELECT * FROM izi_jobs
      WHERE worker = $1
        AND state = ANY($2)
        AND inserted_at > NOW() - INTERVAL '1 second' * $3
    `
  },

  mysql: {
    createTable: `
      CREATE TABLE IF NOT EXISTS izi_jobs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        state VARCHAR(20) NOT NULL DEFAULT 'available',
        queue VARCHAR(255) NOT NULL DEFAULT 'default',
        worker VARCHAR(255) NOT NULL,
        args JSON NOT NULL,
        meta JSON NOT NULL,
        tags JSON NOT NULL,
        errors JSON NOT NULL,
        attempt INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 20,
        priority INT NOT NULL DEFAULT 0,
        inserted_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        scheduled_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        attempted_at TIMESTAMP(6) NULL,
        completed_at TIMESTAMP(6) NULL,
        discarded_at TIMESTAMP(6) NULL,
        cancelled_at TIMESTAMP(6) NULL,
        INDEX idx_queue_state (queue, state),
        INDEX idx_scheduled_at (scheduled_at),
        INDEX idx_state (state)
      )
    `,
    insertJob: `
      INSERT INTO izi_jobs (state, queue, worker, args, meta, tags, errors, attempt, max_attempts, priority, scheduled_at, unique_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    fetchJobs: `
      SELECT * FROM izi_jobs
      WHERE queue = ? AND state = 'available'
      ORDER BY priority ASC, scheduled_at ASC, id ASC
      LIMIT ?
      FOR UPDATE SKIP LOCKED
    `,
    updateFetched: `
      UPDATE izi_jobs
      SET state = 'executing', attempted_at = NOW(6), attempt = attempt + 1, attempted_by = ?
      WHERE id IN (?)
    `,
    updateJob: `
      UPDATE izi_jobs
      SET state = COALESCE(?, state),
          errors = COALESCE(?, errors),
          completed_at = COALESCE(?, completed_at),
          discarded_at = COALESCE(?, discarded_at),
          cancelled_at = COALESCE(?, cancelled_at),
          scheduled_at = COALESCE(?, scheduled_at),
          meta = COALESCE(?, meta)
      WHERE id = ?
    `,
    getJob: 'SELECT * FROM izi_jobs WHERE id = ?',
    // MySQL raises ERROR 1093 ("You can't specify target table for update in
    // FROM clause") for `DELETE ... WHERE id IN (SELECT id FROM same_table)`,
    // so the inner SELECT must be wrapped in a derived table -- MySQL
    // materializes that as a separate result set, which sidesteps the check.
    pruneJobs: `
      DELETE FROM izi_jobs
      WHERE id IN (
        SELECT id FROM (
          SELECT id FROM izi_jobs
          WHERE state IN ('completed', 'discarded', 'cancelled')
            AND COALESCE(completed_at, discarded_at, cancelled_at) < DATE_SUB(NOW(), INTERVAL ? SECOND)
          LIMIT ?
        ) AS batch
      )
    `,
    stageJobs: `
      UPDATE izi_jobs
      SET state = 'available'
      WHERE id IN (
        SELECT id FROM (
          SELECT id FROM izi_jobs
          WHERE state IN ('scheduled', 'retryable') AND scheduled_at <= NOW()
          LIMIT ?
        ) AS batch
      )
    `,
    cancelJobs: `
      UPDATE izi_jobs
      SET state = 'cancelled', cancelled_at = NOW()
      WHERE state NOT IN ('completed', 'discarded', 'cancelled')
    `,
    rescueStuckJobs: `
      UPDATE izi_jobs
      SET state = CASE WHEN attempt >= max_attempts THEN 'discarded' ELSE 'available' END,
          scheduled_at = NOW(6),
          discarded_at = CASE WHEN attempt >= max_attempts THEN NOW(6) ELSE discarded_at END
      WHERE state = 'executing'
        AND attempted_at < DATE_SUB(NOW(), INTERVAL ? SECOND)
        AND (
          attempted_by IS NULL
          OR attempted_by NOT IN (
            SELECT name FROM izi_nodes
            WHERE heartbeat_at > DATE_SUB(NOW(), INTERVAL ? SECOND)
          )
        )
    `,
    heartbeat: `
      INSERT INTO izi_nodes (name, heartbeat_at) VALUES (?, NOW(6))
      ON DUPLICATE KEY UPDATE heartbeat_at = NOW(6)
    `,
    removeNode: 'DELETE FROM izi_nodes WHERE name = ?',
    pruneNodes: 'DELETE FROM izi_nodes WHERE heartbeat_at < DATE_SUB(NOW(), INTERVAL ? SECOND)',
    checkUnique: `
      SELECT * FROM izi_jobs
      WHERE worker = ?
        AND state IN (?)
        AND inserted_at > DATE_SUB(NOW(), INTERVAL ? SECOND)
    `
  },

  sqlite: {
    createTable: `
      CREATE TABLE IF NOT EXISTS izi_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        state TEXT NOT NULL DEFAULT 'available',
        queue TEXT NOT NULL DEFAULT 'default',
        worker TEXT NOT NULL,
        args TEXT NOT NULL DEFAULT '{}',
        meta TEXT NOT NULL DEFAULT '{}',
        tags TEXT NOT NULL DEFAULT '[]',
        errors TEXT NOT NULL DEFAULT '[]',
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 20,
        priority INTEGER NOT NULL DEFAULT 0,
        inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
        scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
        attempted_at TEXT,
        completed_at TEXT,
        discarded_at TEXT,
        cancelled_at TEXT
      )
    `,
    createIndexes: [
      'CREATE INDEX IF NOT EXISTS izi_jobs_queue_state_idx ON izi_jobs (queue, state)',
      'CREATE INDEX IF NOT EXISTS izi_jobs_scheduled_at_idx ON izi_jobs (scheduled_at)',
      'CREATE INDEX IF NOT EXISTS izi_jobs_state_idx ON izi_jobs (state)'
    ],
    insertJob: `
      INSERT INTO izi_jobs (state, queue, worker, args, meta, tags, errors, attempt, max_attempts, priority, scheduled_at, unique_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    fetchJobs: `
      UPDATE izi_jobs
      SET state = 'executing', attempted_at = datetime('now'), attempt = attempt + 1, attempted_by = ?
      WHERE id IN (
        SELECT id FROM izi_jobs
        WHERE queue = ? AND state = 'available'
        ORDER BY priority ASC, scheduled_at ASC, id ASC
        LIMIT ?
      )
      RETURNING *
    `,
    updateJob: `
      UPDATE izi_jobs
      SET state = COALESCE(?, state),
          errors = COALESCE(?, errors),
          completed_at = COALESCE(?, completed_at),
          discarded_at = COALESCE(?, discarded_at),
          cancelled_at = COALESCE(?, cancelled_at),
          scheduled_at = COALESCE(?, scheduled_at),
          meta = COALESCE(?, meta)
      WHERE id = ?
      RETURNING *
    `,
    getJob: 'SELECT * FROM izi_jobs WHERE id = ?',
    // SQLite's DELETE/UPDATE ... LIMIT syntax only works when the library was
    // compiled with SQLITE_ENABLE_UPDATE_DELETE_LIMIT, which better-sqlite3's
    // bundled build is not. `id IN (SELECT ... LIMIT n)` bounds the batch with
    // standard SQL instead; unlike MySQL, SQLite has no restriction against a
    // DELETE/UPDATE's subquery reading the table being modified.
    pruneJobs: `
      DELETE FROM izi_jobs
      WHERE id IN (
        SELECT id FROM izi_jobs
        WHERE state IN ('completed', 'discarded', 'cancelled')
          AND datetime(COALESCE(completed_at, discarded_at, cancelled_at)) < datetime('now', '-' || ? || ' seconds')
        LIMIT ?
      )
    `,
    stageJobs: `
      UPDATE izi_jobs
      SET state = 'available'
      WHERE id IN (
        SELECT id FROM izi_jobs
        WHERE state IN ('scheduled', 'retryable') AND datetime(scheduled_at) <= datetime('now')
        LIMIT ?
      )
    `,
    cancelJobs: `
      UPDATE izi_jobs
      SET state = 'cancelled', cancelled_at = datetime('now')
      WHERE state NOT IN ('completed', 'discarded', 'cancelled')
    `,
    rescueStuckJobs: `
      UPDATE izi_jobs
      SET state = CASE WHEN attempt >= max_attempts THEN 'discarded' ELSE 'available' END,
          scheduled_at = datetime('now'),
          discarded_at = CASE WHEN attempt >= max_attempts THEN datetime('now') ELSE discarded_at END
      WHERE state = 'executing'
        AND datetime(attempted_at) < datetime('now', '-' || ? || ' seconds')
        AND (
          attempted_by IS NULL
          OR attempted_by NOT IN (
            SELECT name FROM izi_nodes
            WHERE datetime(heartbeat_at) > datetime('now', '-' || ? || ' seconds')
          )
        )
      RETURNING *
    `,
    heartbeat: `
      INSERT INTO izi_nodes (name, heartbeat_at) VALUES (?, datetime('now'))
      ON CONFLICT(name) DO UPDATE SET heartbeat_at = datetime('now')
    `,
    removeNode: 'DELETE FROM izi_nodes WHERE name = ?',
    pruneNodes: `DELETE FROM izi_nodes WHERE datetime(heartbeat_at) < datetime('now', '-' || ? || ' seconds')`,
    checkUnique: `
      SELECT * FROM izi_jobs
      WHERE worker = ?
        AND state IN (SELECT value FROM json_each(?))
        AND datetime(inserted_at) > datetime('now', '-' || ? || ' seconds')
    `
  }
};

/**
 * Appends the dialect-specific match-any tags predicate. `tags` is stored as
 * `TEXT[]` on Postgres, and as a JSON array of strings on MySQL and SQLite --
 * each dialect needs its own operator to express "shares at least one tag":
 *
 * - Postgres: `&&`, the native array-overlap operator.
 * - MySQL: `JSON_OVERLAPS`, available from 8.0.17 (the `mysql:8` image this
 *   library is tested against ships well past that).
 * - SQLite: no overlap builtin, so `EXISTS` over `json_each` -- the same JSON1
 *   function `checkUnique` already relies on -- checking membership per tag.
 */
function tagsClause(
  dialect: SqlDialect,
  tags: string[],
  placeholder: (index: number) => string,
  index: number
): { clause: string; params: unknown[] } {
  if (dialect === 'postgres') {
    return { clause: ` AND tags && ${placeholder(index)}`, params: [tags] };
  }
  if (dialect === 'mysql') {
    return { clause: ` AND JSON_OVERLAPS(tags, ${placeholder(index)})`, params: [JSON.stringify(tags)] };
  }
  const placeholders = tags.map((_, i) => placeholder(index + i)).join(',');
  return {
    clause: ` AND EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value IN (${placeholders}))`,
    params: [...tags]
  };
}

/**
 * Builds the shared filter for bulk job operations (`cancelJobs`,
 * `retryJobs`) and for the read-only query API (`listJobs`, `countJobs`). An
 * empty criteria object is rejected by callers of the bulk operations rather
 * than silently matching every job -- see `assertScoped` in `izi-queue.ts`;
 * `listJobs`/`countJobs` are read-only and impose no such requirement.
 */
export function criteriaClause(
  criteria: import('../types.js').JobCriteria,
  placeholder: (index: number) => string,
  dialect: SqlDialect
): { clause: string; params: unknown[] } {
  const params: unknown[] = [];
  let clause = '';
  let index = 1;

  if (criteria.ids && criteria.ids.length > 0) {
    clause += ` AND id IN (${criteria.ids.map(() => placeholder(index++)).join(',')})`;
    params.push(...criteria.ids);
  }
  if (criteria.queue) {
    clause += ` AND queue = ${placeholder(index++)}`;
    params.push(criteria.queue);
  }
  if (criteria.worker) {
    clause += ` AND worker = ${placeholder(index++)}`;
    params.push(criteria.worker);
  }
  if (criteria.state && criteria.state.length > 0) {
    clause += ` AND state IN (${criteria.state.map(() => placeholder(index++)).join(',')})`;
    params.push(...criteria.state);
  }
  if (criteria.tags && criteria.tags.length > 0) {
    const tags = tagsClause(dialect, criteria.tags, placeholder, index);
    clause += tags.clause;
    params.push(...tags.params);
    index += dialect === 'sqlite' ? criteria.tags.length : 1;
  }

  return { clause, params };
}

/**
 * Default and maximum row count `listJobs` returns per call. The default
 * keeps an unbounded dashboard query cheap; the cap means a caller-supplied
 * `limit` can never turn `listJobs` into an unbounded scan of `izi_jobs`,
 * mirroring why `pruneJobs`/`stageJobs` batch instead of running unbounded.
 */
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 1000;

/** Validates and clamps `listJobs`' `limit`, applying `DEFAULT_LIST_LIMIT`. */
export function resolveListLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`izi-queue: listJobs limit must be a positive integer, got ${limit}`);
  }
  return Math.min(limit, MAX_LIST_LIMIT);
}

/** Validates `listJobs`' `offset`, defaulting to 0. */
export function resolveListOffset(offset?: number): number {
  if (offset === undefined) return 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`izi-queue: listJobs offset must be a non-negative integer, got ${offset}`);
  }
  return offset;
}

/**
 * Maps a whitelisted `JobOrderByField` to its column. The whitelist is the
 * point: `orderBy` can never carry a caller-supplied column name into SQL,
 * which is the injection class fixed in #18.
 */
const JOB_ORDER_BY_COLUMNS: Record<JobOrderByField, string> = {
  id: 'id',
  priority: 'priority',
  scheduledAt: 'scheduled_at',
  insertedAt: 'inserted_at',
  attemptedAt: 'attempted_at'
};

const DEFAULT_ORDER_BY: Required<JobOrderBy> = { field: 'insertedAt', direction: 'desc' };

/**
 * Builds `listJobs`' `ORDER BY` clause. Every ordering also breaks ties on
 * `id` in the same direction, so two jobs sharing the primary sort value
 * (e.g. the same `insertedAt` millisecond) still sort deterministically --
 * without that, `limit`/`offset` pagination could skip or repeat a row
 * across pages depending on how the database happened to break the tie.
 */
export function orderByClause(orderBy?: JobOrderBy): string {
  const field = orderBy?.field ?? DEFAULT_ORDER_BY.field;
  const direction = orderBy?.direction ?? DEFAULT_ORDER_BY.direction;

  if (direction !== 'asc' && direction !== 'desc') {
    throw new Error(`izi-queue: listJobs orderBy.direction must be 'asc' or 'desc', got ${String(direction)}`);
  }

  const column = JOB_ORDER_BY_COLUMNS[field];
  if (!column) {
    throw new Error(
      `izi-queue: invalid listJobs orderBy.field "${String(field)}". Must be one of: ${Object.keys(JOB_ORDER_BY_COLUMNS).join(', ')}`
    );
  }

  const sqlDirection = direction.toUpperCase();
  const tiebreak = field === 'id' ? '' : `, id ${sqlDirection}`;
  return `ORDER BY ${column} ${sqlDirection}${tiebreak}`;
}

/** Every job state, used to seed `countJobs`' result so every key is present. */
export const JOB_STATES: JobState[] = [
  'scheduled',
  'available',
  'executing',
  'retryable',
  'completed',
  'discarded',
  'cancelled'
];

/**
 * Builds `countJobs`' result from `SELECT state, COUNT(*) ... GROUP BY state`
 * rows, seeding every `JobState` at 0 first so a caller never has to guard
 * against a state with no matching jobs being absent from the result.
 */
export function buildStateCounts(rows: { state: string; count: number | string | bigint }[]): JobStateCounts {
  const counts = Object.fromEntries(JOB_STATES.map(state => [state, 0])) as JobStateCounts;
  for (const row of rows) {
    counts[row.state as JobState] = Number(row.count);
  }
  return counts;
}

export function rowToJob(row: Record<string, unknown>): Job {
  const parseJSON = (val: unknown): unknown => {
    if (typeof val === 'string') {
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    }
    return val;
  };

  const parseDate = (val: unknown): Date | null => {
    if (!val) return null;
    if (val instanceof Date) return val;
    return new Date(val as string);
  };

  return {
    id: Number(row.id),
    state: row.state as JobState,
    queue: row.queue as string,
    worker: row.worker as string,
    args: parseJSON(row.args) as Record<string, unknown>,
    meta: parseJSON(row.meta) as Record<string, unknown>,
    tags: parseJSON(row.tags) as string[],
    errors: parseJSON(row.errors) as Job['errors'],
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    priority: Number(row.priority),
    insertedAt: parseDate(row.inserted_at) as Date,
    scheduledAt: parseDate(row.scheduled_at) as Date,
    attemptedAt: parseDate(row.attempted_at),
    attemptedBy: (row.attempted_by as string | null) ?? null,
    uniqueKey: (row.unique_key as string | null) ?? null,
    completedAt: parseDate(row.completed_at),
    discardedAt: parseDate(row.discarded_at),
    cancelledAt: parseDate(row.cancelled_at)
  };
}

export abstract class BaseAdapter implements DatabaseAdapter {
  /**
   * Defaults to `consoleLogger`, independently of any logger the owning
   * `IziQueue` may be given -- see the `logger` doc on `IziQueueConfig` for
   * why the two are not linked automatically.
   */
  protected readonly logger: Logger;

  constructor(logger: Logger = consoleLogger) {
    this.logger = logger;
  }

  abstract migrate(): Promise<void>;
  abstract insertJob(job: Omit<Job, 'id' | 'insertedAt'>): Promise<Job>;
  abstract fetchJobs(queue: string, limit: number, node?: string): Promise<Job[]>;
  abstract updateJob(id: number, updates: Partial<Job>, expectedStates?: JobState[]): Promise<Job | null>;
  abstract getJob(id: number): Promise<Job | null>;
  abstract pruneJobs(maxAge: number, limit?: number): Promise<number>;
  abstract stageJobs(limit?: number): Promise<number>;
  abstract cancelJobs(criteria: import('../types.js').JobCriteria): Promise<number>;
  abstract rescueStuckJobs(rescueAfter: number, nodeTtl?: number): Promise<number>;

  /** Shared predicate for locating an existing unique job. */
  protected uniqueLookup(options: import('../types.js').UniqueOptions): {
    states: string[];
    period: number | null;
  } {
    const states = options.states ?? DEFAULT_UNIQUE_STATES;
    const period = options.period === 'infinity' ? null : (options.period ?? DEFAULT_UNIQUE_PERIOD);
    return { states, period };
  }
  abstract close(): Promise<void>;
}
