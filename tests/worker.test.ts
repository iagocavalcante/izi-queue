import {
  registerWorker,
  getWorker,
  hasWorker,
  getWorkerNames,
  clearWorkers,
  executeWorker,
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
});
