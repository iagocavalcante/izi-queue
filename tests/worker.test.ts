import {
  registerWorker,
  getWorker,
  hasWorker,
  getWorkerNames,
  clearWorkers,
  executeWorker,
  getBackoffDelay,
  defineWorker,
  WorkerResults
} from '../src/core/worker.js';
import type { Job, WorkerDefinition } from '../src/types.js';

// Helper to create a mock job
function createMockJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    state: 'executing',
    queue: 'default',
    worker: 'TestWorker',
    args: {},
    meta: {},
    tags: [],
    errors: [],
    attempt: 1,
    maxAttempts: 20,
    priority: 0,
    insertedAt: new Date(),
    scheduledAt: new Date(),
    attemptedAt: new Date(),
    attemptedBy: null,
    uniqueKey: null,
    completedAt: null,
    discardedAt: null,
    cancelledAt: null,
    ...overrides
  };
}

describe('Worker Module', () => {
  beforeEach(() => {
    clearWorkers();
  });

  describe('registerWorker / getWorker / hasWorker', () => {
    it('should register and retrieve a worker', () => {
      const worker: WorkerDefinition = {
        name: 'TestWorker',
        perform: async () => WorkerResults.ok()
      };

      registerWorker(worker);

      expect(hasWorker('TestWorker')).toBe(true);
      expect(getWorker('TestWorker')).toEqual(worker);
    });

    it('should return undefined for unregistered worker', () => {
      expect(hasWorker('Unknown')).toBe(false);
      expect(getWorker('Unknown')).toBeUndefined();
    });

    it('should list all registered worker names', () => {
      registerWorker({ name: 'Worker1', perform: async () => {} });
      registerWorker({ name: 'Worker2', perform: async () => {} });
      registerWorker({ name: 'Worker3', perform: async () => {} });

      const names = getWorkerNames();
      expect(names).toContain('Worker1');
      expect(names).toContain('Worker2');
      expect(names).toContain('Worker3');
      expect(names).toHaveLength(3);
    });
  });

  describe('clearWorkers', () => {
    it('should remove all registered workers', () => {
      registerWorker({ name: 'Worker1', perform: async () => {} });
      registerWorker({ name: 'Worker2', perform: async () => {} });

      expect(getWorkerNames()).toHaveLength(2);

      clearWorkers();

      expect(getWorkerNames()).toHaveLength(0);
      expect(hasWorker('Worker1')).toBe(false);
    });
  });

  describe('defineWorker', () => {
    it('should create a worker definition with defaults', () => {
      const worker = defineWorker('MyWorker', async (job) => {
        return WorkerResults.ok(job.args);
      });

      expect(worker.name).toBe('MyWorker');
      expect(worker.perform).toBeDefined();
      expect(worker.queue).toBeUndefined();
      expect(worker.maxAttempts).toBeUndefined();
    });

    it('should create a worker definition with options', () => {
      const worker = defineWorker(
        'MyWorker',
        async () => {},
        {
          queue: 'priority',
          maxAttempts: 5,
          priority: 1,
          timeout: 30000
        }
      );

      expect(worker.queue).toBe('priority');
      expect(worker.maxAttempts).toBe(5);
      expect(worker.priority).toBe(1);
      expect(worker.timeout).toBe(30000);
    });
  });

  describe('executeWorker', () => {
    it('should execute registered worker and return ok result', async () => {
      registerWorker({
        name: 'OkWorker',
        perform: async () => WorkerResults.ok({ processed: true })
      });

      const job = createMockJob({ worker: 'OkWorker' });
      const result = await executeWorker(job);

      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value).toEqual({ processed: true });
      }
    });

    it('should handle void return as ok', async () => {
      registerWorker({
        name: 'VoidWorker',
        perform: async () => {
          // No return
        }
      });

      const job = createMockJob({ worker: 'VoidWorker' });
      const result = await executeWorker(job);

      expect(result.status).toBe('ok');
    });

    it('should return error result for thrown exception', async () => {
      registerWorker({
        name: 'ErrorWorker',
        perform: async () => {
          throw new Error('Something failed');
        }
      });

      const job = createMockJob({ worker: 'ErrorWorker' });
      const result = await executeWorker(job);

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect((result.error as Error).message).toBe('Something failed');
      }
    });

    it('should return error for unregistered worker', async () => {
      const job = createMockJob({ worker: 'NonExistent' });
      const result = await executeWorker(job);

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect((result.error as Error).message).toContain('not registered');
      }
    });

    it('should handle cancel result', async () => {
      registerWorker({
        name: 'CancelWorker',
        perform: async () => WorkerResults.cancel('Invalid data')
      });

      const job = createMockJob({ worker: 'CancelWorker' });
      const result = await executeWorker(job);

      expect(result.status).toBe('cancel');
      if (result.status === 'cancel') {
        expect(result.reason).toBe('Invalid data');
      }
    });

    it('should handle snooze result', async () => {
      registerWorker({
        name: 'SnoozeWorker',
        perform: async () => WorkerResults.snooze(60)
      });

      const job = createMockJob({ worker: 'SnoozeWorker' });
      const result = await executeWorker(job);

      expect(result.status).toBe('snooze');
      if (result.status === 'snooze') {
        expect(result.seconds).toBe(60);
      }
    });

    it('should timeout if worker takes too long', async () => {
      registerWorker({
        name: 'SlowWorker',
        perform: async () => {
          await new Promise(resolve => setTimeout(resolve, 200));
          return WorkerResults.ok();
        },
        timeout: 50 // 50ms timeout
      });

      const job = createMockJob({ worker: 'SlowWorker' });
      const result = await executeWorker(job);

      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect((result.error as Error).message).toContain('timed out');
      }
    });

    it('should clear the timeout after a worker completes', async () => {
      jest.useFakeTimers();
      try {
        registerWorker({
          name: 'FastWorker',
          perform: async () => WorkerResults.ok(),
          timeout: 60000
        });

        const result = await executeWorker(createMockJob({ worker: 'FastWorker' }));

        expect(result.status).toBe('ok');
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('still calls a legacy single-argument worker unchanged', async () => {
      // No second parameter declared at all -- the pre-#30 signature. Passing
      // the context object anyway must not affect it: JS silently ignores an
      // extra call argument.
      registerWorker({
        name: 'LegacyWorker',
        perform: async (job) => WorkerResults.ok({ args: job.args })
      });

      const job = createMockJob({ worker: 'LegacyWorker', args: { n: 1 } });
      const result = await executeWorker(job);

      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value).toEqual({ args: { n: 1 } });
      }
    });

    it('passes an AbortSignal as the second argument to perform', async () => {
      let seenSignal: AbortSignal | undefined;
      registerWorker({
        name: 'SignalWorker',
        perform: async (_job, { signal }) => {
          seenSignal = signal;
          return WorkerResults.ok();
        }
      });

      await executeWorker(createMockJob({ worker: 'SignalWorker' }));

      expect(seenSignal).toBeInstanceOf(AbortSignal);
      expect(seenSignal?.aborted).toBe(false);
    });

    it('fires the signal of an externally supplied AbortController', async () => {
      const controller = new AbortController();
      let seenAborted: boolean | undefined;

      registerWorker({
        name: 'AbortAwareWorker',
        perform: async (_job, { signal }) => {
          return new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () => {
              seenAborted = signal.aborted;
              reject(new Error('AbortError'));
            });
          });
        }
      });

      const job = createMockJob({ worker: 'AbortAwareWorker' });
      const pending = executeWorker(job, controller);
      controller.abort(new Error('cancelled'));

      const result = await pending;

      expect(seenAborted).toBe(true);
      expect(result.status).toBe('error');
    });

    it('aborts the signal when the job times out, so a cooperative worker stops too', async () => {
      let sawAbort = false;
      registerWorker({
        name: 'TimeoutAwareWorker',
        perform: async (_job, { signal }) => {
          return new Promise<never>((_, reject) => {
            const guard = setTimeout(() => reject(new Error('should not reach this')), 5000);
            signal.addEventListener('abort', () => {
              sawAbort = true;
              clearTimeout(guard);
              reject(new Error('AbortError'));
            });
          });
        },
        timeout: 30
      });

      const job = createMockJob({ worker: 'TimeoutAwareWorker' });
      const result = await executeWorker(job);

      expect(sawAbort).toBe(true);
      expect(result.status).toBe('error');
      if (result.status === 'error') {
        expect((result.error as Error).message).toContain('timed out');
      }
    });
  });

  describe('WorkerResults', () => {
    it('should create ok result', () => {
      const result = WorkerResults.ok({ data: 'test' });
      expect(result).toEqual({ status: 'ok', value: { data: 'test' } });
    });

    it('should create ok result without value', () => {
      const result = WorkerResults.ok();
      expect(result).toEqual({ status: 'ok', value: undefined });
    });

    it('should create error result with Error object', () => {
      const error = new Error('Test error');
      const result = WorkerResults.error(error);
      expect(result).toEqual({ status: 'error', error });
    });

    it('should create error result with string', () => {
      const result = WorkerResults.error('Something went wrong');
      expect(result).toEqual({ status: 'error', error: 'Something went wrong' });
    });

    it('should create cancel result', () => {
      const result = WorkerResults.cancel('User cancelled');
      expect(result).toEqual({ status: 'cancel', reason: 'User cancelled' });
    });

    it('should create snooze result', () => {
      const result = WorkerResults.snooze(300);
      expect(result).toEqual({ status: 'snooze', seconds: 300 });
    });
  });

  describe('getBackoffDelay', () => {
    it('uses the polynomial default when the worker declares no backoff at all', () => {
      registerWorker(defineWorker('NoBackoffWorker', async () => WorkerResults.ok()));
      const job = createMockJob({ worker: 'NoBackoffWorker', attempt: 3 });

      const delay = getBackoffDelay(job);

      // attempt^4 + 15 + rand(0..10)*attempt seconds, in ms
      expect(delay).toBeGreaterThanOrEqual(96000);
      expect(delay).toBeLessThanOrEqual(126000);
    });

    it('calls a custom backoff function when one is provided', () => {
      registerWorker(defineWorker('CustomFnWorker', async () => WorkerResults.ok(), {
        backoff: (job) => job.attempt * 60000
      }));
      const job = createMockJob({ worker: 'CustomFnWorker', attempt: 3 });

      expect(getBackoffDelay(job)).toBe(180000);
    });

    it('selects the legacy exponential strategy via a config object', () => {
      registerWorker(defineWorker('ExponentialWorker', async () => WorkerResults.ok(), {
        backoff: { strategy: 'exponential', jitterPercent: 0 }
      }));
      const job = createMockJob({ worker: 'ExponentialWorker', attempt: 1 });

      // 15 + 2^1 = 17s, no jitter
      expect(getBackoffDelay(job)).toBe(17000);
    });

    it('applies maxDelay from a config object', () => {
      registerWorker(defineWorker('CappedWorker', async () => WorkerResults.ok(), {
        backoff: { maxDelay: 50 }
      }));
      const job = createMockJob({ worker: 'CappedWorker', attempt: 20 });

      expect(getBackoffDelay(job)).toBe(50000);
    });

    it('falls back to the default when the worker is not registered', () => {
      const job = createMockJob({ worker: 'GhostWorker', attempt: 0 });

      // attempt 0 is deterministic: 0^4 + 15 + rand(0..10)*0 = 15s
      expect(getBackoffDelay(job)).toBe(15000);
    });
  });
});
