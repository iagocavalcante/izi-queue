# izi-queue Development Guide

This document describes the architecture, patterns, and conventions used in izi-queue. Use this as a reference when contributing or working with Claude Code.

## Project Overview

izi-queue is a minimal, reliable, database-backed job queue for Node.js inspired by Oban (Elixir). It uses your existing database (PostgreSQL, SQLite, or MySQL) as the job queue backend.

## Quick Commands

```bash
npm run build     # Compile TypeScript
npm run dev       # Watch mode
npm test          # Run tests
npm run lint      # Run ESLint
npm run benchmark # Performance benchmarks
```

## Project Structure

```
src/
├── index.ts              # Public API exports
├── types.ts              # All TypeScript types
├── core/
│   ├── index.ts          # Core exports
│   ├── izi-queue.ts      # Main IziQueue class (orchestrator)
│   ├── queue.ts          # Queue class (worker execution)
│   ├── job.ts            # Job state machine & backoff
│   ├── worker.ts         # Worker registry & execution
│   ├── telemetry.ts      # Event system
│   └── isolation/        # Worker thread pool
│       ├── index.ts
│       ├── executor.ts
│       ├── thread-pool.ts
│       └── worker-thread.ts
├── database/
│   ├── index.ts
│   ├── adapter.ts        # BaseAdapter interface
│   ├── postgres.ts       # PostgreSQL implementation
│   ├── sqlite.ts         # SQLite implementation
│   └── migrations.ts     # Migration definitions
└── plugins/
    ├── index.ts
    ├── plugin.ts         # BasePlugin abstract class
    ├── lifeline.ts       # Rescue stuck jobs
    └── pruner.ts         # Cleanup old jobs

tests/
├── *.test.ts             # Unit tests
├── integration.test.ts   # Full integration tests
└── isolation/            # Worker thread tests
```

## Architecture Patterns

### 1. Registry Pattern (Worker Management)

Workers are stored in a global Map registry for dynamic registration and lookup.

```typescript
// src/core/worker.ts
const workerRegistry = new Map<string, WorkerDefinition>();

export function registerWorker(definition: WorkerDefinition): void {
  workerRegistry.set(definition.name, definition);
}

export function getWorker(name: string): WorkerDefinition | undefined {
  return workerRegistry.get(name);
}
```

**When to use:** Any global lookup table that needs dynamic registration.

### 2. Adapter Pattern (Database Support)

Abstract interface with concrete implementations per database.

```typescript
// Interface in src/types.ts
export interface DatabaseAdapter {
  migrate(): Promise<void>;
  insertJob(job: Omit<Job, 'id' | 'insertedAt'>): Promise<Job>;
  fetchJobs(queue: string, limit: number): Promise<Job[]>;
  // ... more methods
}

// Concrete implementation in src/database/sqlite.ts
export class SQLiteAdapter implements DatabaseAdapter {
  async migrate(): Promise<void> { /* ... */ }
  async insertJob(job): Promise<Job> { /* ... */ }
}
```

**When to use:** Supporting multiple implementations of the same interface.

### 3. Factory Functions

Public API uses factory functions instead of exposing classes directly.

```typescript
// Good - factory function
export function createSQLiteAdapter(db: Database): SQLiteAdapter {
  return new SQLiteAdapter(db);
}

// Good - worker definition
export function defineWorker<T>(
  name: string,
  perform: (job: Job<T>) => Promise<WorkerResult | void>,
  options?: Partial<WorkerDefinition<T>>
): WorkerDefinition<T> {
  return { name, perform, ...options };
}
```

**Why:** Simpler API, better tree-shaking, easier testing.

### 4. State Machine (Job Lifecycle)

Jobs follow a strict state machine with validated transitions.

```
scheduled -> available -> executing -> completed
                      \-> retryable -> available
                      \-> discarded
                      \-> cancelled
```

```typescript
// src/core/job.ts
export const STATE_TRANSITIONS: Record<JobState, JobState[]> = {
  scheduled: ['available', 'cancelled'],
  available: ['executing', 'cancelled'],
  executing: ['completed', 'retryable', 'discarded', 'cancelled'],
  retryable: ['available', 'cancelled'],
  completed: [],
  discarded: [],
  cancelled: []
};

export function isValidTransition(from: JobState, to: JobState): boolean {
  return STATE_TRANSITIONS[from].includes(to);
}
```

### 5. Result Objects (Worker Results)

Workers return structured result objects instead of throwing errors.

```typescript
// src/core/worker.ts
export const WorkerResults = {
  ok: (value?: unknown): WorkerResult => ({ status: 'ok', value }),
  error: (error: Error | string): WorkerResult => ({ status: 'error', error }),
  cancel: (reason: string): WorkerResult => ({ status: 'cancel', reason }),
  snooze: (seconds: number): WorkerResult => ({ status: 'snooze', seconds })
};
```

**Why:** Type-safe, explicit control flow, no try-catch chains.

### 6. Plugin Architecture

Plugins extend functionality through lifecycle hooks.

```typescript
// src/plugins/plugin.ts
export abstract class BasePlugin implements Plugin {
  abstract readonly name: string;
  protected context?: PluginContext;
  protected running = false;

  async start(context: PluginContext): Promise<void> {
    if (this.running) return;
    this.context = context;
    this.running = true;
    await this.onStart();
  }

  protected abstract onStart(): Promise<void>;
  protected async onStop(): Promise<void> {}
  validate(): string[] { return []; }
}
```

**To create a plugin:** Extend `BasePlugin`, implement `onStart()`.

### 7. Observable Pattern (Telemetry)

Event-based system for monitoring and debugging.

