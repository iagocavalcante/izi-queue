import type { Job, WorkerDefinition, WorkerResult, IsolationConfig } from '../types.js';
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

export async function executeWorker(job: Job): Promise<WorkerResult> {
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

  try {
    const result = await Promise.race([
      worker.perform(job),
      new Promise<WorkerResult>((_, reject) =>
        setTimeout(() => reject(new Error(`Job timed out after ${timeout}ms`)), timeout)
      )
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
  }
}

export function getBackoffDelay(job: Job): number {
  const worker = getWorker(job.worker);

  if (worker?.backoff) {
    return worker.backoff(job);
  }

  return calculateBackoff(job.attempt);
}

export function defineWorker<T = Record<string, unknown>>(
  name: string,
  perform: (job: Job<T>) => Promise<WorkerResult | void>,
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

export async function terminateIsolatedJob(jobId: number): Promise<void> {
  await terminateIsolated(jobId);
}

export { getIsolationStats };
