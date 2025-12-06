import type { Job, JobInsertOptions, JobState } from '../types.js';

export const STATE_TRANSITIONS: Record<JobState, JobState[]> = {
  scheduled: ['available', 'cancelled'],
  available: ['executing', 'cancelled'],
  executing: ['completed', 'retryable', 'discarded', 'cancelled'],
  retryable: ['available', 'cancelled'],
  completed: [],
  discarded: [],
  cancelled: []
};

export const TERMINAL_STATES: JobState[] = ['completed', 'discarded', 'cancelled'];

export function isValidTransition(from: JobState, to: JobState): boolean {
  return STATE_TRANSITIONS[from].includes(to);
}

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function createJob<T = Record<string, unknown>>(
  worker: string,
  options: JobInsertOptions<T>
): Omit<Job<T>, 'id' | 'insertedAt'> {
  const scheduledAt = options.scheduledAt ?? new Date();
  const state: JobState = options.scheduledAt && options.scheduledAt > new Date()
    ? 'scheduled'
    : 'available';

  return {
    state,
    queue: options.queue ?? 'default',
    worker,
    args: options.args,
    meta: options.meta ?? {},
    tags: options.tags ?? [],
    errors: [],
    attempt: 0,
    maxAttempts: options.maxAttempts ?? 20,
    priority: options.priority ?? 0,
    scheduledAt,
    attemptedAt: null,
    completedAt: null,
    discardedAt: null,
    cancelledAt: null
  };
}

/**
 * Calculate backoff delay with exponential backoff and jitter
 * Default: 15 + 2^attempt seconds with +/-10% jitter
 */
export function calculateBackoff(
  attempt: number,
  options: {
    basePad?: number;
    multiplier?: number;
    maxPower?: number;
    jitterPercent?: number;
  } = {}
): number {
  const {
    basePad = 15,
    multiplier = 1,
    maxPower = 10,
    jitterPercent = 0.1
  } = options;

  const power = Math.min(attempt, maxPower);
  const base = basePad + multiplier * Math.pow(2, power);
  const jitter = base * jitterPercent * (Math.random() * 2 - 1);

  return Math.round((base + jitter) * 1000);
}

export function formatError(error: Error | string, attempt: number): Job['errors'][0] {
  const isError = error instanceof Error;
  return {
    at: new Date(),
    attempt,
    error: isError ? error.message : String(error),
    stacktrace: isError ? error.stack : undefined
  };
}
