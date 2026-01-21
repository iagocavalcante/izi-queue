/**
 * izi-queue Performance Benchmarks
 *
 * Run with: npx ts-node benchmarks/benchmark.ts
 * Or build first: npm run build && node dist/benchmarks/benchmark.js
 */

import Database from 'better-sqlite3';
import {
  createIziQueue,
  createSQLiteAdapter,
  defineWorker,
  WorkerResults,
  clearWorkers
} from '../src/index.js';

interface BenchmarkResult {
  name: string;
  operations: number;
  durationMs: number;
  opsPerSecond: number;
  avgLatencyMs: number;
}

async function runBenchmark(
  name: string,
  iterations: number,
  fn: () => Promise<void>
): Promise<BenchmarkResult> {
  // Warmup
  for (let i = 0; i < Math.min(10, iterations / 10); i++) {
    await fn();
  }

  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    await fn();
  }
  const duration = performance.now() - start;

  return {
    name,
    operations: iterations,
    durationMs: Math.round(duration * 100) / 100,
    opsPerSecond: Math.round((iterations / duration) * 1000 * 100) / 100,
    avgLatencyMs: Math.round((duration / iterations) * 100) / 100
  };
}

function printResult(result: BenchmarkResult) {
  console.log(`
${result.name}
${'─'.repeat(50)}
  Operations:     ${result.operations.toLocaleString()}
  Duration:       ${result.durationMs.toLocaleString()} ms
  Ops/second:     ${result.opsPerSecond.toLocaleString()}
  Avg latency:    ${result.avgLatencyMs} ms
`);
}

async function benchmarkJobInsertion() {
  console.log('\n📊 Job Insertion Benchmark\n');

  const db = new Database(':memory:');
  const adapter = createSQLiteAdapter(db);
  await adapter.migrate();

  const queue = createIziQueue({
    database: adapter,
    queues: { default: 10 }
  });

  let jobId = 0;

  const result = await runBenchmark('Single job insertion', 10000, async () => {
    await queue.insert('BenchWorker', {
      args: { id: ++jobId, data: 'benchmark-data' }
    });
  });

  printResult(result);

  await queue.shutdown();
  return result;
}

async function benchmarkBatchInsertion() {
  console.log('\n📊 Batch Insertion Benchmark\n');

  const db = new Database(':memory:');
  const adapter = createSQLiteAdapter(db);
  await adapter.migrate();

  const queue = createIziQueue({
    database: adapter,
    queues: { default: 10 }
  });

  let batchId = 0;
  const batchSize = 100;

  const result = await runBenchmark('Batch insertion (100 jobs)', 100, async () => {
    const jobs = Array.from({ length: batchSize }, (_, i) => ({
      args: { batchId: ++batchId, index: i }
    }));
    await queue.insertAll('BenchWorker', jobs);
  });

  // Adjust for actual job count
  const adjustedResult = {
    ...result,
    name: `Batch insertion (${batchSize} jobs per batch)`,
    operations: result.operations * batchSize,
    opsPerSecond: Math.round(result.opsPerSecond * batchSize * 100) / 100
  };

  printResult(adjustedResult);

  await queue.shutdown();
  return adjustedResult;
}

async function benchmarkJobProcessing() {
  console.log('\n📊 Job Processing Benchmark\n');

  const db = new Database(':memory:');
  const adapter = createSQLiteAdapter(db);
  await adapter.migrate();
  clearWorkers();

  let processed = 0;
  const targetJobs = 1000;

  const worker = defineWorker('FastWorker', async () => {
    processed++;
    return WorkerResults.ok();
  });

  const queue = createIziQueue({
    database: adapter,
    queues: { default: 50 }, // High concurrency
    pollInterval: 10
  });

  queue.register(worker);

  // Insert all jobs first
  console.log(`  Inserting ${targetJobs} jobs...`);
  const jobs = Array.from({ length: targetJobs }, (_, i) => ({
    args: { id: i }
  }));
  await queue.insertAll('FastWorker', jobs);

  // Start processing and measure
  console.log('  Processing...');
  const start = performance.now();
  await queue.start();

  // Wait for all jobs to be processed
  while (processed < targetJobs) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  const duration = performance.now() - start;

  await queue.shutdown();

  const result: BenchmarkResult = {
    name: 'Job processing (50 concurrent workers)',
    operations: processed,
    durationMs: Math.round(duration * 100) / 100,
    opsPerSecond: Math.round((processed / duration) * 1000 * 100) / 100,
    avgLatencyMs: Math.round((duration / processed) * 100) / 100
  };

  printResult(result);
  return result;
}

