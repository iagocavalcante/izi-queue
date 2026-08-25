import Database from 'better-sqlite3';
import {
  createCronPlugin,
  createIziQueue,
  createSQLiteAdapter,
  clearWorkers,
  defineWorker
} from '../src/index.js';
import type { IziQueue } from '../src/core/izi-queue.js';
import type { PluginContext } from '../src/plugins/plugin.js';
import { rowToJob } from '../src/database/adapter.js';
import type { Job, Logger } from '../src/types.js';
import { waitFor } from './helpers/wait.js';

/** Invokes the plugin's private evaluation, which is otherwise timer-driven. */
function tick(plugin: unknown): Promise<void> {
  return (plugin as { tick(): Promise<void> }).tick();
}

/** 2026-08-24 is a Monday. */
const MONDAY_09_00 = Date.UTC(2026, 7, 24, 9, 0, 0);

describe('CronPlugin', () => {
  let db: Database.Database;
  let adapter: ReturnType<typeof createSQLiteAdapter>;
  let queue: IziQueue;
  let logger: Logger;

  function contextFor(overrides: Partial<PluginContext> = {}): PluginContext {
    return {
      database: adapter,
      node: 'node-a',
      queues: ['default'],
      isLeader: () => true,
      insert: (worker, options) => queue.insertWithResult(worker, options),
      logger,
      ...overrides
    };
  }

  function at(instant: number): void {
    jest.setSystemTime(instant);
  }

  function cronJobs(): Job[] {
    return (db.prepare('SELECT * FROM izi_jobs ORDER BY id').all() as Record<string, unknown>[]).map(
      rowToJob
    );
  }

  beforeEach(async () => {
    db = new Database(':memory:');
    adapter = createSQLiteAdapter(db);
    await adapter.migrate();
    clearWorkers();

    logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    queue = createIziQueue({ database: adapter, queues: { default: 1 }, logger });

    // Fake timers rather than a stubbed `Date.now`: the plugin's cursor,
    // catch-up window and dedup key are all derived from the wall clock, and
    // stubbing the global out from under jest's own timing hangs the run.
    jest.useFakeTimers({ now: MONDAY_09_00 });
  });

  afterEach(async () => {
    jest.useRealTimers();
    await adapter.close();
  });

  describe('validation', () => {
    it('accepts a well-formed crontab', () => {
      const plugin = createCronPlugin({
        crontab: [
          { expression: '@daily', worker: 'DigestWorker' },
          { expression: '*/5 * * * *', worker: 'PollWorker', timezone: 'America/Sao_Paulo' }
        ]
      });

      expect(plugin.validate()).toEqual([]);
    });

    it('reports a malformed expression with its crontab position', () => {
      const errors = createCronPlugin({
        crontab: [
          { expression: '@daily', worker: 'Good' },
          { expression: '99 * * * *', worker: 'Bad' }
        ]
      }).validate();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/crontab\[1\]/);
      expect(errors[0]).toMatch(/minute 99 is outside/);
    });

    it('reports an unknown timezone', () => {
      const errors = createCronPlugin({
        crontab: [{ expression: '@daily', worker: 'W', timezone: 'Mars/Olympus_Mons' }]
      }).validate();

      expect(errors[0]).toMatch(/unknown timezone/);
    });

    it('reports an entry with no worker', () => {
      const errors = createCronPlugin({
        crontab: [{ expression: '@daily', worker: '' }]
      }).validate();

      expect(errors[0]).toMatch(/has no worker/);
    });

    it.each([
      [{ interval: 500 }, /at least 1000ms/],
      [{ interval: 120000 }, /at most 60000ms/],
      [{ maxCatchUpMinutes: -1 }, /between 0 and 60/],
      [{ maxCatchUpMinutes: 61 }, /between 0 and 60/],
      [{ maxCatchUpMinutes: 1.5 }, /between 0 and 60/]
    ])('rejects %p', (config, message) => {
      const errors = createCronPlugin({
        crontab: [{ expression: '@daily', worker: 'W' }],
        ...config
      }).validate();

      expect(errors.join(' ')).toMatch(message);
    });

    it('stops IziQueue from starting with an invalid crontab', () => {
      expect(() =>
        createIziQueue({
          database: adapter,
          queues: { default: 1 },
          plugins: [createCronPlugin({ crontab: [{ expression: 'nope', worker: 'W' }] })]
        })
      ).toThrow(/Plugin "cron" validation failed/);
    });

    it('needs a context that can insert jobs', async () => {
      const plugin = createCronPlugin({ crontab: [{ expression: '* * * * *', worker: 'W' }] });

      await expect(plugin.start(contextFor({ insert: undefined }))).rejects.toThrow(
        /needs a plugin context that can insert jobs/
      );
    });
  });

  describe('inserting scheduled runs', () => {
    it('inserts when the minute matches', async () => {
      const plugin = createCronPlugin({
        crontab: [{ expression: '0 9 * * 1', worker: 'MondayWorker' }]
      });

      await plugin.start(contextFor());

      const jobs = cronJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].worker).toBe('MondayWorker');

      await plugin.stop();
    });

    it('does not insert when the minute does not match', async () => {
      const plugin = createCronPlugin({
        crontab: [{ expression: '0 10 * * 1', worker: 'TenAmWorker' }]
      });

      await plugin.start(contextFor());

      expect(cronJobs()).toHaveLength(0);
      await plugin.stop();
    });

    it('evaluates each entry in its own timezone', async () => {
      // 09:00 UTC is 06:00 in São Paulo.
      const plugin = createCronPlugin({
        crontab: [
          { expression: '0 9 * * *', worker: 'UtcWorker' },
          { expression: '0 6 * * *', worker: 'BrasiliaWorker', timezone: 'America/Sao_Paulo' },
          { expression: '0 9 * * *', worker: 'BrasiliaNineWorker', timezone: 'America/Sao_Paulo' }
        ]
      });

      await plugin.start(contextFor());

      expect(cronJobs().map(job => job.worker).sort()).toEqual(['BrasiliaWorker', 'UtcWorker']);
      await plugin.stop();
    });

    it('carries the entry through to the job', async () => {
      const plugin = createCronPlugin({
        crontab: [
          {
            expression: '* * * * *',
            worker: 'ReportWorker',
            args: { scope: 'all' },
            queue: 'reports',
            priority: 3,
            maxAttempts: 2,
            tags: ['cron', 'reports']
          }
        ]
      });

      await plugin.start(contextFor());

      const [job] = cronJobs();
      expect(job.args).toEqual({ scope: 'all' });
      expect(job.queue).toBe('reports');
      expect(job.priority).toBe(3);
      expect(job.maxAttempts).toBe(2);
      expect(job.tags).toEqual(['cron', 'reports']);
      expect(job.meta).toEqual({
        cron: true,
        cronExpression: '* * * * *',
        cronMinute: '2026-08-24T09:00Z'
      });

      await plugin.stop();
    });

    it('accepts a worker definition as well as a name', async () => {
      const worker = defineWorker('DefinedWorker', async () => undefined);
      const plugin = createCronPlugin({ crontab: [{ expression: '* * * * *', worker }] });

      await plugin.start(contextFor());

      expect(cronJobs()[0].worker).toBe('DefinedWorker');
      await plugin.stop();
    });

    it('warns about an entry whose worker was never registered', async () => {
      const plugin = createCronPlugin({ crontab: [{ expression: '* * * * *', worker: 'Ghost' }] });

      await plugin.start(contextFor());

      expect(logger.warn).toHaveBeenCalledWith(
        'Cron entry references an unregistered worker',
        { worker: 'Ghost' }
      );

      await plugin.stop();
    });
  });

  describe('deduplication', () => {
    it('collapses two nodes evaluating the same minute into one job', async () => {
      const entry = { expression: '* * * * *', worker: 'HeartbeatWorker' };

      const a = createCronPlugin({ crontab: [entry] });
      const b = createCronPlugin({ crontab: [entry] });

      await a.start(contextFor({ node: 'node-a' }));
      await b.start(contextFor({ node: 'node-b' }));

      expect(cronJobs()).toHaveLength(1);

      await a.stop();
      await b.stop();
    });

    it('still inserts once the minute rolls over', async () => {
      const plugin = createCronPlugin({ crontab: [{ expression: '* * * * *', worker: 'W' }] });
      await plugin.start(contextFor());

      at(MONDAY_09_00 + 60_000);
      await tick(plugin);

      expect(cronJobs()).toHaveLength(2);
      expect(cronJobs().map(job => job.meta.cronMinute)).toEqual([
        '2026-08-24T09:00Z',
        '2026-08-24T09:01Z'
      ]);

      await plugin.stop();
    });

    it('does not insert twice when it ticks more than once inside a minute', async () => {
      const plugin = createCronPlugin({
        crontab: [{ expression: '* * * * *', worker: 'W' }],
        interval: 1000
      });
      await plugin.start(contextFor());

      at(MONDAY_09_00 + 30_000);
      await tick(plugin);
      at(MONDAY_09_00 + 59_000);
      await tick(plugin);

      expect(cronJobs()).toHaveLength(1);
      await plugin.stop();
    });

    it('deduplicates against a run that has already finished', async () => {
      // The whole reason the guard spans every state: a cron job that
      // completes in milliseconds must not be reinserted by the next node to
      // evaluate the same minute.
      const plugin = createCronPlugin({ crontab: [{ expression: '* * * * *', worker: 'W' }] });
      await plugin.start(contextFor());

      db.prepare(`UPDATE izi_jobs SET state = 'completed', completed_at = datetime('now')`).run();

      const other = createCronPlugin({ crontab: [{ expression: '* * * * *', worker: 'W' }] });
      await other.start(contextFor({ node: 'node-b' }));

      expect(cronJobs()).toHaveLength(1);

      await plugin.stop();
      await other.stop();
    });

    it('keeps entries with different expressions apart in the same minute', async () => {
      const plugin = createCronPlugin({
        crontab: [
          { expression: '* * * * *', worker: 'W' },
          { expression: '0 9 * * 1', worker: 'W' }
        ]
      });

      await plugin.start(contextFor());

      expect(cronJobs()).toHaveLength(2);
      await plugin.stop();
    });
  });

  describe('catching up on missed minutes', () => {
    it('evaluates minutes a delayed tick skipped over', async () => {
      const plugin = createCronPlugin({ crontab: [{ expression: '* * * * *', worker: 'W' }] });
      await plugin.start(contextFor());

      at(MONDAY_09_00 + 3 * 60_000);
      await tick(plugin);

      expect(cronJobs().map(job => job.meta.cronMinute)).toEqual([
        '2026-08-24T09:00Z',
        '2026-08-24T09:01Z',
        '2026-08-24T09:02Z',
        '2026-08-24T09:03Z'
      ]);

      await plugin.stop();
    });

    it('bounds how far back a single evaluation reaches', async () => {
      const plugin = createCronPlugin({
        crontab: [{ expression: '* * * * *', worker: 'W' }],
        maxCatchUpMinutes: 2
      });
      await plugin.start(contextFor());

      at(MONDAY_09_00 + 10 * 60_000);
      await tick(plugin);

      expect(cronJobs().map(job => job.meta.cronMinute)).toEqual([
        '2026-08-24T09:00Z',
        '2026-08-24T09:08Z',
        '2026-08-24T09:09Z',
        '2026-08-24T09:10Z'
      ]);

      await plugin.stop();
    });

    it('evaluates only the current minute when catch-up is disabled', async () => {
      const plugin = createCronPlugin({
        crontab: [{ expression: '* * * * *', worker: 'W' }],
        maxCatchUpMinutes: 0
      });
      await plugin.start(contextFor());

      at(MONDAY_09_00 + 5 * 60_000);
      await tick(plugin);

      expect(cronJobs().map(job => job.meta.cronMinute)).toEqual([
        '2026-08-24T09:00Z',
        '2026-08-24T09:05Z'
      ]);

      await plugin.stop();
    });

    it('does nothing when the clock steps backwards', async () => {
      const plugin = createCronPlugin({ crontab: [{ expression: '* * * * *', worker: 'W' }] });
      await plugin.start(contextFor());

      at(MONDAY_09_00 - 5 * 60_000);
      await tick(plugin);

      expect(cronJobs()).toHaveLength(1);
      await plugin.stop();
    });
  });

  describe('leadership', () => {
    it('does not evaluate on a follower', async () => {
      const plugin = createCronPlugin({ crontab: [{ expression: '* * * * *', worker: 'W' }] });
      await plugin.start(contextFor({ isLeader: () => false }));

      expect(cronJobs()).toHaveLength(0);
      await plugin.stop();
    });

    it('starts from the minute it was elected in, not from everything it missed', async () => {
      let leading = false;
      const plugin = createCronPlugin({ crontab: [{ expression: '* * * * *', worker: 'W' }] });
      await plugin.start(contextFor({ isLeader: () => leading }));

      // Ten minutes pass with another node leading, then this one takes over.
      at(MONDAY_09_00 + 10 * 60_000);
      leading = true;
      await tick(plugin);

      expect(cronJobs().map(job => job.meta.cronMinute)).toEqual(['2026-08-24T09:10Z']);
      await plugin.stop();
    });
  });

  describe('failure handling', () => {
    it('reports an insert failure as plugin:error and keeps running', async () => {
      const plugin = createCronPlugin({ crontab: [{ expression: '* * * * *', worker: 'W' }] });

      let broken = true;
      await plugin.start(
        contextFor({
          insert: async (worker, options) => {
            if (broken) throw new Error('database is down');
            return queue.insertWithResult(worker, options);
          }
        })
      );

      expect(cronJobs()).toHaveLength(0);

      broken = false;
      at(MONDAY_09_00 + 60_000);
      await tick(plugin);

      expect(cronJobs()).toHaveLength(1);
      await plugin.stop();
    });
  });

  describe('end to end', () => {
    it('runs a scheduled job through a real queue', async () => {
      jest.useRealTimers();

      const performed: number[] = [];
      const running = createIziQueue({
        database: adapter,
        queues: { default: 1 },
        pollInterval: 20,
        stageInterval: 20,
        plugins: [
          createCronPlugin({
            crontab: [{ expression: '* * * * *', worker: 'MinuteWorker' }],
            interval: 1000
          })
        ]
      });

      running.register(
        defineWorker('MinuteWorker', async job => {
          performed.push(job.id);
        })
      );

      await running.start();

      await waitFor(() => performed.length > 0, { describe: 'the cron job to run' });

      const [job] = cronJobs();
      expect(job.meta.cron).toBe(true);

      await running.stop();
    });
  });
});
