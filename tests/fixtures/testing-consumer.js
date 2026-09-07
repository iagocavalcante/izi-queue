import assert from 'node:assert/strict';
import { defineWorker } from 'izi-queue';
import { buildJob, performJob, allEnqueued, assertEnqueued, refuteEnqueued } from 'izi-queue/testing';

const worker = defineWorker('double', async job => ({ status: 'ok', value: job.args.n * 2 }));
assert.equal(buildJob(worker, { n: 3 }).worker, 'double');
assert.deepEqual(await performJob(worker, { n: 3 }), { status: 'ok', value: 6 });
const source = { listJobs: async () => [] };
assert.deepEqual(await allEnqueued(source), []);
await refuteEnqueued(source);
await assert.rejects(assertEnqueued(source, { worker: 'double' }), { code: 'ERR_ASSERTION' });
