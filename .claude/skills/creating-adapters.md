# Creating Database Adapters for izi-queue

Use this skill when implementing support for a new database.

## DatabaseAdapter Interface

All adapters must implement this interface:

```typescript
export interface DatabaseAdapter {
  // Lifecycle
  migrate(): Promise<void>;
  close(): Promise<void>;

  // Job operations
  insertJob(job: Omit<Job, 'id' | 'insertedAt'>): Promise<Job>;
  updateJob(id: number, updates: Partial<Job>): Promise<Job | null>;
  getJob(id: number): Promise<Job | null>;

  // Queue operations
  fetchJobs(queue: string, limit: number): Promise<Job[]>;
  stageJobs(): Promise<number>;
  cancelJobs(criteria: { queue?: string; worker?: string; state?: JobState[] }): Promise<number>;
  rescueStuckJobs(rescueAfter: number): Promise<number>;
  pruneJobs(maxAge: number): Promise<number>;

  // Uniqueness (optional)
  checkUnique?(options: UniqueOptions, job: Omit<Job, 'id' | 'insertedAt'>): Promise<Job | null>;

  // Real-time (optional)
  listen?(callback: (event: { queue: string }) => void): Promise<void>;
  notify?(queue: string): Promise<void>;
}
```

## Adapter Structure

```typescript
// src/database/newdb.ts
import type { DatabaseAdapter, Job, JobState, UniqueOptions } from '../types.js';

export class NewDBAdapter implements DatabaseAdapter {
  private db: NewDBConnection;

  constructor(connection: NewDBConnection) {
    this.db = connection;
  }

  async migrate(): Promise<void> {
    // Create izi_jobs table
    // Create izi_migrations table
    // Run pending migrations
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async insertJob(job: Omit<Job, 'id' | 'insertedAt'>): Promise<Job> {
    // INSERT INTO izi_jobs ...
    // Return complete Job with id and insertedAt
  }

  async fetchJobs(queue: string, limit: number): Promise<Job[]> {
    // SELECT with FOR UPDATE SKIP LOCKED (if supported)
    // UPDATE state to 'executing'
    // Return fetched jobs
  }

  // ... implement remaining methods
}

// Factory function
export function createNewDBAdapter(connection: NewDBConnection): NewDBAdapter {
  return new NewDBAdapter(connection);
}
```

## Required Table Schema

```sql
CREATE TABLE izi_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state VARCHAR(20) NOT NULL DEFAULT 'available',
  queue VARCHAR(255) NOT NULL DEFAULT 'default',
  worker VARCHAR(255) NOT NULL,
  args JSON NOT NULL DEFAULT '{}',
  meta JSON NOT NULL DEFAULT '{}',
  tags JSON NOT NULL DEFAULT '[]',
  errors JSON NOT NULL DEFAULT '[]',
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 20,
  priority INTEGER NOT NULL DEFAULT 0,
  inserted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  scheduled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempted_at TIMESTAMP,
  completed_at TIMESTAMP,
  discarded_at TIMESTAMP,
  cancelled_at TIMESTAMP
);

-- Required indexes
CREATE INDEX idx_izi_jobs_queue_state ON izi_jobs (queue, state);
CREATE INDEX idx_izi_jobs_scheduled_at ON izi_jobs (scheduled_at);
CREATE INDEX idx_izi_jobs_state ON izi_jobs (state);
```

## Critical Methods

### fetchJobs

This is the most important method. It must:
1. Select available jobs for the queue
2. Mark them as 'executing' atomically
3. Use locking to prevent duplicate fetches

```typescript
async fetchJobs(queue: string, limit: number): Promise<Job[]> {
  // PostgreSQL with FOR UPDATE SKIP LOCKED
  const result = await this.db.query(`
    UPDATE izi_jobs
    SET state = 'executing', attempted_at = NOW(), attempt = attempt + 1
    WHERE id IN (
      SELECT id FROM izi_jobs
      WHERE queue = $1 AND state = 'available' AND scheduled_at <= NOW()
      ORDER BY priority ASC, scheduled_at ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `, [queue, limit]);

  return result.rows.map(row => this.rowToJob(row));
}
```

For databases without `SKIP LOCKED`, use transactions with retry logic.

### stageJobs

Move scheduled jobs to available when their time comes:

```typescript
async stageJobs(): Promise<number> {
  const result = await this.db.query(`
    UPDATE izi_jobs
    SET state = 'available'
    WHERE state IN ('scheduled', 'retryable')
      AND scheduled_at <= $1
  `, [new Date()]);

  return result.rowCount;
}
```

### rescueStuckJobs

Rescue jobs stuck in 'executing' state (crashed workers):

```typescript
async rescueStuckJobs(rescueAfter: number): Promise<number> {
  const cutoff = new Date(Date.now() - rescueAfter * 1000);

  const result = await this.db.query(`
    UPDATE izi_jobs
    SET state = 'available', scheduled_at = $1
    WHERE state = 'executing' AND attempted_at < $2
  `, [new Date(), cutoff]);

  return result.rowCount;
}
```

## Row Conversion

Convert database rows to Job objects:

```typescript
private rowToJob(row: any): Job {
  return {
    id: row.id,
    state: row.state,
    queue: row.queue,
    worker: row.worker,
    args: typeof row.args === 'string' ? JSON.parse(row.args) : row.args,
    meta: typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta,
    tags: typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags,
    errors: typeof row.errors === 'string' ? JSON.parse(row.errors) : row.errors,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    priority: row.priority,
    insertedAt: new Date(row.inserted_at),
    scheduledAt: new Date(row.scheduled_at),
    attemptedAt: row.attempted_at ? new Date(row.attempted_at) : null,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    discardedAt: row.discarded_at ? new Date(row.discarded_at) : null,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at) : null,
  };
}
```

## Migrations

Store migration state:

```sql
CREATE TABLE izi_migrations (
  version INTEGER PRIMARY KEY,
  migrated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Run migrations on startup:

```typescript
async migrate(): Promise<void> {
  // Create migrations table if not exists
  // Get current version
  // Run pending migrations
  // Record migration version
}
```

## Testing

Create comprehensive tests:

```typescript
describe('NewDBAdapter', () => {
  let adapter: NewDBAdapter;

  beforeEach(async () => {
    // Use test database or in-memory
    const connection = createTestConnection();
    adapter = new NewDBAdapter(connection);
    await adapter.migrate();
  });

  afterEach(async () => {
    await adapter.close();
  });

  it('should insert and fetch jobs', async () => {
    const job = await adapter.insertJob({
      state: 'available',
      queue: 'default',
      worker: 'test',
      args: { key: 'value' },
      // ... other fields
    });

    expect(job.id).toBeDefined();
    expect(job.args).toEqual({ key: 'value' });

    const fetched = await adapter.fetchJobs('default', 1);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].state).toBe('executing');
  });

  // Test all interface methods
});
```

## Export

Add to `src/database/index.ts`:

```typescript
export { NewDBAdapter, createNewDBAdapter } from './newdb.js';
```

And main entry `src/index.ts` if public:

```typescript
export { createNewDBAdapter } from './database/index.js';
```
