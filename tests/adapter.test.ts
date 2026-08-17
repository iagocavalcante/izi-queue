import { runInBatches } from '../src/database/adapter.js';

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
