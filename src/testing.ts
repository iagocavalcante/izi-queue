import assert, { AssertionError } from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { inspect, isDeepStrictEqual } from 'node:util';
import { createJob } from './core/job.js';
import { executeWorker, getWorker } from './core/worker.js';
import type { DatabaseAdapter, Job, JobCriteria, JobInsertOptions, WorkerDefinition, WorkerResult } from './types.js';

export type TestJobOptions<T = Record<string, unknown>> =
  Omit<JobInsertOptions<T>, 'args' | 'tx' | 'unique'> & { id?: number; attempt?: number };

export interface EnqueuedCriteria extends Omit<JobCriteria, 'state' | 'all'> {
  /** Deep subset matching for objects; arrays and scalar values match exactly. */
  args?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  priority?: number;
}

export interface AssertionOptions {
  /** Milliseconds to wait for a match, or to observe its absence. Default 0. */
  timeout?: number;
  /** Polling interval in milliseconds. Default 10. Uses real timers. */
  interval?: number;
}

type JobSource = Pick<DatabaseAdapter, 'listJobs'>;
// Negative ids avoid colliding with persisted jobs in the shared isolation pool.
let nextJobId = -1;

function resolveWorker<T>(worker: WorkerDefinition<T> | string): WorkerDefinition<T> {
  const definition = typeof worker === 'string' ? getWorker(worker) : worker;
  assert(definition && typeof definition.name === 'string' && definition.name.length &&
    typeof definition.perform === 'function', `Expected a worker definition or registered worker name, got ${inspect(worker)}`);
  return definition as WorkerDefinition<T>;
}

/** Build an executing job without a database or changes to the worker registry. */
export function buildJob<T>(worker: WorkerDefinition<T> | string, args: T, options: TestJobOptions<T> = {}): Job<T> {
  const definition = resolveWorker(worker);
  assert(options.tags === undefined || (Array.isArray(options.tags) && options.tags.every(tag => typeof tag === 'string')),
    'tags must be an array of strings');
  const data = createJob(definition.name, {
    ...options,
    // Exercise the same JSON round-trip as persisted arguments and metadata.
    args: JSON.parse(JSON.stringify(args)) as T,
    meta: JSON.parse(JSON.stringify(options.meta ?? {})),
    tags: [...(options.tags ?? [])],
    queue: options.queue ?? definition.queue ?? 'default',
    maxAttempts: options.maxAttempts ?? definition.maxAttempts ?? 20,
    priority: options.priority ?? definition.priority ?? 0
  });
  const id = options.id ?? nextJobId--;
  const attempt = options.attempt ?? 1;
  assert(Number.isSafeInteger(id), 'id must be a safe integer');
  assert(Number.isSafeInteger(attempt) && attempt > 0, 'attempt must be a positive safe integer');
  assert(Number.isSafeInteger(data.maxAttempts) && data.maxAttempts > 0, 'maxAttempts must be a positive safe integer');
  assert(Number.isSafeInteger(data.priority) && data.priority >= 0, 'priority must be a non-negative safe integer');
  assert(typeof data.queue === 'string' && data.queue.length, 'queue must be a non-empty string');
  assert(data.scheduledAt instanceof Date && Number.isFinite(data.scheduledAt.getTime()), 'scheduledAt must be a valid Date');
  const now = new Date();
  return { ...data, id, insertedAt: now, state: 'executing', attempt, attemptedAt: now };
}

/** Run one attempt through the normal timeout/isolation path; no persistence or automatic retry. */
export async function performJob<T>(worker: WorkerDefinition<T> | string, args: T, options: TestJobOptions<T> = {}): Promise<WorkerResult> {
  const definition = resolveWorker(worker);
  const job = buildJob(definition, args, options);
  const result = await executeWorker(job as Job, undefined, definition as WorkerDefinition);
  assert(result && (
    result.status === 'ok' ||
    (result.status === 'error' && (result.error instanceof Error || typeof result.error === 'string')) ||
    (result.status === 'cancel' && typeof result.reason === 'string') ||
    (result.status === 'snooze' && Number.isFinite(result.seconds) && result.seconds >= 0)
  ), `Worker "${definition.name}" returned an invalid result: ${inspect(result)}`);
  return result;
}

function matches(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === 'object' &&
      (Object.getPrototypeOf(expected) === Object.prototype || Object.getPrototypeOf(expected) === null)) {
    return actual !== null && typeof actual === 'object' && !Array.isArray(actual) && Object.entries(expected).every(([key, value]) =>
      Object.prototype.hasOwnProperty.call(actual, key) && matches((actual as Record<string, unknown>)[key], value)
    );
  }
  return isDeepStrictEqual(actual, expected);
}

/** List available and scheduled jobs, newest first. Use listJobs for other states. */
export async function allEnqueued(source: JobSource, criteria: EnqueuedCriteria = {}): Promise<Job[]> {
  assert(source.listJobs, 'Testing assertions require an adapter with listJobs support');
  const { ids, queue, worker, tags, args, meta, priority } = criteria;
  const found: Job[] = [];
  // ponytail: JSON matching scans test fixtures in memory; add adapter predicates if fixtures become large.
  for (let offset = 0; ; offset += 1000) {
    const page = await source.listJobs({
      ids, queue, worker, tags, state: ['available', 'scheduled'],
      limit: 1000, offset, orderBy: { field: 'id', direction: 'desc' }
    });
    found.push(...page.filter(job =>
      (args === undefined || matches(job.args, args)) &&
      (meta === undefined || matches(job.meta, meta)) &&
      (priority === undefined || job.priority === priority)
    ));
    if (page.length < 1000) return found;
  }
}

async function checkEnqueued(source: JobSource, criteria: EnqueuedCriteria, options: AssertionOptions, present: boolean): Promise<Job | undefined> {
  const { timeout = 0, interval = 10 } = options;
  assert(Number.isFinite(timeout) && timeout >= 0, 'timeout must be a finite non-negative number');
  assert(Number.isFinite(interval) && interval > 0, 'interval must be a finite positive number');
  const deadline = performance.now() + timeout;
  for (;;) {
    const [job] = await allEnqueued(source, criteria);
    if (present && job) return job;
    const remaining = deadline - performance.now();
    if ((!present && job) || (present && remaining <= 0)) {
      throw new AssertionError({
        message: `Expected ${present ? 'an' : 'no'} enqueued job matching ${inspect(criteria)}`,
        actual: job ?? null, expected: criteria, operator: present ? 'assertEnqueued' : 'refuteEnqueued'
      });
    }
    if (remaining <= 0) return;
    await delay(Math.min(interval, remaining));
  }
}

/** Return the matching job, or throw a standard Node AssertionError. */
export async function assertEnqueued(source: JobSource, criteria: EnqueuedCriteria = {}, options: AssertionOptions = {}): Promise<Job> {
  const job = await checkEnqueued(source, criteria, options, true);
  assert(job);
  return job;
}

/** Assert absence, optionally observing for the entire timeout window. */
export async function refuteEnqueued(source: JobSource, criteria: EnqueuedCriteria = {}, options: AssertionOptions = {}): Promise<void> {
  await checkEnqueued(source, criteria, options, false);
}
