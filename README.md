# izi-queue

[![npm version](https://img.shields.io/npm/v/izi-queue.svg)](https://www.npmjs.com/package/izi-queue)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/izi-queue.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue.svg)](https://www.typescriptlang.org/)

A minimal, reliable, database-backed job queue for Node.js inspired by [Oban](https://github.com/sorentwo/oban).

## Why izi-queue?

- **No extra infrastructure** - Use your existing PostgreSQL, SQLite, or MySQL database
- **ACID guarantees** - Jobs are inserted transactionally with your business data
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

// 3. Register worker and start
queue.registerWorker(sendEmailWorker);
await queue.start();

// 4. Insert jobs
await queue.insert('send_email', {
  to: 'user@example.com',
  subject: 'Welcome!',
});
```

## Features

### Job Scheduling

```typescript
// Run immediately
await queue.insert('send_email', args);

// Schedule for later
await queue.insert('send_email', args, {
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
await queue.insert('urgent_task', args, { priority: 0 }); // High priority (lower = higher)
await queue.insert('background_task', args, { priority: 10 }); // Low priority
```

### Unique Jobs

Prevent duplicate jobs from being enqueued:

```typescript
await queue.insert('send_digest', args, {
  unique: {
    fields: ['worker', 'args'], // Uniqueness based on these fields
    period: 3600, // Only one per hour (in seconds)
    states: ['scheduled', 'available', 'executing'], // Check these states
  },
});
```

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
      maxOldGenerationSizeMb: 128,
      maxYoungGenerationSizeMb: 32,
    },
  },
  timeout: 30000, // 30 seconds
});
```

### Plugins

Extend functionality with plugins:

```typescript
import { LifelinePlugin, PrunerPlugin } from 'izi-queue';

const queue = new IziQueue({
  database: createSQLiteAdapter(db),
  queues: { default: 10 },
  plugins: [
    new LifelinePlugin({ rescueAfter: 300 }), // Rescue stuck jobs after 5 min
    new PrunerPlugin({ maxAge: 86400 }), // Prune completed jobs older than 24h
  ],
});
```

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
- `job:start`, `job:complete`, `job:error`, `job:cancel`, `job:snooze`, `job:rescue`
- `job:unique_conflict`, `job:isolated:start`, `job:isolated:timeout`
- `queue:start`, `queue:stop`, `queue:pause`, `queue:resume`
- `thread:spawn`, `thread:exit`
- `plugin:start`, `plugin:stop`, `plugin:error`

## Worker Results

```typescript
async perform(job) {
  // Success - job completed
  return WorkerResults.ok();
  return WorkerResults.ok({ processed: 100 }); // With metadata

  // Retry later - job will be retried with backoff
  return WorkerResults.error('Temporary failure');

  // Discard - don't retry, job is invalid
  return WorkerResults.cancel('Invalid data');

  // Snooze - reschedule for later
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
