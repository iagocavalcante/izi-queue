import {
  buildStateCounts,
  criteriaClause,
  DEFAULT_LIST_LIMIT,
  JOB_STATES,
  MAX_LIST_LIMIT,
  orderByClause,
  resolveListLimit,
  resolveListOffset,
  runInBatches
} from '../src/database/adapter.js';
import type { JobCriteria } from '../src/types.js';

describe('runInBatches', () => {
  it.each([0, -1, NaN, Infinity])(
    'rejects a non-positive or non-finite limit (%p) instead of looping forever',
    async (limit) => {
      const operation = jest.fn(async () => 1);

      await expect(runInBatches(operation, limit)).rejects.toThrow(/limit must be a positive number/);
      expect(operation).not.toHaveBeenCalled();
    }
  );

  it('loops until a batch affects fewer than `limit` rows, summing the total', async () => {
    const affectedPerCall = [5, 5, 2];
    const operation = jest.fn(async (limit: number) => {
      expect(limit).toBe(5);
      return affectedPerCall.shift() ?? 0;
    });

    const total = await runInBatches(operation, 5);

    expect(total).toBe(12);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('stops after the first call when it already affects fewer than `limit` rows', async () => {
    const operation = jest.fn(async () => 3);

    const total = await runInBatches(operation, 5);

    expect(total).toBe(3);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('keeps looping when every batch is exactly full, until one comes back empty', async () => {
    let calls = 0;
    const operation = jest.fn(async () => {
      calls++;
      return calls <= 3 ? 5 : 0;
    });

    const total = await runInBatches(operation, 5);

    expect(total).toBe(15);
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it('yields to the event loop between batches', async () => {
    const order: string[] = [];
    const operation = jest.fn(async () => {
      order.push('operation');
      return order.filter(e => e === 'operation').length < 2 ? 5 : 0;
    });

    setImmediate(() => order.push('event-loop'));

    await runInBatches(operation, 5);

    // The scheduled setImmediate ran in between the two full batches, not
    // after runInBatches had already finished -- proof the loop actually
    // yielded instead of running both batches back-to-back synchronously.
    expect(order).toEqual(['operation', 'event-loop', 'operation']);
  });
});

describe('criteriaClause', () => {
  const numbered = (i: number): string => `$${i}`;
  const questionMark = (): string => '?';

  it('builds no clause for an empty criteria object', () => {
    const { clause, params } = criteriaClause({}, numbered, 'postgres');
    expect(clause).toBe('');
    expect(params).toEqual([]);
  });

  it('combines ids/queue/worker/state into one AND-ed clause with sequential placeholders', () => {
    const criteria: JobCriteria = {
      ids: [1, 2],
      queue: 'default',
      worker: 'W',
      state: ['available', 'scheduled']
    };
    const { clause, params } = criteriaClause(criteria, numbered, 'postgres');

    expect(clause).toBe(' AND id IN ($1,$2) AND queue = $3 AND worker = $4 AND state IN ($5,$6)');
    expect(params).toEqual([1, 2, 'default', 'W', 'available', 'scheduled']);
  });

  it('emits the Postgres array-overlap operator for tags, passing the array as a single param', () => {
    const { clause, params } = criteriaClause({ tags: ['billing', 'urgent'] }, numbered, 'postgres');
    expect(clause).toBe(' AND tags && $1');
    expect(params).toEqual([['billing', 'urgent']]);
  });

  it('emits JSON_OVERLAPS for MySQL, passing the tags as a JSON string param', () => {
    const { clause, params } = criteriaClause({ tags: ['billing', 'urgent'] }, questionMark, 'mysql');
    expect(clause).toBe(' AND JSON_OVERLAPS(tags, ?)');
    expect(params).toEqual([JSON.stringify(['billing', 'urgent'])]);
  });

  it('emits a json_each membership EXISTS for SQLite, one placeholder per tag', () => {
    const { clause, params } = criteriaClause({ tags: ['billing', 'urgent'] }, questionMark, 'sqlite');
    expect(clause).toBe(' AND EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value IN (?,?))');
    expect(params).toEqual(['billing', 'urgent']);
  });

  it('ignores an empty tags array rather than emitting a clause that matches nothing', () => {
    const { clause, params } = criteriaClause({ tags: [] }, numbered, 'postgres');
    expect(clause).toBe('');
    expect(params).toEqual([]);
  });

  it('keeps placeholder numbering correct on Postgres when tags follow other criteria', () => {
    const { clause, params } = criteriaClause(
      { queue: 'default', tags: ['a'] },
      numbered,
      'postgres'
    );
    expect(clause).toBe(' AND queue = $1 AND tags && $2');
    expect(params).toEqual(['default', ['a']]);
  });
});

describe('orderByClause', () => {
  it('defaults to insertedAt desc, tie-broken by id desc', () => {
    expect(orderByClause(undefined)).toBe('ORDER BY inserted_at DESC, id DESC');
  });

  it('maps every whitelisted field to its column and appends an id tiebreaker', () => {
    expect(orderByClause({ field: 'priority', direction: 'asc' })).toBe(
      'ORDER BY priority ASC, id ASC'
    );
    expect(orderByClause({ field: 'scheduledAt', direction: 'desc' })).toBe(
      'ORDER BY scheduled_at DESC, id DESC'
    );
    expect(orderByClause({ field: 'attemptedAt', direction: 'asc' })).toBe(
      'ORDER BY attempted_at ASC, id ASC'
    );
  });

  it('does not double up the tiebreaker when the field is already id', () => {
    expect(orderByClause({ field: 'id', direction: 'asc' })).toBe('ORDER BY id ASC');
  });

  it('rejects a field outside the whitelist -- the point being no caller-supplied SQL can ever reach the query', () => {
    expect(() =>
      orderByClause({ field: 'args' as never, direction: 'asc' })
    ).toThrow(/invalid listJobs orderBy\.field/);
  });

  it('rejects a direction outside asc/desc even if TypeScript is bypassed', () => {
    expect(() =>
      orderByClause({ field: 'id', direction: 'ASC; DROP TABLE izi_jobs;--' as never })
    ).toThrow(/direction must be 'asc' or 'desc'/);
  });
});

describe('resolveListLimit', () => {
  it(`defaults to ${DEFAULT_LIST_LIMIT}`, () => {
    expect(resolveListLimit(undefined)).toBe(DEFAULT_LIST_LIMIT);
  });

  it('passes through a limit within range', () => {
    expect(resolveListLimit(10)).toBe(10);
  });

  it(`caps a limit above ${MAX_LIST_LIMIT} rather than allowing an unbounded scan`, () => {
    expect(resolveListLimit(1_000_000)).toBe(MAX_LIST_LIMIT);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects a non-positive or non-integer limit (%p)', (limit) => {
    expect(() => resolveListLimit(limit)).toThrow(/positive integer/);
  });
});

describe('resolveListOffset', () => {
  it('defaults to 0', () => {
    expect(resolveListOffset(undefined)).toBe(0);
  });

  it('passes through a non-negative offset', () => {
    expect(resolveListOffset(50)).toBe(50);
  });

  it.each([-1, 1.5, NaN])('rejects a negative or non-integer offset (%p)', (offset) => {
    expect(() => resolveListOffset(offset)).toThrow(/non-negative integer/);
  });
});

describe('buildStateCounts', () => {
  it('seeds every job state at 0, even with no rows', () => {
    const counts = buildStateCounts([]);
    expect(Object.keys(counts).sort()).toEqual([...JOB_STATES].sort());
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it('fills in counts from grouped rows, coercing string/bigint counts to number', () => {
    const counts = buildStateCounts([
      { state: 'available', count: '3' },
      { state: 'discarded', count: 2 },
      { state: 'completed', count: 5n }
    ]);

    expect(counts.available).toBe(3);
    expect(counts.discarded).toBe(2);
    expect(counts.completed).toBe(5);
    expect(counts.executing).toBe(0);
  });
});
