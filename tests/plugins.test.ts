import Database from 'better-sqlite3';
import {
  createLifelinePlugin,
  createPrunerPlugin,
  createSQLiteAdapter,
  clearWorkers
} from '../src/index.js';
import { telemetry } from '../src/core/telemetry.js';
import type { PluginContext } from '../src/plugins/plugin.js';

describe('Plugins', () => {
  let db: Database.Database;
  let adapter: ReturnType<typeof createSQLiteAdapter>;
  let pluginContext: PluginContext;

  beforeEach(async () => {
    db = new Database(':memory:');
    adapter = createSQLiteAdapter(db);
    await adapter.migrate();
    clearWorkers();

    pluginContext = {
      database: adapter,
      node: 'test-node',
      queues: ['default']
    };
  });

  afterEach(async () => {
    await adapter.close();
  });

  describe('LifelinePlugin', () => {
    describe('constructor', () => {
      it('should create with default config', () => {
        const plugin = createLifelinePlugin();
        expect(plugin.name).toBe('lifeline');
      });

      it('should create with custom config', () => {
        const plugin = createLifelinePlugin({
          interval: 30000,
          rescueAfter: 120
        });
        expect(plugin.name).toBe('lifeline');
      });
    });

    describe('validate', () => {
      it('should pass validation with valid config', () => {
        const plugin = createLifelinePlugin({
          interval: 5000,
          rescueAfter: 60
        });

        const errors = plugin.validate();
        expect(errors).toHaveLength(0);
      });

      it('should fail validation if interval is too low', () => {
        const plugin = createLifelinePlugin({
          interval: 500, // Less than 1000ms
          rescueAfter: 60
        });

        const errors = plugin.validate();
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]).toContain('interval');
      });

      it('should fail validation if rescueAfter is too low', () => {
        const plugin = createLifelinePlugin({
          interval: 5000,
          rescueAfter: 5 // Less than 10 seconds
        });

        const errors = plugin.validate();
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]).toContain('rescueAfter');
      });

      it('should fail validation for multiple issues', () => {
        const plugin = createLifelinePlugin({
          interval: 100,
          rescueAfter: 1
        });

        const errors = plugin.validate();
        expect(errors.length).toBe(2);
      });
    });

    describe('start / stop lifecycle', () => {
      it('should start and stop without errors', async () => {
        const plugin = createLifelinePlugin({
          interval: 60000,
          rescueAfter: 300
        });

        await plugin.start(pluginContext);
        await plugin.stop();
      });

      it('should emit plugin:start event', async () => {
        const events: string[] = [];
        const unsubscribe = telemetry.on('plugin:start', () => {
          events.push('plugin:start');
        });

        const plugin = createLifelinePlugin({
          interval: 60000,
          rescueAfter: 300
        });

        await plugin.start(pluginContext);

        expect(events).toContain('plugin:start');

        unsubscribe();
        await plugin.stop();
      });

      it('should emit plugin:stop event', async () => {
        const events: string[] = [];
        const unsubscribe = telemetry.on('plugin:stop', () => {
          events.push('plugin:stop');
        });

        const plugin = createLifelinePlugin({
          interval: 60000,
          rescueAfter: 300
        });

        await plugin.start(pluginContext);
        await plugin.stop();

        expect(events).toContain('plugin:stop');

        unsubscribe();
      });
    });

    describe('rescue functionality', () => {
      it('should rescue stuck jobs on start', async () => {
        // Insert a stuck job
        db.prepare(`
          INSERT INTO izi_jobs (state, queue, worker, args, attempted_at)
          VALUES ('executing', 'default', 'StuckWorker', '{}', datetime('now', '-10 minutes'))
        `).run();

        const plugin = createLifelinePlugin({
          interval: 60000,
          rescueAfter: 300 // 5 minutes
        });

        await plugin.start(pluginContext);

        // Check job was rescued
        const job = db.prepare('SELECT state FROM izi_jobs WHERE worker = ?').get('StuckWorker') as any;
        expect(job.state).toBe('available');

        await plugin.stop();
      });

      it('should emit job:rescue event when rescuing jobs', async () => {
        const events: any[] = [];
        const unsubscribe = telemetry.on('job:rescue', (payload) => {
          events.push(payload);
        });

        // Insert a stuck job
        db.prepare(`
          INSERT INTO izi_jobs (state, queue, worker, args, attempted_at)
          VALUES ('executing', 'default', 'StuckWorker', '{}', datetime('now', '-10 minutes'))
        `).run();

        const plugin = createLifelinePlugin({
          interval: 60000,
          rescueAfter: 300
        });

        await plugin.start(pluginContext);

        expect(events.length).toBeGreaterThan(0);
        expect(events[0].result.count).toBe(1);

        unsubscribe();
        await plugin.stop();
      });

      it('should rescue jobs periodically', async () => {
        const plugin = createLifelinePlugin({
          interval: 100, // Very short for testing (but will fail validation in prod)
          rescueAfter: 10
        });

        // Bypass validation for testing
        (plugin as any).config = { interval: 100, rescueAfter: 0 };

        await plugin.start(pluginContext);

        // Insert stuck jobs after start
        db.prepare(`
          INSERT INTO izi_jobs (state, queue, worker, args, attempted_at)
          VALUES ('executing', 'default', 'StuckWorker', '{}', datetime('now', '-1 hour'))
        `).run();

        // Wait for periodic rescue
        await new Promise(resolve => setTimeout(resolve, 200));

        const job = db.prepare('SELECT state FROM izi_jobs WHERE worker = ?').get('StuckWorker') as any;
        expect(job.state).toBe('available');

        await plugin.stop();
      });
    });

    describe('error handling', () => {
      it('should emit plugin:error on database errors', async () => {
        const events: any[] = [];
        const unsubscribe = telemetry.on('plugin:error', (payload) => {
          events.push(payload);
        });

        const plugin = createLifelinePlugin({
          interval: 100,
          rescueAfter: 10
        });

        // Start with valid context
        await plugin.start(pluginContext);

        // Close database to cause errors
        await adapter.close();

        // Wait for periodic rescue attempt
        await new Promise(resolve => setTimeout(resolve, 200));

        // Should have emitted error
        expect(events.length).toBeGreaterThan(0);

        unsubscribe();
        await plugin.stop();

        // Reopen for cleanup
        db = new Database(':memory:');
        adapter = createSQLiteAdapter(db);
      });
    });
  });

  describe('PrunerPlugin', () => {
    describe('constructor', () => {
      it('should create with default config', () => {
        const plugin = createPrunerPlugin();
        expect(plugin.name).toBe('pruner');
      });

      it('should create with custom config', () => {
        const plugin = createPrunerPlugin({
          interval: 30000,
          maxAge: 3600
        });
        expect(plugin.name).toBe('pruner');
      });
    });

    describe('validate', () => {
      it('should pass validation with valid config', () => {
        const plugin = createPrunerPlugin({
          interval: 5000,
          maxAge: 3600
        });

        const errors = plugin.validate();
        expect(errors).toHaveLength(0);
      });

      it('should fail validation if interval is too low', () => {
        const plugin = createPrunerPlugin({
          interval: 500, // Less than 1000ms
          maxAge: 3600
        });

        const errors = plugin.validate();
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]).toContain('interval');
      });

      it('should fail validation if maxAge is too low', () => {
        const plugin = createPrunerPlugin({
          interval: 5000,
          maxAge: 30 // Less than 60 seconds
        });

        const errors = plugin.validate();
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]).toContain('maxAge');
      });

      it('should fail validation for multiple issues', () => {
        const plugin = createPrunerPlugin({
          interval: 100,
          maxAge: 10
        });

        const errors = plugin.validate();
        expect(errors.length).toBe(2);
      });
    });

    describe('start / stop lifecycle', () => {
      it('should start and stop without errors', async () => {
        const plugin = createPrunerPlugin({
          interval: 60000,
          maxAge: 3600
        });

        await plugin.start(pluginContext);
        await plugin.stop();
      });

      it('should emit plugin:start event', async () => {
        const events: string[] = [];
        const unsubscribe = telemetry.on('plugin:start', () => {
          events.push('plugin:start');
        });

        const plugin = createPrunerPlugin({
          interval: 60000,
          maxAge: 3600
        });

        await plugin.start(pluginContext);

        expect(events).toContain('plugin:start');

        unsubscribe();
        await plugin.stop();
      });

      it('should emit plugin:stop event', async () => {
        const events: string[] = [];
        const unsubscribe = telemetry.on('plugin:stop', () => {
          events.push('plugin:stop');
        });

        const plugin = createPrunerPlugin({
          interval: 60000,
          maxAge: 3600
        });

        await plugin.start(pluginContext);
        await plugin.stop();

        expect(events).toContain('plugin:stop');

        unsubscribe();
      });
    });

    describe('prune functionality', () => {
      it('should prune old jobs periodically', async () => {
        // Insert old completed job
        db.prepare(`
          INSERT INTO izi_jobs (state, queue, worker, args, completed_at)
          VALUES ('completed', 'default', 'OldWorker', '{}', datetime('now', '-10 days'))
        `).run();

        const plugin = createPrunerPlugin({
          interval: 100,
          maxAge: 86400 // 1 day
        });

        // Bypass validation for testing
        (plugin as any).config = { interval: 100, maxAge: 86400 };

        await plugin.start(pluginContext);

        // Wait for periodic prune
        await new Promise(resolve => setTimeout(resolve, 200));

        const jobs = db.prepare('SELECT * FROM izi_jobs WHERE worker = ?').all('OldWorker');
        expect(jobs).toHaveLength(0);

        await plugin.stop();
      });

      it('should emit job:complete event when pruning jobs', async () => {
        const events: any[] = [];
        const unsubscribe = telemetry.on('job:complete', (payload) => {
          if (payload.queue === 'pruner') {
            events.push(payload);
          }
        });

        // Insert old completed job
        db.prepare(`
          INSERT INTO izi_jobs (state, queue, worker, args, completed_at)
          VALUES ('completed', 'default', 'OldWorker', '{}', datetime('now', '-10 days'))
        `).run();

        const plugin = createPrunerPlugin({
          interval: 100,
          maxAge: 86400
        });

        (plugin as any).config = { interval: 100, maxAge: 86400 };

        await plugin.start(pluginContext);
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(events.length).toBeGreaterThan(0);
        expect(events[0].result.pruned).toBe(1);

        unsubscribe();
        await plugin.stop();
      });
    });

    describe('error handling', () => {
      it('should emit plugin:error on database errors', async () => {
        const events: any[] = [];
        const unsubscribe = telemetry.on('plugin:error', (payload) => {
          events.push(payload);
        });

        const plugin = createPrunerPlugin({
          interval: 100,
          maxAge: 60
        });

        // Start with valid context
        await plugin.start(pluginContext);

        // Close database to cause errors
        await adapter.close();

        // Wait for periodic prune attempt
        await new Promise(resolve => setTimeout(resolve, 200));

        // Should have emitted error
        expect(events.length).toBeGreaterThan(0);

        unsubscribe();
        await plugin.stop();

        // Reopen for cleanup
        db = new Database(':memory:');
        adapter = createSQLiteAdapter(db);
      });
    });
  });

  describe('Plugin Integration', () => {
    it('should work together without conflicts', async () => {
      // Insert stuck job and old completed job
      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, attempted_at)
        VALUES ('executing', 'default', 'StuckWorker', '{}', datetime('now', '-10 minutes'))
      `).run();

      db.prepare(`
        INSERT INTO izi_jobs (state, queue, worker, args, completed_at)
        VALUES ('completed', 'default', 'OldWorker', '{}', datetime('now', '-10 days'))
      `).run();

      const lifeline = createLifelinePlugin({
        interval: 100,
        rescueAfter: 10
      });
      (lifeline as any).config = { interval: 100, rescueAfter: 0 };

      const pruner = createPrunerPlugin({
        interval: 100,
        maxAge: 86400
      });
      (pruner as any).config = { interval: 100, maxAge: 86400 };

      await lifeline.start(pluginContext);
      await pruner.start(pluginContext);

      await new Promise(resolve => setTimeout(resolve, 300));

      // Stuck job should be rescued
      const stuckJob = db.prepare('SELECT state FROM izi_jobs WHERE worker = ?').get('StuckWorker') as any;
      expect(stuckJob.state).toBe('available');

      // Old job should be pruned
      const oldJobs = db.prepare('SELECT * FROM izi_jobs WHERE worker = ?').all('OldWorker');
      expect(oldJobs).toHaveLength(0);

      await lifeline.stop();
      await pruner.stop();
    });
  });
});
