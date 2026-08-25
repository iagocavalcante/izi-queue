import type { DatabaseAdapter } from '../types.js';

export interface PluginConfig {
  name: string;
}

export interface PluginContext {
  database: DatabaseAdapter;
  node: string;
  queues: string[];
  /** Seconds without a heartbeat after which a node is presumed dead. */
  nodeTtl?: number;
  /**
   * Whether the owning node currently holds the leadership lease. Maintenance
   * work belongs behind this: with N nodes, an ungated plugin does its work N
   * times over, against the same rows (#26).
   *
   * Always true when leadership is disabled or the adapter does not support
   * it, so gating on it never leaves the work undone.
   *
   * Optional purely so a hand-built context (a test, a bespoke harness) still
   * type-checks; `IziQueue` always supplies it, and `BasePlugin.isLeader()`
   * treats an absent one as leader.
   */
  isLeader?: () => boolean;
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

  /**
   * Whether this node may do cluster-wide maintenance work right now. Gate
   * every periodic tick that writes rows other nodes also see on it; leave
   * node-local work ungated.
   */
  protected isLeader(): boolean {
    return this.context?.isLeader?.() ?? true;
  }

  validate(): string[] {
    return [];
  }
}