async function benchmarkDatabaseFetch() {
  console.log('\n📊 Database Fetch Benchmark\n');

  const db = new Database(':memory:');
  const adapter = createSQLiteAdapter(db);
  await adapter.migrate();

  // Insert jobs to fetch
  console.log('  Preparing test data...');
  for (let i = 0; i < 1000; i++) {
    await adapter.insertJob({
      state: 'available',
      queue: 'default',
      worker: 'TestWorker',
      args: { id: i },
      meta: {},
      tags: [],
      errors: [],
      attempt: 0,
      maxAttempts: 20,
      priority: Math.floor(Math.random() * 10) - 5,
      scheduledAt: new Date(),
      attemptedAt: null,
      completedAt: null,
      discardedAt: null,
      cancelledAt: null
    });
  }

  // Reset jobs to available state for each fetch test
  const resetJobs = () => {
    db.prepare("UPDATE izi_jobs SET state = 'available', attempt = 0").run();
  };

  resetJobs();

  const result = await runBenchmark('Fetch 10 jobs (with update)', 1000, async () => {
    const jobs = await adapter.fetchJobs('default', 10);
    if (jobs.length < 10) {
      resetJobs();
    }
  });

  printResult(result);

  await adapter.close();
  return result;
}

async function benchmarkUniqueCheck() {
  console.log('\n📊 Unique Constraint Check Benchmark\n');

  const db = new Database(':memory:');
  const adapter = createSQLiteAdapter(db);
  await adapter.migrate();

  const queue = createIziQueue({
    database: adapter,
    queues: { default: 10 }
  });

  let userId = 0;

  const result = await runBenchmark('Insert with unique check', 5000, async () => {
    await queue.insertWithResult('UniqueWorker', {
      args: { userId: ++userId },
      unique: { period: 3600 }
    });
  });

  printResult(result);

  await queue.shutdown();
  return result;
}

async function benchmarkConcurrentProcessing() {
  console.log('\n📊 Concurrent Processing Benchmark\n');

  const concurrencyLevels = [1, 5, 10, 25, 50];
  const jobsPerLevel = 500;

  console.log('  Testing different concurrency levels...\n');

  for (const concurrency of concurrencyLevels) {
    const db = new Database(':memory:');
    const adapter = createSQLiteAdapter(db);
    await adapter.migrate();
    clearWorkers();

    let processed = 0;

    const worker = defineWorker('ConcurrentWorker', async () => {
      // Simulate some async work
      await new Promise(resolve => setTimeout(resolve, 1));
      processed++;
      return WorkerResults.ok();
    });

    const queue = createIziQueue({
      database: adapter,
      queues: { default: concurrency },
      pollInterval: 5
    });

    queue.register(worker);

    // Insert jobs
    const jobs = Array.from({ length: jobsPerLevel }, (_, i) => ({
      args: { id: i }
    }));
    await queue.insertAll('ConcurrentWorker', jobs);

    const start = performance.now();
    await queue.start();

    while (processed < jobsPerLevel) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    const duration = performance.now() - start;
    await queue.shutdown();

    const opsPerSecond = Math.round((processed / duration) * 1000);
    console.log(`  Concurrency ${concurrency.toString().padStart(2)}: ${opsPerSecond.toLocaleString().padStart(6)} jobs/sec`);
  }
}

async function benchmarkWithPayloadSizes() {
  console.log('\n📊 Payload Size Impact Benchmark\n');

  const payloadSizes = [
    { name: 'Tiny (100 bytes)', size: 100 },
    { name: 'Small (1 KB)', size: 1024 },
    { name: 'Medium (10 KB)', size: 10240 },
    { name: 'Large (100 KB)', size: 102400 }
  ];

  for (const { name, size } of payloadSizes) {
    const db = new Database(':memory:');
    const adapter = createSQLiteAdapter(db);
    await adapter.migrate();

    const queue = createIziQueue({
      database: adapter,
      queues: { default: 10 }
    });

    const payload = 'x'.repeat(size);

    const result = await runBenchmark(`Insert ${name}`, 1000, async () => {
      await queue.insert('PayloadWorker', {
        args: { data: payload }
      });
    });

    console.log(`  ${name.padEnd(20)}: ${result.opsPerSecond.toLocaleString().padStart(8)} ops/sec`);

    await queue.shutdown();
  }
}

async function main() {
  console.log('═'.repeat(60));
  console.log('              izi-queue Performance Benchmarks');
  console.log('═'.repeat(60));
  console.log('\nRunning benchmarks... This may take a few minutes.\n');

  const results: BenchmarkResult[] = [];

  try {
    results.push(await benchmarkJobInsertion());
    results.push(await benchmarkBatchInsertion());
    results.push(await benchmarkJobProcessing());
    results.push(await benchmarkDatabaseFetch());
    results.push(await benchmarkUniqueCheck());

    await benchmarkConcurrentProcessing();
    await benchmarkWithPayloadSizes();

    console.log('\n' + '═'.repeat(60));
    console.log('                       Summary');
    console.log('═'.repeat(60));

    console.log('\n  Benchmark Results:\n');
    for (const result of results) {
      console.log(`  ${result.name}`);
      console.log(`    → ${result.opsPerSecond.toLocaleString()} ops/sec\n`);
    }

    console.log('═'.repeat(60));
    console.log('                 Benchmarks Complete!');
    console.log('═'.repeat(60) + '\n');

  } catch (error) {
    console.error('Benchmark failed:', error);
    process.exit(1);
  }
}

main();