```typescript
// src/core/telemetry.ts
class Telemetry {
  private handlers = new Map<string, Set<TelemetryHandler>>();

  on(event: TelemetryEvent | '*', handler: TelemetryHandler): void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
  }

  emit(event: TelemetryEvent, payload: Partial<TelemetryPayload>): void {
    // Emit to specific handlers
    this.handlers.get(event)?.forEach(h => h({ ...payload, event, timestamp: new Date() }));
    // Emit to wildcard handlers
    this.handlers.get('*')?.forEach(h => h({ ...payload, event, timestamp: new Date() }));
  }
}
```

## Coding Conventions

### TypeScript

- **Strict mode enabled** - No implicit any, null checks required
- **ES Modules** - Use `.js` extension in imports (`from './job.js'`)
- **Explicit types** - Export interfaces for public API

### Naming

| Element | Convention | Example |
|---------|------------|---------|
| Files | kebab-case | `izi-queue.ts` |
| Classes | PascalCase | `IziQueue` |
| Functions | camelCase | `registerWorker` |
| Constants | UPPER_SNAKE | `STATE_TRANSITIONS` |
| Types | PascalCase | `WorkerDefinition` |

### Error Handling

1. **Catch and format** - Don't let errors propagate unexpectedly
2. **Silent handlers** - Telemetry handlers wrapped in try-catch
3. **Structured errors** - Use `formatError()` for consistent error objects

```typescript
export function formatError(error: Error | string, attempt: number): JobError {
  const isError = error instanceof Error;
  return {
    at: new Date(),
    attempt,
    error: isError ? error.message : String(error),
    stacktrace: isError ? error.stack : undefined
  };
}
```

### Async Patterns

- **Exclusively async/await** - No callbacks
- **Promise.race for timeouts** - Clean timeout handling
- **Promise.all for parallel** - When operations are independent

```typescript
// Timeout pattern
const result = await Promise.race([
  worker.perform(job),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Timeout')), timeout)
  )
]);
```

## Database Patterns

### SQL Abstraction

Each adapter handles dialect-specific syntax:

- **PostgreSQL**: `FOR UPDATE SKIP LOCKED`, `JSONB`, `TEXT[]`
- **SQLite**: Transactions via `db.transaction()`, JSON as TEXT
- **MySQL**: `FOR UPDATE SKIP LOCKED`, JSON columns

### Job Table Schema

```sql
CREATE TABLE izi_jobs (
  id SERIAL PRIMARY KEY,
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
  inserted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  scheduled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempted_at TIMESTAMP,
  completed_at TIMESTAMP,
  discarded_at TIMESTAMP,
  cancelled_at TIMESTAMP
);

-- Critical indexes
CREATE INDEX idx_izi_jobs_queue_state ON izi_jobs (queue, state);
CREATE INDEX idx_izi_jobs_scheduled_at ON izi_jobs (scheduled_at);
```

### Concurrency Control

PostgreSQL uses `FOR UPDATE SKIP LOCKED` for non-blocking job fetching:

```sql
SELECT * FROM izi_jobs
WHERE queue = $1 AND state = 'available'
ORDER BY priority ASC, scheduled_at ASC
LIMIT $2
FOR UPDATE SKIP LOCKED
```

## Testing Patterns

### Setup/Teardown

```typescript
describe('Feature', () => {
  let db: Database;
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    db = new Database(':memory:');
    adapter = new SQLiteAdapter(db);
    await adapter.migrate();
    clearWorkers(); // Clear worker registry
  });

  afterEach(async () => {
    await adapter.close();
  });
});
```

### Mock Job Factory

```typescript
function createMockJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    state: 'available',
    queue: 'default',
    worker: 'test',
    args: {},
    meta: {},
    tags: [],
    errors: [],
    attempt: 0,
    maxAttempts: 20,
    priority: 0,
    insertedAt: new Date(),
    scheduledAt: new Date(),
    attemptedAt: null,
    completedAt: null,
    discardedAt: null,
    cancelledAt: null,
    ...overrides
  };
}
```

## Key Formulas

### Exponential Backoff

```typescript
// Default: (15 + 2^attempt) seconds with ±10% jitter
const base = 15 + Math.pow(2, attempt);
const jitter = base * 0.1 * (Math.random() * 2 - 1);
const delayMs = (base + jitter) * 1000;
```

### Priority Ordering

Lower priority value = higher priority (0 is highest).
Jobs ordered by: `priority ASC, scheduled_at ASC`

## Common Tasks

### Adding a New Database Adapter

1. Create `src/database/newdb.ts`
2. Implement `DatabaseAdapter` interface
3. Handle dialect-specific SQL
4. Add factory function `createNewDBAdapter()`
5. Export from `src/database/index.ts`
6. Add tests in `tests/newdb-adapter.test.ts`

### Adding a New Plugin

1. Create `src/plugins/myplugin.ts`
2. Extend `BasePlugin`
3. Implement `onStart()` with your interval logic
4. Export from `src/plugins/index.ts`
5. Add tests in `tests/plugins.test.ts`

### Adding a Worker Feature

1. Update types in `src/types.ts`
2. Implement in `src/core/worker.ts`
3. Ensure backwards compatibility
4. Add tests in `tests/worker.test.ts`

## Performance Considerations

- **Poll interval**: Default 1000ms, configurable per queue
- **Batch fetching**: Fetch up to `limit` jobs per poll
- **Skip locked**: PostgreSQL doesn't block on contested rows
- **Worker threads**: Optional isolation for CPU-intensive work
- **Connection pooling**: Use pg-pool for PostgreSQL
