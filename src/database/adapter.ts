import type { DatabaseAdapter, Job, JobState } from '../types.js';

/**
 * Seconds a node may go without a heartbeat before it is presumed dead and its
 * in-flight jobs become eligible for rescue. Four missed beats at the default
 * 15s heartbeat interval.
 */
export const DEFAULT_NODE_TTL = 60;

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
      INSERT INTO izi_jobs (state, queue, worker, args, meta, tags, errors, attempt, max_attempts, priority, scheduled_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `,
    fetchJobs: `
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
    pruneJobs: `
      DELETE FROM izi_jobs
      WHERE state IN ('completed', 'discarded', 'cancelled')
        AND COALESCE(completed_at, discarded_at, cancelled_at) < NOW() - INTERVAL '1 second' * $1
    `,
    stageJobs: `
      UPDATE izi_jobs
      SET state = 'available'
      WHERE state IN ('scheduled', 'retryable') AND scheduled_at <= NOW()
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
      INSERT INTO izi_jobs (state, queue, worker, args, meta, tags, errors, attempt, max_attempts, priority, scheduled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    pruneJobs: `
      DELETE FROM izi_jobs
      WHERE state IN ('completed', 'discarded', 'cancelled')
        AND COALESCE(completed_at, discarded_at, cancelled_at) < DATE_SUB(NOW(), INTERVAL ? SECOND)
    `,
    stageJobs: `
      UPDATE izi_jobs
      SET state = 'available'
      WHERE state IN ('scheduled', 'retryable') AND scheduled_at <= NOW()
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
      INSERT INTO izi_jobs (state, queue, worker, args, meta, tags, errors, attempt, max_attempts, priority, scheduled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    pruneJobs: `
      DELETE FROM izi_jobs
      WHERE state IN ('completed', 'discarded', 'cancelled')
        AND datetime(COALESCE(completed_at, discarded_at, cancelled_at)) < datetime('now', '-' || ? || ' seconds')
    `,
    stageJobs: `
      UPDATE izi_jobs
      SET state = 'available'
      WHERE state IN ('scheduled', 'retryable') AND datetime(scheduled_at) <= datetime('now')
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
    completedAt: parseDate(row.completed_at),
    discardedAt: parseDate(row.discarded_at),
    cancelledAt: parseDate(row.cancelled_at)
  };
}

export abstract class BaseAdapter implements DatabaseAdapter {
  abstract migrate(): Promise<void>;
  abstract insertJob(job: Omit<Job, 'id' | 'insertedAt'>): Promise<Job>;
  abstract fetchJobs(queue: string, limit: number, node?: string): Promise<Job[]>;
  abstract updateJob(id: number, updates: Partial<Job>): Promise<Job | null>;
  abstract getJob(id: number): Promise<Job | null>;
  abstract pruneJobs(maxAge: number): Promise<number>;
  abstract stageJobs(): Promise<number>;
  abstract cancelJobs(criteria: { queue?: string; worker?: string; state?: JobState[] }): Promise<number>;
  abstract rescueStuckJobs(rescueAfter: number, nodeTtl?: number): Promise<number>;
  abstract close(): Promise<void>;
}
