# Creating Workers in izi-queue

Use this skill when implementing new workers or modifying worker behavior.

## Worker Definition

Workers are defined using the `defineWorker` factory function:

```typescript
import { defineWorker, WorkerResults, Job } from 'izi-queue';

interface EmailArgs {
  to: string;
  subject: string;
  body: string;
}

const sendEmailWorker = defineWorker<EmailArgs>('send_email', async (job) => {
  const { to, subject, body } = job.args;

  // Your logic here
  await emailService.send({ to, subject, body });

  return WorkerResults.ok();
}, {
  queue: 'email',        // Optional: specific queue
  maxAttempts: 5,        // Optional: retry limit
  priority: 0,           // Optional: default priority
  timeout: 30000,        // Optional: timeout in ms
});
```

## Worker Results

Always return a `WorkerResult`:

```typescript
// Success
return WorkerResults.ok();
return WorkerResults.ok({ processed: 100 }); // With metadata

// Retriable error (will retry with backoff)
return WorkerResults.error('Temporary failure');
return WorkerResults.error(new Error('API unavailable'));

// Permanent failure (no retry)
return WorkerResults.cancel('Invalid data format');

// Reschedule for later
return WorkerResults.snooze(60); // Retry in 60 seconds
```

## Custom Backoff

Override the default exponential backoff:

```typescript
const worker = defineWorker('my_worker', async (job) => {
  return WorkerResults.ok();
}, {
  // Linear backoff: 60s, 120s, 180s...
  backoff: (job) => job.attempt * 60,

  // Or exponential with custom base
  backoff: (job) => Math.pow(2, job.attempt) * 1000,
});
```

## Worker Isolation

For CPU-intensive work, run in isolated threads:

```typescript
const heavyWorker = defineWorker('heavy_computation', async (job) => {
  // This runs in a separate worker thread
  return WorkerResults.ok();
}, {
  isolation: {
    isolated: true,
    workerPath: './workers/heavy-computation.js', // Path to worker file
    resourceLimits: {
      maxOldGenerationSizeMb: 128,
      maxYoungGenerationSizeMb: 32,
    },
  },
  timeout: 60000, // Timeout for isolated workers
});
```

The worker file (`heavy-computation.js`) must export a `perform` function:

```typescript
// workers/heavy-computation.js
export async function perform(job) {
  // CPU-intensive work here
  return { status: 'ok' };
}
```

## Accessing Job Properties

The `job` object contains useful information:

```typescript
const worker = defineWorker('my_worker', async (job) => {
  console.log(job.id);          // Unique job ID
  console.log(job.args);        // Job arguments
  console.log(job.attempt);     // Current attempt (0-indexed)
  console.log(job.maxAttempts); // Maximum attempts
  console.log(job.queue);       // Queue name
  console.log(job.priority);    // Job priority
  console.log(job.meta);        // Custom metadata
  console.log(job.tags);        // Job tags
  console.log(job.errors);      // Previous error history
  console.log(job.scheduledAt); // When job was scheduled

  return WorkerResults.ok();
});
```

## Registering Workers

Workers must be registered with the queue:

```typescript
// Option 1: During queue creation (recommended)
const queue = new IziQueue({
  database: adapter,
  queues: { default: 10 },
});
queue.registerWorker(sendEmailWorker);

// Option 2: Using the registry directly
import { registerWorker } from 'izi-queue';
registerWorker(sendEmailWorker);
```

## Testing Workers

```typescript
import { defineWorker, WorkerResults, clearWorkers, executeWorker } from 'izi-queue';

describe('SendEmailWorker', () => {
  beforeEach(() => {
    clearWorkers();
  });

  it('should send email successfully', async () => {
    const worker = defineWorker('send_email', async (job) => {
      return WorkerResults.ok();
    });
    registerWorker(worker);

    const job = createMockJob({ worker: 'send_email', args: { to: 'test@example.com' } });
    const result = await executeWorker(job);

    expect(result.status).toBe('ok');
  });
});
```
