export interface Migration {
  version: number;
  name: string;
  up: string;
  down?: string;
}

export const postgresMigrations: Migration[] = [
  {
    version: 1,
    name: 'create_izi_jobs_table',
    up: `
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
      );

      CREATE INDEX IF NOT EXISTS izi_jobs_queue_state_idx ON izi_jobs (queue, state);
      CREATE INDEX IF NOT EXISTS izi_jobs_scheduled_at_idx ON izi_jobs (scheduled_at) WHERE state = 'scheduled';
      CREATE INDEX IF NOT EXISTS izi_jobs_state_idx ON izi_jobs (state);
    `,
    down: 'DROP TABLE IF EXISTS izi_jobs;'
  },
  {
    version: 2,
    name: 'create_migrations_table',
    up: `
      CREATE TABLE IF NOT EXISTS izi_migrations (
        version INTEGER PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `,
    down: 'DROP TABLE IF EXISTS izi_migrations;'
  },
  {
    version: 3,
    name: 'add_unique_index',
    up: `
      CREATE INDEX IF NOT EXISTS izi_jobs_worker_queue_args_idx
      ON izi_jobs (worker, queue, args)
      WHERE state IN ('available', 'scheduled', 'executing', 'retryable');
    `,
    down: 'DROP INDEX IF EXISTS izi_jobs_worker_queue_args_idx;'
  },
  {
    version: 4,
    name: 'add_attempted_at_index',
    up: `
      CREATE INDEX IF NOT EXISTS izi_jobs_executing_attempted_idx
      ON izi_jobs (attempted_at)
      WHERE state = 'executing';
    `,
    down: 'DROP INDEX IF EXISTS izi_jobs_executing_attempted_idx;'
  }
];

export const sqliteMigrations: Migration[] = [
  {
    version: 1,
    name: 'create_izi_jobs_table',
    up: `
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
      );

      CREATE INDEX IF NOT EXISTS izi_jobs_queue_state_idx ON izi_jobs (queue, state);
      CREATE INDEX IF NOT EXISTS izi_jobs_scheduled_at_idx ON izi_jobs (scheduled_at);
      CREATE INDEX IF NOT EXISTS izi_jobs_state_idx ON izi_jobs (state);
    `,
    down: 'DROP TABLE IF EXISTS izi_jobs;'
  },
  {
    version: 2,
    name: 'create_migrations_table',
    up: `
      CREATE TABLE IF NOT EXISTS izi_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
    down: 'DROP TABLE IF EXISTS izi_migrations;'
  },
  {
    version: 3,
    name: 'add_unique_index',
    up: `
      CREATE INDEX IF NOT EXISTS izi_jobs_worker_queue_args_idx
      ON izi_jobs (worker, queue, args);
    `,
    down: 'DROP INDEX IF EXISTS izi_jobs_worker_queue_args_idx;'
  },
  {
    version: 4,
    name: 'add_attempted_at_index',
    up: `
      CREATE INDEX IF NOT EXISTS izi_jobs_executing_attempted_idx
      ON izi_jobs (attempted_at);
    `,
    down: 'DROP INDEX IF EXISTS izi_jobs_executing_attempted_idx;'
  }
];

export const mysqlMigrations: Migration[] = [
  {
    version: 1,
    name: 'create_izi_jobs_table',
    up: `
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
      );
    `,
    down: 'DROP TABLE IF EXISTS izi_jobs;'
  },
  {
    version: 2,
    name: 'create_migrations_table',
    up: `
      CREATE TABLE IF NOT EXISTS izi_migrations (
        version INT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `,
    down: 'DROP TABLE IF EXISTS izi_migrations;'
  },
  {
    version: 3,
    name: 'add_unique_index',
    up: `
      CREATE INDEX izi_jobs_worker_queue_idx ON izi_jobs (worker, queue);
    `,
    down: 'DROP INDEX izi_jobs_worker_queue_idx ON izi_jobs;'
  },
  {
    version: 4,
    name: 'add_attempted_at_index',
    up: `
      CREATE INDEX izi_jobs_attempted_at_idx ON izi_jobs (attempted_at);
    `,
    down: 'DROP INDEX izi_jobs_attempted_at_idx ON izi_jobs;'
  }
];
