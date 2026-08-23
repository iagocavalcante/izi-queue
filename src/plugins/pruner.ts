import { BasePlugin } from './plugin.js';
import { telemetry } from '../core/telemetry.js';
import { DEFAULT_BATCH_SIZE, runInBatches } from '../database/adapter.js';

export interface PrunerConfig {
  interval?: number;
  maxAge?: number;
  /**
   * Maximum rows deleted per statement, per prune cycle. A large backlog is
   * worked in this many rows at a time rather than one unbounded DELETE,
   * looping (yielding to the event loop between batches) until it is caught
   * up. Defaults to `DEFAULT_BATCH_SIZE` (5000).
   */
  batchSize?: number;
}

/**
 * Removes old completed/discarded/cancelled jobs
 */
export class PrunerPlugin extends BasePlugin {
  readonly name = 'pruner';
  private config: Required<PrunerConfig>;

  constructor(config: PrunerConfig = {}) {
    super();
    this.config = {
      interval: config.interval ?? 60000,
      maxAge: config.maxAge ?? 86400,
      batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE
    };
  }

  protected async onStart(): Promise<void> {
    if (!this.context) return;

    telemetry.emit('plugin:start', { queue: this.name });

    this.timer = setInterval(() => this.prune(), this.config.interval);
  }

  protected async onStop(): Promise<void> {
    telemetry.emit('plugin:stop', { queue: this.name });
  }

  private async prune(): Promise<void> {
    if (!this.context || !this.running) return;

    // N nodes each running a large DELETE over the same range is the exact
    // contention leader election exists to remove.
    if (!this.isLeader()) return;

    try {
      const database = this.context.database;
      const pruned = await runInBatches(
        limit => database.pruneJobs(this.config.maxAge, limit),
        this.config.batchSize
      );

      if (pruned > 0) {
        // Deliberately not `job:complete`: pruning is maintenance, and counting
        // deleted rows as completed jobs corrupts any metric built on that event.
        telemetry.emit('jobs:pruned', {
          result: { pruned, maxAge: this.config.maxAge },
          queue: this.name
        });
      }
    } catch (error) {
      telemetry.emit('plugin:error', {
        queue: this.name,
        error: error instanceof Error ? error : new Error(String(error))
      });
    }
  }

  validate(): string[] {
    const errors: string[] = [];

    if (this.config.interval < 1000) {
      errors.push('Pruner interval must be at least 1000ms');
    }

    if (this.config.maxAge < 60) {
      errors.push('Pruner maxAge must be at least 60 seconds');
    }

    if (this.config.batchSize < 1) {
      errors.push('Pruner batchSize must be at least 1');
    }

    return errors;
  }
}

export function createPrunerPlugin(config?: PrunerConfig): PrunerPlugin {
  return new PrunerPlugin(config);
}
