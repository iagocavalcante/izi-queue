export interface Migration {
  version: number;
  name: string;
  /**
   * One entry per statement. Deliberately not a single blob split on `;`:
   * that breaks on function bodies, triggers, and semicolons inside string
   * literals.
   */
  up: string[];
  down?: string[];
}

export const postgresMigrations: Migration[] = [
  {
    version: 1,
    name: 'create_izi_jobs_table',
    up: [
      `CREATE TABLE IF NOT EXISTS izi_jobs (
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
      )`,
      `CREATE INDEX IF NOT EXISTS izi_jobs_queue_state_idx ON izi_jobs (queue, state)`,
      `CREATE INDEX IF NOT EXISTS izi_jobs_scheduled_at_idx ON izi_jobs (scheduled_at) WHERE state = 'scheduled'`,
      `CREATE INDEX IF NOT EXISTS izi_jobs_state_idx ON izi_jobs (state)`
    ],
    down: [
      `DROP TABLE IF EXISTS izi_jobs`
    ]
  },
  {
    version: 2,
    name: 'create_migrations_table',
    up: [
      `CREATE TABLE IF NOT EXISTS izi_migrations (
        version INTEGER PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`
    ],
    down: [
      `DROP TABLE IF EXISTS izi_migrations`
    ]
  },
  {
    version: 3,
    name: 'add_unique_index',
    up: [
      `CREATE INDEX IF NOT EXISTS izi_jobs_worker_queue_args_idx
      ON izi_jobs (worker, queue, args)
      WHERE state IN ('available', 'scheduled', 'executing', 'retryable')`
    ],
    down: [
      `DROP INDEX IF EXISTS izi_jobs_worker_queue_args_idx`
    ]
  },
  {
    version: 4,
    name: 'add_attempted_at_index',
    up: [
      `CREATE INDEX IF NOT EXISTS izi_jobs_executing_attempted_idx
      ON izi_jobs (attempted_at)
      WHERE state = 'executing'`
    ],
    down: [
      `DROP INDEX IF EXISTS izi_jobs_executing_attempted_idx`
    ]
  },
  {
    version: 5,
    name: 'widen_stager_index_to_retryable',
    up: [
      `CREATE INDEX IF NOT EXISTS izi_jobs_stageable_idx
      ON izi_jobs (scheduled_at)
      WHERE state IN ('scheduled', 'retryable')`,
      `DROP INDEX IF EXISTS izi_jobs_scheduled_at_idx`
    ],
    down: [
      `CREATE INDEX IF NOT EXISTS izi_jobs_scheduled_at_idx
      ON izi_jobs (scheduled_at)
      WHERE state = 'scheduled'`,
      `DROP INDEX IF EXISTS izi_jobs_stageable_idx`
    ]
  },
  {
    version: 6,
    name: 'add_node_ownership',
    up: [
      `ALTER TABLE izi_jobs ADD COLUMN IF NOT EXISTS attempted_by VARCHAR(255)`,
      `CREATE TABLE IF NOT EXISTS izi_nodes (
        name VARCHAR(255) PRIMARY KEY,
        started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        heartbeat_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS izi_nodes_heartbeat_idx ON izi_nodes (heartbeat_at)`
    ],
    down: [
      `DROP TABLE IF EXISTS izi_nodes`,
      `ALTER TABLE izi_jobs DROP COLUMN IF EXISTS attempted_by`
    ]
  },
  {
    version: 7,
    name: 'add_unique_key',
    up: [
      `ALTER TABLE izi_jobs ADD COLUMN IF NOT EXISTS unique_key VARCHAR(64)`,
      `CREATE INDEX IF NOT EXISTS izi_jobs_unique_key_idx ON izi_jobs (unique_key) WHERE unique_key IS NOT NULL`,
      `DROP INDEX IF EXISTS izi_jobs_worker_queue_args_idx`
    ],
    down: [
      `CREATE INDEX IF NOT EXISTS izi_jobs_worker_queue_args_idx ON izi_jobs (worker, queue, args) WHERE state IN ('available', 'scheduled', 'executing', 'retryable')`,
      `DROP INDEX IF EXISTS izi_jobs_unique_key_idx`,
      `ALTER TABLE izi_jobs DROP COLUMN IF EXISTS unique_key`
    ]
  }
];

