import type { DatabaseAdapter } from '../types.js';

export interface PluginConfig {
  name: string;
}

export interface PluginContext {
  database: DatabaseAdapter;
  node: string;
  queues: string[];
}

export interface Plugin {
  readonly name: string;
  start(context: PluginContext): Promise<void>;
  stop(): Promise<void>;
  validate?(): string[];
}

export abstract class BasePlugin implements Plugin {
  abstract readonly name: string;
  protected context?: PluginContext;
  protected timer?: ReturnType<typeof setInterval>;
  protected running = false;

  async start(context: PluginContext): Promise<void> {
    if (this.running) return;
    this.context = context;
    this.running = true;
    await this.onStart();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.onStop();
  }

  protected abstract onStart(): Promise<void>;

  protected async onStop(): Promise<void> {}

  validate(): string[] {
    return [];
  }
}
