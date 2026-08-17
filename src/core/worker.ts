import type { Job, WorkerDefinition, WorkerResult, IsolationConfig, WorkerContext } from '../types.js';
import { calculateBackoff } from './job.js';
import {
  executeIsolated,
  initializeIsolation,
  terminateIsolatedJob as terminateIsolated,
  shutdownIsolation,
  getIsolationStats
} from './isolation/index.js';

const workerRegistry = new Map<string, WorkerDefinition>();

export function registerWorker<T = Record<string, unknown>>(
  definition: WorkerDefinition<T>
): void {
  workerRegistry.set(definition.name, definition as WorkerDefinition);
}

export function getWorker(name: string): WorkerDefinition | undefined {
  return workerRegistry.get(name);
}

export function hasWorker(name: string): boolean {
  return workerRegistry.has(name);
}

export function getWorkerNames(): string[] {
  return Array.from(workerRegistry.keys());
}

export function clearWorkers(): void {
  workerRegistry.clear();
}

/**
 * Runs `job`'s worker. `controller` -- owned by the caller, typically
 * `Queue`, so it can be reached and aborted from outside this call while it
 * is still in flight -- is only meaningful for in-process workers: isolated
 * (worker-thread) jobs cannot receive a live signal across the thread
 * boundary, so `executeIsolated` never sees it. When no controller is
 * supplied one is created locally, which keeps this function usable on its
 * own (as the tests for it do) without a caller that tracks cancellation.
 */
export async function executeWorker(job: Job, controller?: AbortController): Promise<WorkerResult> {
  const worker = getWorker(job.worker);

  if (!worker) {
    return {
      status: 'error',
      error: new Error(`Worker "${job.worker}" not registered`)
    };
  }

  const timeout = worker.timeout ?? 60000;

  if (worker.isolation?.isolated) {
    return executeIsolated(job, worker.isolation, timeout);
  }

  const abortController = controller ?? new AbortController();
  const context: WorkerContext = { signal: abortController.signal };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      worker.perform(job, context),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          // A worker's own timeout is a reason to stop doing work too, the
          // same as an operator cancelling it -- a well-behaved worker that
          // threads `signal` through stops here instead of continuing on
          // borrowed time for a result nothing will use.
          abortController.abort(new Error(`Job timed out after ${timeout}ms`));
          reject(new Error(`Job timed out after ${timeout}ms`));
        }, timeout);
      })
    ]);

    if (result === undefined) {
      return { status: 'ok' };
    }

    return result;
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error : new Error(String(error))
    };
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

export function getBackoffDelay(job: Job): number {
  const worker = getWorker(job.worker);

  if (typeof worker?.backoff === 'function') {
    return worker.backoff(job);
  }

  return calculateBackoff(job.attempt, worker?.backoff);
}

export function defineWorker<T = Record<string, unknown>>(
  name: string,
  perform: (job: Job<T>, context: WorkerContext) => Promise<WorkerResult | void>,
  options: Partial<Omit<WorkerDefinition<T>, 'name' | 'perform'>> = {}
): WorkerDefinition<T> {
  return {
    name,
    perform,
    ...options
  };
}

export const WorkerResults = {
  ok: (value?: unknown): WorkerResult => ({ status: 'ok', value }),
  error: (error: Error | string): WorkerResult => ({ status: 'error', error }),
  cancel: (reason: string): WorkerResult => ({ status: 'cancel', reason }),
  snooze: (seconds: number): WorkerResult => ({ status: 'snooze', seconds })
};

export function initializeIsolatedWorkers(config?: IsolationConfig): void {
  initializeIsolation(config);
}

export async function shutdownIsolatedWorkers(): Promise<void> {
  await shutdownIsolation();
}

/**
 * Pre-emptively kills the worker thread running `jobId`, if any. `result` is
 * what the job's still-pending `executeWorker` call resolves with -- callers
 * cancelling a job pass `{ status: 'cancel', ... }` so it settles the same
 * way an in-process worker's own cancel result would; `Queue.stop()`'s
 * grace-period timeout leaves it at the default (an error), which is
 * unrelated to cancellation and keeps its existing retry/discard behavior.
 * Returns whether a thread running that job was actually found and killed.
 */
export async function terminateIsolatedJob(
  jobId: number,
  result?: WorkerResult
): Promise<boolean> {
  return terminateIsolated(jobId, result);
}

export { getIsolationStats };
