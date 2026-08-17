import type { BackoffOptions, Job, JobInsertOptions, JobState } from '../types.js';

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

/**
 * The states a job may legally be in for `to` to be reachable. Passed to
 * `updateJob` so the database refuses an illegal transition, which is the only
 * place the check can be made safely: the race is between nodes, not within
 * this process.
 */
export function sourceStatesFor(to: JobState): JobState[] {
  return (Object.keys(STATE_TRANSITIONS) as JobState[]).filter(from =>
    STATE_TRANSITIONS[from].includes(to)
  );
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
    attemptedBy: null,
    uniqueKey: null,
    completedAt: null,
    discardedAt: null,
    cancelledAt: null
  };
}

/**
 * Calculate the backoff delay (in ms) before a failed job is retried.
 *
 * Defaults to Oban's polynomial curve: `attempt^4 + padSeconds + rand(0..jitterMax)
 * * attempt` seconds. That spreads `maxAttempts: 20` across ~44 hours by the
 * final attempt, rather than plateauing at ~17 minutes -- see
 * `calculatePolynomialBackoffSeconds` below for the attempt -> delay table.
 *
 * Pass `{ strategy: 'exponential' }` for the original curve: `basePad +
 * multiplier * 2^min(attempt, maxPower)` seconds with `+/-jitterPercent` jitter.
 *
 * `maxDelay` (seconds) caps either curve's result. Neither curve is capped by
 * default; the exponential curve is already implicitly bounded via `maxPower`.
 */
export function calculateBackoff(attempt: number, options: BackoffOptions = {}): number {
  const { strategy = 'polynomial', maxDelay } = options;

  const delaySeconds = strategy === 'exponential'
    ? calculateExponentialBackoffSeconds(attempt, options)
    : calculatePolynomialBackoffSeconds(attempt, options);

  const cappedSeconds = maxDelay !== undefined ? Math.min(delaySeconds, maxDelay) : delaySeconds;

  return Math.round(cappedSeconds * 1000);
}

/**
 * Oban's default curve: `attempt^4 + padSeconds + rand(0..jitterMax) * attempt`
 * seconds. Attempt -> cumulative time (default options, jitter midpoint):
 *
 * | attempt | delay     | cumulative      |
 * |---------|-----------|-----------------|
 * | 1       | ~21s      | ~21s            |
 * | 5       | ~11min    | ~19min          |
 * | 10      | ~2.8hr    | ~7.2hr          |
 * | 15      | ~14.1hr   | ~49.8hr (~2.1d) |
 * | 20      | ~44.5hr   | ~201hr (~8.4d)  |
 */
function calculatePolynomialBackoffSeconds(attempt: number, options: BackoffOptions): number {
  const { padSeconds = 15, power = 4, jitterMax = 10 } = options;

  const base = Math.pow(attempt, power) + padSeconds;
  const jitter = Math.random() * jitterMax * attempt;

  return base + jitter;
}

/**
 * The original izi-queue curve: `basePad + multiplier * 2^min(attempt,
 * maxPower)` seconds with `+/-jitterPercent` jitter. Plateaus at ~17 minutes
 * once `attempt` reaches `maxPower` (default 10).
 */
function calculateExponentialBackoffSeconds(attempt: number, options: BackoffOptions): number {
  const { basePad = 15, multiplier = 1, maxPower = 10, jitterPercent = 0.1 } = options;

  const power = Math.min(attempt, maxPower);
  const base = basePad + multiplier * Math.pow(2, power);
  const jitter = base * jitterPercent * (Math.random() * 2 - 1);

  return base + jitter;
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
