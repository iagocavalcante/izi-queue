import Database from 'better-sqlite3';
import { IziQueue } from '../src/core/izi-queue.js';
import { clearWorkers } from '../src/core/worker.js';
import { createSQLiteAdapter, SQLiteAdapter } from '../src/database/sqlite.js';

/**
 * The point of a database-backed queue: a job must not survive a business write
 * that rolled back, and must not be visible before one that committed.
 */
describe('transactional insert (SQLite)', () => {
  let db: Database.Database;
  let adapter: SQLiteAdapter;
  let queue: IziQueue;

  beforeEach(async () => {
    db = new Database(':memory:');
    adapter = createSQLiteAdapter(db);
    await adapter.migrate();
    db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, total INTEGER NOT NULL)');
    clearWorkers();

    queue = new IziQueue({ database: adapter, queues: { default: 1 } });
  });

  afterEach(async () => {
    await adapter.close();
  });

  function countJobs(): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM izi_jobs').get() as { c: number }).c;
  }

  it('discards the job when the surrounding transaction rolls back', async () => {
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO orders (total) VALUES (?)').run(100);
      await queue.insert('send_receipt', { args: { orderId: 1 }, tx: db });
      throw new Error('payment declined');
    } catch {
      db.exec('ROLLBACK');
    }

    expect(countJobs()).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM orders').get() as { c: number }).c).toBe(0);
  });

  it('keeps the job when the surrounding transaction commits', async () => {
    db.exec('BEGIN');
    db.prepare('INSERT INTO orders (total) VALUES (?)').run(100);
    const job = await queue.insert('send_receipt', { args: { orderId: 1 }, tx: db });
    db.exec('COMMIT');

    expect(countJobs()).toBe(1);
    expect((await queue.getJob(job.id))?.args).toEqual({ orderId: 1 });
  });

  it('rolls back a unique job with its transaction', async () => {
    db.exec('BEGIN');
    await queue.insert('digest', { args: { userId: 1 }, unique: { period: 60 }, tx: db });
    db.exec('ROLLBACK');

    expect(countJobs()).toBe(0);

    // The rolled-back job must not linger as a phantom conflict.
    const { conflict } = await queue.insertWithResult('digest', {
      args: { userId: 1 },
      unique: { period: 60 },
    });
    expect(conflict).toBe(false);
  });

  it('still deduplicates unique jobs inside a transaction', async () => {
    db.exec('BEGIN');
    const first = await queue.insertWithResult('digest', {
      args: { userId: 1 },
      unique: { period: 60 },
      tx: db,
    });
    const second = await queue.insertWithResult('digest', {
      args: { userId: 1 },
      unique: { period: 60 },
      tx: db,
    });
    db.exec('COMMIT');

    expect(first.conflict).toBe(false);
    expect(second.conflict).toBe(true);
    expect(countJobs()).toBe(1);
  });

  it('rejects a handle from a different database', async () => {
    const other = new Database(':memory:');
    try {
      await expect(
        queue.insert('send_receipt', { args: {}, tx: other })
      ).rejects.toThrow(/same database/i);
    } finally {
      other.close();
    }
  });

  it('inserts outside any transaction when no handle is given', async () => {
    await queue.insert('send_receipt', { args: {} });
    expect(countJobs()).toBe(1);
  });
});
