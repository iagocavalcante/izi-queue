# izi-queue

[![CI](https://github.com/iagocavalcante/izi-queue/actions/workflows/ci.yml/badge.svg)](https://github.com/iagocavalcante/izi-queue/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/izi-queue.svg)](https://www.npmjs.com/package/izi-queue)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/izi-queue.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue.svg)](https://www.typescriptlang.org/)

A minimal, reliable, database-backed job queue for Node.js inspired by [Oban](https://github.com/sorentwo/oban).

## Why izi-queue?

- **No extra infrastructure** - Use your existing PostgreSQL, SQLite, or MySQL database
- **Transactional** - Enqueue inside your own transaction, so a job never outlives the write it belongs to
- **Durable** - Jobs live in your database, survive restarts, and are recovered when a node dies
- **Simple API** - Define workers, insert jobs, done
- **TypeScript-first** - Full type safety and excellent DX
- **Battle-tested patterns** - Inspired by Oban's proven design

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Features](#features)
  - [Job Scheduling](#job-scheduling)
  - [Retries with Backoff](#retries-with-backoff)
  - [Priority Queues](#priority-queues)
  - [Unique Jobs](#unique-jobs)
  - [Worker Isolation](#worker-isolation)
  - [Plugins](#plugins)
  - [Telemetry](#telemetry)
- [Managing Jobs](#managing-jobs)
- [Transactional Inserts](#transactional-inserts)
- [Migrations](#migrations)
- [Running Multiple Nodes](#running-multiple-nodes)
- [Worker Results](#worker-results)
- [Database Support](#database-support)
- [Examples](#examples)
- [Contributing](#contributing)
- [License](#license)

## Installation

```bash
npm install izi-queue
```

Install the database driver you need:

```bash
# PostgreSQL
npm install pg

# SQLite
npm install better-sqlite3

# MySQL
npm install mysql2
```

## Quick Start

```typescript
import { IziQueue, defineWorker, WorkerResults, createSQLiteAdapter } from 'izi-queue';
import Database from 'better-sqlite3';

// 1. Define a worker
const sendEmailWorker = defineWorker('send_email', async (job) => {
  const { to, subject } = job.args as { to: string; subject: string };
  console.log(`Sending email to ${to}: ${subject}`);
  return WorkerResults.ok();
});

// 2. Create the queue
const db = new Database('jobs.db');
const queue = new IziQueue({
  database: createSQLiteAdapter(db),
  queues: { default: 10 }, // queue name: concurrency limit
});

// 3. Register worker, run migrations, and start
queue.register(sendEmailWorker);
await queue.migrate();
await queue.start();

// 4. Insert jobs. Job arguments go under `args`.
await queue.insert('send_email', {
  args: { to: 'user@example.com', subject: 'Welcome!' },
});
```

`insert` takes the worker name (or definition) and a single options object.
Everything other than `args` is optional:

```typescript
await queue.insert('send_email', {
  args: { to: 'user@example.com' },
  queue: 'emails',
  priority: 0,
  maxAttempts: 5,
  scheduledAt: new Date(Date.now() + 3600000),
  tags: ['welcome'],
});
```

## Features

### Job Scheduling

```typescript
// Run immediately
await queue.insert('send_email', { args });

// Schedule for later
await queue.insert('send_email', {
  args,
  scheduledAt: new Date(Date.now() + 3600000), // 1 hour from now
});
```

### Retries with Backoff

```typescript
const myWorker = defineWorker('my_worker', async (job) => {
  // Automatic exponential backoff on failure
  // Formula: (15 + 2^attempt) seconds with ±10% jitter
  return WorkerResults.error('Something went wrong');
}, {
  maxAttempts: 5, // Retry up to 5 times
});

// Or define custom backoff
const customBackoffWorker = defineWorker('custom_worker', async (job) => {
  return WorkerResults.ok();
}, {
  backoff: (job) => job.attempt * 60, // Linear: 60s, 120s, 180s...
});
```

### Priority Queues

```typescript
await queue.insert('urgent_task', { args, priority: 0 });      // High priority (lower = higher)
await queue.insert('background_task', { args, priority: 10 }); // Low priority
```

### Unique Jobs

Prevent duplicate jobs from being enqueued:

```typescript
await queue.insert('send_digest', {
  args,
  unique: {
    fields: ['worker', 'args'], // Uniqueness based on these fields
    keys: ['userId'],           // Or compare only these keys within args
    period: 3600,               // Only one per hour (in seconds), or 'infinity'
    states: ['scheduled', 'available', 'executing'],
  },
});
```

Use `insertWithResult` when you need to know whether a duplicate was found:

```typescript
const { job, conflict } = await queue.insertWithResult('send_digest', {
  args,
  unique: { period: 3600 },
});
```

Insertion is atomic, so concurrent callers across multiple nodes produce exactly
one job. Two notes on the semantics:

- **Only jobs inserted with `unique` participate.** A job enqueued without
  `unique` options carries no uniqueness key and will not block a later unique
  insert. This matches Oban, where uniqueness is a property of how a job was
  enqueued.
- **Argument order does not matter.** `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` are
  the same job on every adapter.

### Worker Isolation

Run workers in isolated threads with resource limits:

```typescript
const isolatedWorker = defineWorker('heavy_computation', async (job) => {
  // Runs in a separate worker thread
  return WorkerResults.ok();
}, {
  isolation: {
    isolated: true,
    workerPath: './workers/heavy-computation.js',
    resourceLimits: {
      maxOldGenerationSizeMb: 128,   // caps the worker's V8 heap
      maxYoungGenerationSizeMb: 32,
    },
  },
  timeout: 30000, // 30 seconds
});
```

Configure the thread pool on the queue:

```typescript
const queue = new IziQueue({
  database: createSQLiteAdapter(db),
  queues: { default: 4 },
  isolation: { minThreads: 0, maxThreads: 4, idleTimeoutMs: 30000 },
});
```

A job that arrives while every thread is busy waits for one rather than
failing, so a queue's concurrency may exceed `maxThreads` without jobs burning
retry attempts on the pool being full. The job's `timeout` covers that wait as
well as its execution, so a saturated pool cannot leave work outstanding
indefinitely.

`resourceLimits` are applied when the thread is created, and threads are pooled
per limit set — jobs asking for different limits do not share a thread. Note
that `maxOldGenerationSizeMb` caps the V8 heap; `Buffer` memory lives outside it
and is not governed by that setting.

### Plugins

Extend functionality with plugins:

```typescript
import { LifelinePlugin, PrunerPlugin } from 'izi-queue';

const queue = new IziQueue({
  database: createSQLiteAdapter(db),
  queues: { default: 10 },
  plugins: [
    new LifelinePlugin({ rescueAfter: 300 }), // Rescue orphaned jobs after 5 min
    new PrunerPlugin({ maxAge: 86400 }),      // Prune finished jobs older than 24h
  ],
});
```

**Lifeline** returns jobs abandoned by a node that stopped heartbeating. It will
not touch a job that is still running on a live node, so `rescueAfter` does not
have to exceed your worker timeouts.

**Pruner** deletes finished jobs. It currently deletes in one unbounded
statement, so the first run against a large backlog is a long-running delete
([#29](https://github.com/iagocavalcante/izi-queue/issues/29)).

> Every node runs every plugin: there is no leader election yet
> ([#26](https://github.com/iagocavalcante/izi-queue/issues/26)). With several
> nodes this duplicates maintenance work against the same rows.

### Telemetry

Monitor your queue with the telemetry system:

```typescript
queue.on('job:complete', ({ job, duration }) => {
  console.log(`Job ${job.id} completed in ${duration}ms`);
});

queue.on('job:error', ({ job, error }) => {
  console.error(`Job ${job.id} failed:`, error);
});

// Subscribe to all events
queue.on('*', ({ event, job }) => {
  metrics.increment(`queue.${event}`, { worker: job?.worker });
});
```

**Available events:**
- `job:start`, `job:complete`, `job:error`, `job:cancel`, `job:snooze`
- `job:retry`, `job:rescue`, `job:unknown_worker`, `job:transition_refused`
- `job:unique_conflict`, `job:isolated:start`, `job:isolated:timeout`
- `jobs:pruned`
- `queue:start`, `queue:stop`, `queue:pause`, `queue:resume`
- `thread:spawn`, `thread:exit`
- `plugin:start`, `plugin:stop`, `plugin:error`

`job:transition_refused` fires when a result could not be written because the
job had already moved on — cancelled by an operator, or rescued onto another
node. `jobs:pruned` and `job:rescue` carry `result`, not `job`.

## Managing Jobs

```typescript
const job = await queue.getJob(id);

// Cancel one job, or a scoped set
await queue.cancelJob(id);
await queue.cancelJobs({ queue: 'emails' });
await queue.cancelJobs({ worker: 'SendEmail', state: ['available', 'scheduled'] });

// Return discarded or cancelled jobs to the queue
await queue.retryJob(id);
await queue.retryJobs({ worker: 'SendEmail' });
```

Bulk operations require at least one criterion. `cancelJobs({})` throws rather
than cancelling everything, so a handler that forwards optional filters cannot
wipe the queue when called with none of them. To act on every job, be explicit:

```typescript
await queue.cancelJobs({ all: true });
```

Cancelling a job that is currently executing marks it cancelled and causes its
result to be discarded when the worker finishes. It does **not** interrupt the
worker mid-run ([#30](https://github.com/iagocavalcante/izi-queue/issues/30)).

## Transactional Inserts

Pass your open transaction as `tx` and the job is committed or discarded with
the rest of your work. No job for an order that was never placed, and no job
that becomes visible before the row it refers to.

```typescript
const client = await pool.connect();
try {
  await client.query('BEGIN');

  const { rows } = await client.query(
    'INSERT INTO orders (total) VALUES ($1) RETURNING id',
    [total]
  );

  await queue.insert('send_receipt', {
    args: { orderId: rows[0].id },
    tx: client,          // same connection, same transaction
  });

  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');   // the job goes with it
  throw error;
} finally {
  client.release();
}
```

The handle is whatever your driver uses for a transaction:

| Adapter | Pass as `tx` | Transaction opened with |
| --- | --- | --- |
| PostgreSQL | `PoolClient` | `client.query('BEGIN')` |
| MySQL | `PoolConnection` | `connection.beginTransaction()` |
| SQLite | the `Database` | `db.exec('BEGIN')` |

On PostgreSQL the wake-up notification is issued on your connection too, so a
worker is never nudged toward a row that has not committed yet, and is not
nudged at all if you roll back.

**SQLite** has a single connection, so any insert while a transaction is open is
already part of it; passing `tx` makes that explicit and catches the mistake of
handing over a different database. Use `db.exec('BEGIN')` rather than
`db.transaction()`, which is synchronous and cannot await.

**MySQL** cannot combine `unique` with a caller-managed transaction and will
throw if you try. Its advisory lock is connection-scoped and cannot be held
across your commit, which would leave a window for a concurrent node to insert a
duplicate. Insert unique jobs outside the transaction, or use PostgreSQL, where
the lock is transaction-scoped.

## Migrations

`migrate()` creates and upgrades the schema, and is safe to call from every node
at boot — it holds an advisory lock, so concurrent starts do not collide.

```typescript
await queue.migrate();
```

It applies DDL against `izi_jobs`, so on a large table review what a release
adds before deploying. Each version's migrations are listed in
[CHANGELOG.md](CHANGELOG.md).

## Running Multiple Nodes

Jobs are claimed with `FOR UPDATE SKIP LOCKED` on PostgreSQL and MySQL, so any
number of nodes can share a queue without handing out the same job twice.

Each node records a heartbeat. When one stops heartbeating, the Lifeline plugin
returns its in-flight jobs to the queue — and only its jobs, so a slow job on a
healthy node is never restarted underneath you.

```typescript
const queue = new IziQueue({
  database: adapter,
  queues: { default: 10 },
  node: 'worker-1',        // defaults to a random id
  heartbeatInterval: 15000,
});
```

Two caveats when scaling out:

- Concurrency limits are **per node**. Five nodes with `{ default: 10 }` run up
  to 50 jobs at once ([#37](https://github.com/iagocavalcante/izi-queue/issues/37)).
- Every node runs every plugin ([#26](https://github.com/iagocavalcante/izi-queue/issues/26)).
- A worker that blocks the event loop for longer than the node TTL stops the
  heartbeat and may be treated as dead. Use isolated workers for CPU-bound work.

## Worker Results

```typescript
async perform(job) {
  // Success - job completed
  return WorkerResults.ok();
  return WorkerResults.ok({ processed: 100 }); // With metadata

  // Retry later - job moves to `retryable` and is retried with backoff
  return WorkerResults.error('Temporary failure');

  // Cancel - job moves to `cancelled` and is not retried
  return WorkerResults.cancel('Invalid data');

  // Snooze - reschedule without consuming a retry attempt
  return WorkerResults.snooze(60); // Try again in 60 seconds
}
```

## Database Support

| Database   | Adapter                 | Production Ready |
| ---------- | ----------------------- | ---------------- |
| PostgreSQL | `createPostgresAdapter` | Yes              |
| SQLite     | `createSQLiteAdapter`   | Yes              |
| MySQL      | `createMySQLAdapter`    | Yes              |

**PostgreSQL** is recommended for production due to `FOR UPDATE SKIP LOCKED` support for efficient concurrent job fetching.

**MySQL requires 8.0.1 or later** for `FOR UPDATE SKIP LOCKED`. MariaDB does not implement it and is not supported.

Driver versions covered by the test suite: `better-sqlite3` 11-13, `pg` 8, `mysql2` 3.

## Examples

Check out the [examples](./examples) directory:

- **[Fastify Sample](./examples/fastify-sample)** - Full REST API with queue management, multiple queues, and graceful shutdown

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Quick Start for Contributors

```bash
# Clone the repository
git clone https://github.com/IagoCavalcante/izi-queue.git
cd izi-queue

# Install dependencies
npm install

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Run linting
npm run lint

# Build the project
npm run build
```

### Development Guidelines

- Write tests for new features
- Follow existing code patterns (see `CLAUDE.md` for architecture details)
- Run `npm run lint` before committing
- Keep PRs focused and atomic

## Architecture

izi-queue follows these key architectural patterns:

- **Registry Pattern** - Global worker registry for dynamic worker management
- **Adapter Pattern** - Database adapters for multi-database support
- **Plugin Architecture** - Extensible plugin system with lifecycle hooks
- **State Machine** - Job state transitions with validation
- **Observable Pattern** - Telemetry event system for monitoring

For detailed architecture documentation, see [`CLAUDE.md`](CLAUDE.md).

## Acknowledgments

izi-queue is heavily inspired by [Oban](https://github.com/sorentwo/oban), the excellent background job library for Elixir. We've adapted many of its battle-tested patterns for the Node.js ecosystem.

## License

MIT
