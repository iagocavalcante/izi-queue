import { computeUniqueKey, advisoryLockKey } from '../src/core/unique.js';
import type { Job, UniqueOptions } from '../src/types.js';

function job(overrides: Partial<Job> = {}): Omit<Job, 'id' | 'insertedAt'> {
  return {
    state: 'available',
    queue: 'default',
    worker: 'SendEmail',
    args: {},
    meta: {},
    tags: [],
    errors: [],
    attempt: 0,
    maxAttempts: 20,
    priority: 0,
    scheduledAt: new Date(),
    attemptedAt: null,
    attemptedBy: null,
    completedAt: null,
    discardedAt: null,
    cancelledAt: null,
    ...overrides,
  } as Omit<Job, 'id' | 'insertedAt'>;
}

const DEFAULTS: UniqueOptions = {};

describe('computeUniqueKey', () => {
  it('is stable for identical jobs', () => {
    const a = computeUniqueKey(job({ args: { userId: 1 } }), DEFAULTS);
    const b = computeUniqueKey(job({ args: { userId: 1 } }), DEFAULTS);

    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]+$/);
  });

  it('ignores key order in args', () => {
    const a = computeUniqueKey(job({ args: { a: 1, b: 2 } }), DEFAULTS);
    const b = computeUniqueKey(job({ args: { b: 2, a: 1 } }), DEFAULTS);

    expect(a).toBe(b);
  });

  it('ignores key order in nested objects', () => {
    const a = computeUniqueKey(job({ args: { o: { x: 1, y: 2 }, z: 3 } }), DEFAULTS);
    const b = computeUniqueKey(job({ args: { z: 3, o: { y: 2, x: 1 } } }), DEFAULTS);

    expect(a).toBe(b);
  });

  it('preserves array order, which is significant', () => {
    const a = computeUniqueKey(job({ args: { items: [1, 2] } }), DEFAULTS);
    const b = computeUniqueKey(job({ args: { items: [2, 1] } }), DEFAULTS);

    expect(a).not.toBe(b);
  });

  it('distinguishes different args', () => {
    const a = computeUniqueKey(job({ args: { userId: 1 } }), DEFAULTS);
    const b = computeUniqueKey(job({ args: { userId: 2 } }), DEFAULTS);

    expect(a).not.toBe(b);
  });

  it('distinguishes a numeric value from its string form', () => {
    const a = computeUniqueKey(job({ args: { id: 1 } }), DEFAULTS);
    const b = computeUniqueKey(job({ args: { id: '1' } }), DEFAULTS);

    expect(a).not.toBe(b);
  });

  it('distinguishes workers and queues by default', () => {
    const base = computeUniqueKey(job(), DEFAULTS);

    expect(computeUniqueKey(job({ worker: 'Other' }), DEFAULTS)).not.toBe(base);
    expect(computeUniqueKey(job({ queue: 'other' }), DEFAULTS)).not.toBe(base);
  });

  it('honours a narrowed field set', () => {
    const opts: UniqueOptions = { fields: ['worker'] };

    expect(computeUniqueKey(job({ queue: 'a', args: { x: 1 } }), opts)).toBe(
      computeUniqueKey(job({ queue: 'b', args: { x: 2 } }), opts)
    );
  });

  it('honours selected arg keys and ignores the rest', () => {
    const opts: UniqueOptions = { keys: ['userId'] };

    expect(computeUniqueKey(job({ args: { userId: 1, at: 'noon' } }), opts)).toBe(
      computeUniqueKey(job({ args: { userId: 1, at: 'midnight' } }), opts)
    );
    expect(computeUniqueKey(job({ args: { userId: 1 } }), opts)).not.toBe(
      computeUniqueKey(job({ args: { userId: 2 } }), opts)
    );
  });

  it('treats a missing selected key as distinct from a present one', () => {
    const opts: UniqueOptions = { keys: ['userId'] };

    expect(computeUniqueKey(job({ args: {} }), opts)).not.toBe(
      computeUniqueKey(job({ args: { userId: 1 } }), opts)
    );
  });

  it('is not affected by the order selected keys are listed in', () => {
    expect(computeUniqueKey(job({ args: { a: 1, b: 2 } }), { keys: ['a', 'b'] })).toBe(
      computeUniqueKey(job({ args: { a: 1, b: 2 } }), { keys: ['b', 'a'] })
    );
  });

  it('treats SQL metacharacters in key names as ordinary text', () => {
    // Keys are hashed in JS and never reach SQL, so an injection payload is
    // just another key name. It must not collide with the benign key either.
    const evil = "x') OR 1=1 --";
    const opts: UniqueOptions = { keys: [evil] };

    const key = computeUniqueKey(job({ args: { [evil]: 'v' } }), opts);

    expect(key).toMatch(/^[0-9a-f]+$/);
    expect(key).not.toBe(computeUniqueKey(job({ args: { x: 'v' } }), { keys: ['x'] }));
  });

  it('separates jobs by scope', () => {
    const january = computeUniqueKey(job({ args: { userId: 1 } }), { scope: '2026-01' });
    const february = computeUniqueKey(job({ args: { userId: 1 } }), { scope: '2026-02' });

    expect(january).not.toBe(february);
  });

  it('collapses identical jobs sharing a scope', () => {
    const a = computeUniqueKey(job({ args: { userId: 1 } }), { scope: 'cron:2026-08-24T09:00Z' });
    const b = computeUniqueKey(job({ args: { userId: 1 } }), { scope: 'cron:2026-08-24T09:00Z' });

    expect(a).toBe(b);
  });

  it('still distinguishes different jobs within one scope', () => {
    const first = computeUniqueKey(job({ args: { userId: 1 } }), { scope: 'batch-7' });
    const second = computeUniqueKey(job({ args: { userId: 2 } }), { scope: 'batch-7' });

    expect(first).not.toBe(second);
  });

  it('leaves the digest untouched when no scope is given', () => {
    // Adding scopes must not invalidate unique keys already stored in
    // izi_jobs, or every in-flight unique job would stop deduplicating.
    expect(computeUniqueKey(job({ args: { userId: 1 } }), DEFAULTS)).toBe(
      // sha256 of [["worker","SendEmail"],["queue","default"],["args",[["userId",1]]]],
      // computed independently of this implementation.
      'c1375b5e4b05b9dc3f551d295fe37e51'
    );
  });

  it('produces a key short enough for a MySQL lock name', () => {
    // GET_LOCK names are capped at 64 characters.
    expect(computeUniqueKey(job(), DEFAULTS).length).toBeLessThanOrEqual(64);
  });
});

describe('advisoryLockKey', () => {
  it('maps a unique key onto a stable signed 64-bit integer', () => {
    const key = computeUniqueKey(job({ args: { userId: 1 } }), DEFAULTS);

    const a = advisoryLockKey(key);
    const b = advisoryLockKey(key);

    expect(a).toBe(b);
    expect(BigInt(a)).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(BigInt(a)).toBeLessThan(2n ** 63n);
  });

  it('separates different unique keys', () => {
    const a = advisoryLockKey(computeUniqueKey(job({ args: { userId: 1 } }), DEFAULTS));
    const b = advisoryLockKey(computeUniqueKey(job({ args: { userId: 2 } }), DEFAULTS));

    expect(a).not.toBe(b);
  });
});