export const sqliteMigrations: Migration[] = [
  {
    version: 1,
    name: 'create_izi_jobs_table',
    up: [
      `CREATE TABLE IF NOT EXISTS izi_jobs (
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
      )`,
      `CREATE INDEX IF NOT EXISTS izi_jobs_queue_state_idx ON izi_jobs (queue, state)`,
      `CREATE INDEX IF NOT EXISTS izi_jobs_scheduled_at_idx ON izi_jobs (scheduled_at)`,
      `CREATE INDEX IF NOT EXISTS izi_jobs_state_idx ON izi_jobs (state)`
    ],
    down: [
      `DROP TABLE IF EXISTS izi_jobs`
    ]
  },
  {
    version: 2,
    name: 'create_migrations_table',
    up: [
      `CREATE TABLE IF NOT EXISTS izi_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    ],
    down: [
      `DROP TABLE IF EXISTS izi_migrations`
    ]
  },
  {
    version: 3,
    name: 'add_unique_index',
    up: [
      `CREATE INDEX IF NOT EXISTS izi_jobs_worker_queue_args_idx
      ON izi_jobs (worker, queue, args)`
    ],
    down: [
      `DROP INDEX IF EXISTS izi_jobs_worker_queue_args_idx`
    ]
  },
  {
    version: 4,
    name: 'add_attempted_at_index',
    up: [
      `CREATE INDEX IF NOT EXISTS izi_jobs_executing_attempted_idx
      ON izi_jobs (attempted_at)`
    ],
    down: [
      `DROP INDEX IF EXISTS izi_jobs_executing_attempted_idx`
    ]
  },
  {
    version: 5,
    name: 'add_node_ownership',
    up: [
      `ALTER TABLE izi_jobs ADD COLUMN attempted_by TEXT`,
      `CREATE TABLE IF NOT EXISTS izi_nodes (
        name TEXT PRIMARY KEY,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        heartbeat_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
      `CREATE INDEX IF NOT EXISTS izi_nodes_heartbeat_idx ON izi_nodes (heartbeat_at)`
    ],
    down: [
      `DROP TABLE IF EXISTS izi_nodes`
    ]
  },
  {
    version: 6,
    name: 'add_unique_key',
    up: [
      `ALTER TABLE izi_jobs ADD COLUMN unique_key TEXT`,
      `CREATE INDEX IF NOT EXISTS izi_jobs_unique_key_idx ON izi_jobs (unique_key)`,
      `DROP INDEX IF EXISTS izi_jobs_worker_queue_args_idx`
    ],
    down: [
      `DROP INDEX IF EXISTS izi_jobs_unique_key_idx`
    ]
  }
];

export const mysqlMigrations: Migration[] = [
  {
    version: 1,
    name: 'create_izi_jobs_table',
    up: [
      `CREATE TABLE IF NOT EXISTS izi_jobs (
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
      )`
    ],
    down: [
      `DROP TABLE IF EXISTS izi_jobs`
    ]
  },
  {
    version: 2,
    name: 'create_migrations_table',
    up: [
      `CREATE TABLE IF NOT EXISTS izi_migrations (
        version INT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    ],
    down: [
      `DROP TABLE IF EXISTS izi_migrations`
    ]
  },
  {
    version: 3,
    name: 'add_unique_index',
    up: [
      `CREATE INDEX izi_jobs_worker_queue_idx ON izi_jobs (worker, queue)`
    ],
    down: [
      `DROP INDEX izi_jobs_worker_queue_idx ON izi_jobs`
    ]
  },
  {
    version: 4,
    name: 'add_attempted_at_index',
    up: [
      `CREATE INDEX izi_jobs_attempted_at_idx ON izi_jobs (attempted_at)`
    ],
    down: [
      `DROP INDEX izi_jobs_attempted_at_idx ON izi_jobs`
    ]
  },
  {
    version: 5,
    name: 'add_node_ownership',
    up: [
      `ALTER TABLE izi_jobs ADD COLUMN attempted_by VARCHAR(255) NULL`,
      `CREATE TABLE IF NOT EXISTS izi_nodes (
        name VARCHAR(255) PRIMARY KEY,
        started_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        heartbeat_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        INDEX idx_heartbeat (heartbeat_at)
      )`
    ],
    down: [
      `DROP TABLE IF EXISTS izi_nodes`
    ]
  },
  {
    version: 6,
    name: 'add_unique_key',
    up: [
      `ALTER TABLE izi_jobs ADD COLUMN unique_key VARCHAR(64) NULL`,
      `CREATE INDEX izi_jobs_unique_key_idx ON izi_jobs (unique_key)`,
      `DROP INDEX izi_jobs_worker_queue_idx ON izi_jobs`
    ],
    down: [
      `DROP INDEX izi_jobs_unique_key_idx ON izi_jobs`
    ]
  }
];
