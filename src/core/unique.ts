import { createHash } from 'crypto';
import type { Job, UniqueOptions } from '../types.js';

export const DEFAULT_UNIQUE_FIELDS: NonNullable<UniqueOptions['fields']> = [
  'worker',
  'queue',
  'args'
];

export const DEFAULT_UNIQUE_STATES: NonNullable<UniqueOptions['states']> = [
  'available',
  'scheduled',
  'executing',
  'retryable'
];

export const DEFAULT_UNIQUE_PERIOD = 60;

/**
 * Recursively sorts object keys so that two payloads differing only in key
 * order hash identically. Array order is preserved: `[1, 2]` and `[2, 1]` are
 * genuinely different values.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .map(key => [key, canonicalize(source[key])]);
  }

  return value;
}

/**
 * Derives the value that decides whether two jobs are "the same" for uniqueness
 * purposes.
 *
 * Hashing here rather than in SQL buys three things: the key never reaches a
 * query, so arg key names cannot alter one; every adapter agrees on what a
 * duplicate is, rather than inheriting its database's JSON comparison rules;
 * and what gets indexed is a fixed-width digest instead of an unbounded
 * payload, which a btree index cannot always accommodate.
 */
export function computeUniqueKey<T = Record<string, unknown>>(
  job: Pick<Job<T>, 'worker' | 'queue' | 'args'>,
  options: UniqueOptions
): string {
  const fields = options.fields ?? DEFAULT_UNIQUE_FIELDS;
  const parts: Array<[string, unknown]> = [];

  // Pushed only when given, so digests computed without a scope are byte-for-
  // byte what they were before scopes existed.
  if (options.scope !== undefined) {
    parts.push(['scope', options.scope]);
  }

  if (fields.includes('worker')) {
    parts.push(['worker', job.worker]);
  }

  if (fields.includes('queue')) {
    parts.push(['queue', job.queue]);
  }

  if (fields.includes('args')) {
    const args = (job.args ?? {}) as Record<string, unknown>;

    if (options.keys && options.keys.length > 0) {
      // `undefined` would vanish from the digest, making "key absent" collide
      // with a key explicitly set to null. Mark absence distinctly instead.
      const selected = [...options.keys]
        .sort()
        .map(key => [key, key in args ? canonicalize(args[key]) : ['__absent__']]);
      parts.push(['args', selected]);
    } else {
      parts.push(['args', canonicalize(args)]);
    }
  }

  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/**
 * Projects a unique key onto a signed 64-bit integer for `pg_advisory_xact_lock`,
 * which only accepts a bigint. Returned as a string because the value does not
 * fit in a JS number and drivers accept the textual form.
 */
export function advisoryLockKey(uniqueKey: string): string {
  const unsigned = BigInt(`0x${uniqueKey.slice(0, 16)}`);
  const signed = unsigned >= 2n ** 63n ? unsigned - 2n ** 64n : unsigned;
  return signed.toString();
}
