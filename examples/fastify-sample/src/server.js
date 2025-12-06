import Fastify from 'fastify';
import Database from 'better-sqlite3';
import {
  createIziQueue,
  createSQLiteAdapter,
  createLifelinePlugin,
  createPrunerPlugin
} from 'izi-queue';

import {
  emailWorker,
  reportWorker,
  notificationWorker,
  cleanupWorker
} from './workers.js';

// Initialize Fastify
const fastify = Fastify({
  logger: true
});

// Initialize SQLite database
const db = new Database('queue.db');
const adapter = createSQLiteAdapter(db);

// Create izi-queue instance
const queue = createIziQueue({
  database: adapter,
  queues: {
    default: 5,
    email: 3,
    reports: 2,
    notifications: 10
  },
  pollInterval: 1000,
  plugins: [
    createLifelinePlugin({ interval: 60000, rescueAfter: 300 }),
    createPrunerPlugin({ interval: 60000, maxAge: 86400 })
  ]
});

// Register workers
queue.register(emailWorker);
queue.register(reportWorker);
queue.register(notificationWorker);
queue.register(cleanupWorker);

// Setup telemetry logging
queue.on('job:start', ({ job }) => {
  fastify.log.info(`Job started: ${job.worker} (ID: ${job.id})`);
});

queue.on('job:complete', ({ job, duration }) => {
  fastify.log.info(`Job completed: ${job.worker} (ID: ${job.id}) in ${duration}ms`);
});

queue.on('job:error', ({ job, error }) => {
  fastify.log.error(`Job failed: ${job.worker} (ID: ${job.id}) - ${error.message}`);
});

// ============== Routes ==============

// Health check
fastify.get('/health', async () => {
  return {
    status: 'ok',
    queues: queue.getAllQueueStatus()
  };
});

// Send email job
fastify.post('/jobs/email', async (request, reply) => {
  const { to, subject, body } = request.body || {};

  if (!to || !subject) {
    return reply.status(400).send({ error: 'Missing required fields: to, subject' });
  }

  const job = await queue.insert('SendEmail', {
    args: { to, subject, body: body || '' },
    queue: 'email'
  });

  return { message: 'Email job queued', jobId: job.id };
});

// Generate report job
fastify.post('/jobs/report', async (request, reply) => {
  const { reportType, userId } = request.body || {};

  if (!reportType || !userId) {
    return reply.status(400).send({ error: 'Missing required fields: reportType, userId' });
  }

  const job = await queue.insert('GenerateReport', {
    args: { reportType, userId },
    queue: 'reports'
  });

  return { message: 'Report job queued', jobId: job.id };
});

// Send notification job
fastify.post('/jobs/notification', async (request, reply) => {
  const { userId, message, type } = request.body || {};

  if (!userId || !message) {
    return reply.status(400).send({ error: 'Missing required fields: userId, message' });
  }

  const job = await queue.insert('SendNotification', {
    args: { userId, message, type: type || 'info' },
    queue: 'notifications'
  });

  return { message: 'Notification job queued', jobId: job.id };
});

// Schedule a future job
fastify.post('/jobs/scheduled', async (request, reply) => {
  const { worker, args, queue: queueName, delaySeconds } = request.body || {};

  if (!worker || !delaySeconds) {
    return reply.status(400).send({ error: 'Missing required fields: worker, delaySeconds' });
  }

  const scheduledAt = new Date(Date.now() + delaySeconds * 1000);

  const job = await queue.insert(worker, {
    args: args || {},
    queue: queueName || 'default',
    scheduledAt
  });

  return {
    message: 'Job scheduled',
    jobId: job.id,
    scheduledAt: scheduledAt.toISOString()
  };
});

// Unique job example - prevents duplicates
fastify.post('/jobs/unique-email', async (request, reply) => {
  const { to, subject, body } = request.body || {};

  if (!to || !subject) {
    return reply.status(400).send({ error: 'Missing required fields: to, subject' });
  }

  const result = await queue.insertWithResult('SendEmail', {
    args: { to, subject, body: body || '' },
    queue: 'email',
    unique: {
      keys: ['to'],
      period: 300 // 5 minute uniqueness window
    }
  });

  if (result.conflict) {
    return {
      message: 'Email already queued for this recipient',
      jobId: result.job.id,
      conflict: true
    };
  }

  return { message: 'Email job queued', jobId: result.job.id, conflict: false };
});

// Get job status
fastify.get('/jobs/:id', async (request, reply) => {
  const { id } = request.params;
  const job = await queue.getJob(parseInt(id, 10));

  if (!job) {
    return reply.status(404).send({ error: 'Job not found' });
  }

  return job;
});

// Cancel jobs by worker
fastify.delete('/jobs', async (request, reply) => {
  const { worker, queue: queueName } = request.query || {};

  const criteria = {};
  if (worker) criteria.worker = worker;
  if (queueName) criteria.queue = queueName;

  const cancelled = await queue.cancelJobs(criteria);

  return { message: `Cancelled ${cancelled} jobs`, count: cancelled };
});

// Queue management
fastify.post('/queues/:name/pause', async (request) => {
  const { name } = request.params;
  queue.pauseQueue(name);
  return { message: `Queue ${name} paused`, status: queue.getQueueStatus(name) };
});

fastify.post('/queues/:name/resume', async (request) => {
  const { name } = request.params;
  queue.resumeQueue(name);
  return { message: `Queue ${name} resumed`, status: queue.getQueueStatus(name) };
});

fastify.post('/queues/:name/scale', async (request) => {
  const { name } = request.params;
  const { limit } = request.body || {};

  if (!limit || typeof limit !== 'number') {
    return { error: 'Missing or invalid limit' };
  }

  queue.scaleQueue(name, limit);
  return { message: `Queue ${name} scaled to ${limit}`, status: queue.getQueueStatus(name) };
});

// ============== Server Lifecycle ==============

const start = async () => {
  try {
    // Run migrations
    await queue.migrate();
    fastify.log.info('Database migrations completed');

    // Start queue processing
    await queue.start();
    fastify.log.info('Queue processing started');

    // Start HTTP server
    await fastify.listen({ port: 3000, host: '0.0.0.0' });
    fastify.log.info('Server listening on http://localhost:3000');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Graceful shutdown
const shutdown = async (signal) => {
  fastify.log.info(`${signal} received, shutting down gracefully...`);

  try {
    await fastify.close();
    await queue.shutdown();
    fastify.log.info('Shutdown complete');
    process.exit(0);
  } catch (err) {
    fastify.log.error('Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
