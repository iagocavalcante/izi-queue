import Database from 'better-sqlite3';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { IziQueue, createSQLiteAdapter, createPostgresAdapter, createMySQLAdapter, defineWorker } from '../../dist/index.js';

const { dialect, connection, options } = JSON.parse(process.argv[2]);
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const database = dialect === 'sqlite'
  ? createSQLiteAdapter(new Database(connection), logger)
  : dialect === 'postgres'
    ? createPostgresAdapter(new pg.Pool({ connectionString: connection, options }), logger)
    : createMySQLAdapter(mysql.createPool(connection), logger);
const queue = new IziQueue({
  database, node: 'process-worker', queues: { default: 2 },
  cluster: true, pollInterval: 20, controlInterval: 20, heartbeatInterval: 50,
  leadership: false, logger
});
queue.register(defineWorker('remote-wait', async (job, { signal }) => {
  process.send({ event: 'started', id: job.id });
  await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  process.send({ event: 'aborted', id: job.id });
}));
await queue.start();
process.send({ event: 'ready' });
