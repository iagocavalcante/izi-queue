// Test worker for isolated execution tests
import { isMainThread, threadId } from 'worker_threads';

export async function perform(job) {
  // Verify we're running in a worker thread
  if (isMainThread) {
    return {
      status: 'error',
      error: 'Worker is running in main thread!'
    };
  }

  const { action, delay, crashMessage } = job.args;

  switch (action) {
    case 'success':
      return {
        status: 'ok',
        value: { processed: true, jobId: job.id, isMainThread }
      };

    case 'delay': {
      // Reported so tests can observe parallelism directly, rather than
      // inferring it from how long the batch took on the wall clock.
      const startedAt = Date.now();
      await new Promise(resolve => setTimeout(resolve, delay || 100));
      return {
        status: 'ok',
        value: { delayed: delay, jobId: job.id, threadId, startedAt, finishedAt: Date.now() }
      };
    }

    case 'allocate': {
      // Used to prove resourceLimits are actually applied: with a small heap
      // cap this must kill the thread rather than succeed.
      // Arrays of numbers, not Buffers: maxOldGenerationSizeMb governs the V8
      // heap, and Buffer memory is external to it, so buffers would sail past
      // any cap. Each 1M-element array is roughly 8MB of old-generation heap.
      const chunks = [];
      const target = job.args.megabytes || 64;
      for (let i = 0; i < Math.ceil(target / 8); i++) {
        const chunk = new Array(1000000).fill(i);
        chunk[0] = i; // touch it so it cannot be optimised away
        chunks.push(chunk);
      }
      return { status: 'ok', value: { allocated: chunks.length } };
    }

    case 'crash':
      throw new Error(crashMessage || 'Intentional crash');

    case 'snooze':
      return {
        status: 'snooze',
        seconds: job.args.seconds || 60
      };

    case 'cancel':
      return {
        status: 'cancel',
        reason: job.args.reason || 'Cancelled by worker'
      };

    case 'cpu-bound':
      // Simulate CPU-bound work
      let result = 0;
      for (let i = 0; i < 1000000; i++) {
        result += Math.sqrt(i);
      }
      return {
        status: 'ok',
        value: { result, jobId: job.id }
      };

    default:
      return { status: 'ok', value: { action, args: job.args } };
  }
}
