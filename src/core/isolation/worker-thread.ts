import { parentPort, isMainThread } from 'worker_threads';
import type {
  Job,
  SerializableJob,
  WorkerResult,
  WorkerThreadMessage
} from '../../types.js';

if (isMainThread) {
  throw new Error('This file must be run as a worker thread');
}

if (!parentPort) {
  throw new Error('parentPort is not available');
}

function deserializeJob(serialized: SerializableJob): Job {
  return {
    ...serialized,
    insertedAt: new Date(serialized.insertedAt),
    scheduledAt: new Date(serialized.scheduledAt),
    attemptedAt: serialized.attemptedAt ? new Date(serialized.attemptedAt) : null,
    completedAt: serialized.completedAt ? new Date(serialized.completedAt) : null,
    discardedAt: serialized.discardedAt ? new Date(serialized.discardedAt) : null,
    cancelledAt: serialized.cancelledAt ? new Date(serialized.cancelledAt) : null,
    errors: serialized.errors.map(e => ({
      ...e,
      at: new Date(e.at)
    }))
  };
}

async function executeJob(
  workerPath: string,
  job: Job
): Promise<WorkerResult> {
  const workerModule = await import(workerPath);

  if (typeof workerModule.perform !== 'function') {
    throw new Error(
      `Worker at "${workerPath}" does not export a perform function`
    );
  }

  const result = await workerModule.perform(job);

  if (result === undefined) {
    return { status: 'ok' };
  }

  return result;
}

parentPort.on('message', async (message: WorkerThreadMessage) => {
  if (message.type !== 'execute') {
    return;
  }

  const { jobId, job: serializedJob, workerPath } = message;

  if (jobId === undefined || !serializedJob || !workerPath) {
    parentPort!.postMessage({
      type: 'error',
      jobId,
      error: 'Invalid execute message: missing required fields'
    } satisfies WorkerThreadMessage);
    return;
  }

  try {
    const job = deserializeJob(serializedJob);
    const result = await executeJob(workerPath, job);

    parentPort!.postMessage({
      type: 'result',
      jobId,
      result
    } satisfies WorkerThreadMessage);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    parentPort!.postMessage({
      type: 'error',
      jobId,
      error: errorMessage,
      stack
    } satisfies WorkerThreadMessage);
  }
});

parentPort.postMessage({ type: 'ready' } satisfies WorkerThreadMessage);
