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
│   ├── unique.ts         # Uniqueness digest & advisory lock keys
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
  fetchJobs(queue: string, limit: number, node?: string): Promise<Job[]>;
  updateJob(id: number, updates: Partial<Job>, expectedStates?: JobState[]): Promise<Job | null>;
  rescueStuckJobs(rescueAfter: number, nodeTtl?: number): Promise<number>;
  insertUnique?(job, options): Promise<{ job: Job; conflict: boolean }>;
  heartbeat?(node: string): Promise<void>;
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

// The set of states `to` is reachable from, passed to updateJob so the
// database refuses an illegal transition.
export function sourceStatesFor(to: JobState): JobState[];
```

**Transitions are enforced in SQL, not in process.** `Queue` passes
`sourceStatesFor(target)` to `updateJob`, which appends `AND state IN (...)`.
Zero rows means the job moved on -- cancelled by an operator, or rescued onto
another node -- and the write is refused rather than silently winning. The check
cannot live in JavaScript because the race is between nodes.

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
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempted_at TIMESTAMPTZ,
  attempted_by VARCHAR(255),   -- node that claimed the job
  unique_key VARCHAR(64),      -- uniqueness digest, null for non-unique jobs
  completed_at TIMESTAMPTZ,
  discarded_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

-- Node liveness, used to tell an orphaned job from a slow one
CREATE TABLE izi_nodes (
  name VARCHAR(255) PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Critical indexes
CREATE INDEX izi_jobs_queue_state_idx ON izi_jobs (queue, state);
CREATE INDEX izi_jobs_stageable_idx ON izi_jobs (scheduled_at)
  WHERE state IN ('scheduled', 'retryable');
CREATE INDEX izi_jobs_unique_key_idx ON izi_jobs (unique_key) WHERE unique_key IS NOT NULL;
```

**Never index `args` directly.** A btree entry is capped at ~2704 bytes and a
JSONB value that does not compress below it fails the insert outright. That is
why uniqueness is keyed on a digest.

### Concurrency Control

PostgreSQL uses `FOR UPDATE SKIP LOCKED` for non-blocking job fetching:

```sql
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
```

The outer `ORDER BY` is not redundant: `RETURNING` follows physical update order,
not the subquery's ordering, so without it a high-priority job could be handed to
the executor after a low-priority one from the same batch.

**Staging** promotes both `scheduled` and `retryable` jobs once due. Omitting
`retryable` means no job is ever retried:

```sql
UPDATE izi_jobs SET state = 'available'
WHERE state IN ('scheduled', 'retryable') AND scheduled_at <= NOW()
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
    attemptedBy: null,
    uniqueKey: null,
    completedAt: null,
    discardedAt: null,
    cancelledAt: null,
    ...overrides
  };
}
```

### Waiting in tests

Never sleep for a guessed duration. Wait on the condition, or on the telemetry
event that marks it:

```typescript
import { waitFor, waitForEvent } from './helpers/wait.js';

const done = await waitFor(async () => {
  const job = await queue.getJob(id);
  return job?.state === 'completed' ? job : null;
}, { describe: 'the job to complete' });

const refused = waitForEvent('job:transition_refused');
```

A fixed sleep bets the work finishes inside a window you guessed. That bet fails
intermittently under load and makes every run pay the full duration regardless.

### Running against real databases

SQLite alone will not catch dialect bugs -- the priority-ordering and btree index
defects were both invisible to it. The PostgreSQL and MySQL suites skip unless
their connection strings are set:

```bash
docker run -d --rm -e POSTGRES_PASSWORD=izi -e POSTGRES_DB=izi -p 55432:5432 postgres:16-alpine
docker run -d --rm -e MYSQL_ROOT_PASSWORD=izi -e MYSQL_DATABASE=izi -p 33306:3306 mysql:8

IZI_TEST_POSTGRES_URL=postgres://postgres:izi@localhost:55432/izi \
IZI_TEST_MYSQL_URL=mysql://root:izi@localhost:33306/izi npm test
```

CI runs both on every push, so a change that only works on SQLite fails there.

## Key Formulas

### Backoff

`calculateBackoff(attempt, options?)` in `src/core/job.ts` supports two named
curves via `options.strategy`, plus an optional `options.maxDelay` cap (seconds,
applies to either curve). `WorkerDefinition.backoff` accepts a `BackoffOptions`
object with the same shape, or a custom `(job) => number` function.

```typescript
// Default ('polynomial') -- Oban's curve. Spreads maxAttempts: 20 across
// ~8.4 days rather than ~3 hours; see README "Retry horizon" for the table.
const base = Math.pow(attempt, 4) + 15;
const jitter = Math.random() * 10 * attempt;
const delayMs = (base + jitter) * 1000;

// 'exponential' -- the original curve, opt-in only. Plateaus at ~17 minutes
// once attempt reaches maxPower (default 10).
const base = 15 + Math.pow(2, Math.min(attempt, 10));
const jitter = base * 0.1 * (Math.random() * 2 - 1);
const delayMs = (base + jitter) * 1000;
```

### Priority Ordering

Lower priority value = higher priority (0 is highest).
Jobs ordered by: `priority ASC, scheduled_at ASC`

## Common Tasks

### Adding a Migration

1. Append to the relevant array in `src/database/migrations.ts`, using the next
   version for that dialect -- version numbers are tracked per database, so the
   three arrays are free to diverge.
2. `up` and `down` are **arrays of statements**, one statement per entry. They
   are not split on `;`, which would tear apart a function body or a semicolon
   inside a string literal.
3. Migrations run under an advisory lock, so several nodes may boot at once.
4. On PostgreSQL, DDL is transactional and a failure rolls back. On MySQL it is
   not: a failure part-way leaves the schema changed and the version unrecorded.

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
- **One poll loop per queue**: `dispatch()` moves the pending timer rather than
  starting another. Starting a second loop per notification makes the query rate
  grow with every insert until the database saturates.
- **Batch fetching**: Fetch up to `limit` jobs per poll
- **Skip locked**: PostgreSQL doesn't block on contested rows
- **Worker threads**: Optional isolation for CPU-intensive work
- **Connection pooling**: Use pg-pool for PostgreSQL
- **Clear every timer you create**: the timeout race in `executeWorker` and the
  grace-period race in `Queue.stop()` both leaked until fixed, each holding the
  event loop open long after its work was done.
