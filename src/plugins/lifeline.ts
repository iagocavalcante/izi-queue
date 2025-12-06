import { BasePlugin } from './plugin.js';
import { telemetry } from '../core/telemetry.js';

export interface LifelineConfig {
  interval?: number;
  rescueAfter?: number;
}

/**
 * Rescues jobs stuck in executing state (e.g., after a crash)
 */
export class LifelinePlugin extends BasePlugin {
  readonly name = 'lifeline';
  private config: Required<LifelineConfig>;

  constructor(config: LifelineConfig = {}) {
    super();
    this.config = {
      interval: config.interval ?? 60000,
      rescueAfter: config.rescueAfter ?? 300
    };
  }

  protected async onStart(): Promise<void> {
    if (!this.context) return;

    telemetry.emit('plugin:start', { queue: this.name });

    await this.rescue();

    this.timer = setInterval(() => this.rescue(), this.config.interval);
  }

  protected async onStop(): Promise<void> {
    telemetry.emit('plugin:stop', { queue: this.name });
  }

  private async rescue(): Promise<void> {
    if (!this.context || !this.running) return;

    try {
      const rescued = await this.context.database.rescueStuckJobs(this.config.rescueAfter);

      if (rescued > 0) {
        telemetry.emit('job:rescue', {
          result: { count: rescued, rescueAfter: this.config.rescueAfter }
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
      errors.push('Lifeline interval must be at least 1000ms');
    }

    if (this.config.rescueAfter < 10) {
      errors.push('Lifeline rescueAfter must be at least 10 seconds');
    }

    return errors;
  }
}

export function createLifelinePlugin(config?: LifelineConfig): LifelinePlugin {
  return new LifelinePlugin(config);
}
