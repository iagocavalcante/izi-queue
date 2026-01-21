# izi-queue Development Patterns

Use this skill when working on any izi-queue feature or fix. It establishes the coding patterns and conventions used throughout the codebase.

## Core Patterns

### 1. Factory Functions over Direct Class Export

Always use factory functions for public API:

```typescript
// DO THIS
export function createSQLiteAdapter(db: Database): SQLiteAdapter {
  return new SQLiteAdapter(db);
}

// NOT THIS
export class SQLiteAdapter { ... } // Don't expose class directly
```

### 2. Result Objects over Exceptions

Workers return structured results, never throw:

```typescript
// DO THIS
return WorkerResults.ok({ count: 10 });
return WorkerResults.error('Something failed');

// NOT THIS
throw new Error('Something failed');
```

### 3. State Machine for Job Lifecycle

Jobs follow strict state transitions:

```
scheduled -> available -> executing -> completed
                      \-> retryable -> available
                      \-> discarded
                      \-> cancelled
```

Always validate transitions using `isValidTransition()`.

### 4. Async/Await Exclusively

Use async/await for all asynchronous code:

```typescript
// DO THIS
async function fetchJobs(): Promise<Job[]> {
  const jobs = await db.query(sql);
  return jobs;
}

// NOT THIS - callbacks
function fetchJobs(callback: (jobs: Job[]) => void) { ... }
```

### 5. Timeout Pattern

Use `Promise.race` for timeouts:

```typescript
const result = await Promise.race([
  worker.perform(job),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
  )
]);
```

## Naming Conventions

- **Files**: kebab-case (`worker-thread.ts`)
- **Classes**: PascalCase (`IziQueue`, `BasePlugin`)
- **Functions**: camelCase (`registerWorker`, `executeWorker`)
- **Constants**: UPPER_SNAKE_CASE (`STATE_TRANSITIONS`, `TERMINAL_STATES`)
- **Types**: PascalCase (`Job`, `WorkerDefinition`, `JobState`)

## Import Conventions

Always use `.js` extension for local imports (ESM requirement):

```typescript
import { Job } from '../types.js';
import { formatError } from './job.js';
```

## Error Handling

1. Catch errors at boundaries
2. Format errors with `formatError()`
3. Emit telemetry for errors
4. Don't let errors crash the queue

```typescript
try {
  const result = await worker.perform(job);
} catch (error) {
  const formatted = formatError(error instanceof Error ? error : new Error(String(error)), job.attempt);
  await this.handleError(job, error, startTime);
}
```

## Type Definitions

All types go in `src/types.ts`. Keep types:
- Explicit (no implicit any)
- Exported when part of public API
- Using `interface` for object shapes
- Using `type` for unions/aliases

## Testing Requirements

- Use in-memory SQLite for fast tests
- Clear worker registry in `beforeEach`
- Test both success and error paths
- Use `createMockJob()` helper for test data
