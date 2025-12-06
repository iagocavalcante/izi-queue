# izi-queue

A minimal, reliable, database-backed job queue for Node.js inspired by [Oban](https://github.com/sorentwo/oban).

## Why izi-queue?

- **No extra infrastructure** - Use your existing PostgreSQL, SQLite, or MySQL database
- **ACID guarantees** - Jobs are inserted transactionally with your business data
- **Simple API** - Define workers, insert jobs, done
- **TypeScript-first** - Full type safety and excellent DX

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
import { IziQueue, Worker, WorkerResult, createSQLiteAdapter } from 'izi-queue';
import Database from 'better-sqlite3';

// 1. Define a worker
class SendEmailWorker extends Worker {
  name = 'send_email';

  async perform(args: { to: string; subject: string }) {
    console.log(`Sending email to ${args.to}: ${args.subject}`);
    return WorkerResult.ok();
  }
}

// 2. Create the queue
const db = new Database('jobs.db');
const queue = new IziQueue({
  database: createSQLiteAdapter(db),
  workers: [new SendEmailWorker()],
  queues: ['default'],
});

// 3. Run migrations and start
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
  scheduledAt: new Date(Date.now() + 3600000), // 1 hour
});
```

### Retries with Backoff

```typescript
class MyWorker extends Worker {
  name = 'my_worker';
  maxAttempts = 5; // Retry up to 5 times

  async perform(args) {
    // Automatic exponential backoff on failure
    return WorkerResult.error('Something went wrong');
  }
}
```

### Priority Queues

```typescript
await queue.insert('urgent_task', args, { priority: 0 }); // High priority
await queue.insert('background_task', args, { priority: 10 }); // Low priority
```

### Unique Jobs

```typescript
await queue.insert('send_digest', args, {
  unique: {
    fields: ['worker', 'args'],
    period: 3600, // Only one per hour
  },
});
```

### Plugins

```typescript
import { LifelinePlugin, PrunerPlugin } from 'izi-queue';

const queue = new IziQueue({
  // ...
  plugins: [
    new LifelinePlugin({ rescueAfter: 300 }), // Rescue stuck jobs
    new PrunerPlugin({ maxAge: 86400 }), // Prune old jobs
  ],
});
```

## Worker Results

```typescript
async perform(args) {
  // Success
  return WorkerResult.ok();
  return WorkerResult.ok({ processed: 100 });

  // Retry later
  return WorkerResult.error('Temporary failure');

  // Don't retry
  return WorkerResult.discard('Invalid data');

  // Reschedule
  return WorkerResult.snooze(60); // Try again in 60 seconds
}
```

## Database Support

| Database   | Adapter                  | Status |
| ---------- | ------------------------ | ------ |
| PostgreSQL | `createPostgresAdapter`  | ✅     |
| SQLite     | `createSQLiteAdapter`    | ✅     |
| MySQL      | `createMySQLAdapter`     | ✅     |

## License

MIT
