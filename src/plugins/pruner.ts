import { BasePlugin } from './plugin.js';
import { telemetry } from '../core/telemetry.js';

export interface PrunerConfig {
  interval?: number;
  maxAge?: number;
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
      maxAge: config.maxAge ?? 86400
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

    try {
      const pruned = await this.context.database.pruneJobs(this.config.maxAge);

      if (pruned > 0) {
        telemetry.emit('job:complete', {
          result: { pruned, maxAge: this.config.maxAge },
          queue: 'pruner'
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

    return errors;
  }
}

export function createPrunerPlugin(config?: PrunerConfig): PrunerPlugin {
  return new PrunerPlugin(config);
}
