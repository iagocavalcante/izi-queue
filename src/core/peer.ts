import type { DatabaseAdapter, LeaderInfo, LeadershipConfig, Logger } from '../types.js';
import {
  DEFAULT_LEADER_NAME,
  DEFAULT_LEADERSHIP_INTERVAL,
  DEFAULT_LEADERSHIP_TTL
} from '../database/adapter.js';
import { telemetry } from './telemetry.js';

/**
 * Holds -- or competes for -- a single leadership lease, so that exactly one
 * node in a cluster stages jobs and runs the maintenance plugins (#26).
 *
 * The lease lives in `izi_peers` as one row per scope name, carrying the
 * holder and an expiry. Every node runs the same statement on the same
 * interval: renew the row if we already hold it, take it over if it has
 * lapsed, and otherwise leave it alone. The database arbitrates, exactly as it
 * does for job state transitions -- the race is between nodes, so it cannot be
 * settled in JavaScript.
 *
 * Leadership is *advisory*, not a fence: a leader whose process stalls past
 * the TTL can still believe it leads while a successor is elected. Everything
 * gated on it is therefore idempotent (staging, pruning, rescuing) or
 * separately deduplicated (cron inserts), so the worst case of a brief overlap
 * is the duplicated work that existed unconditionally before this landed.
 */
export class Peer {
  private readonly database: DatabaseAdapter;
  private readonly node: string;
  private readonly logger: Logger;
  private readonly enabled: boolean;
  private readonly name: string;
  private readonly interval: number;
  private readonly ttl: number;

  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private electing = false;
  private leader = false;

  constructor(
    database: DatabaseAdapter,
    node: string,
    config: boolean | LeadershipConfig | undefined,
    logger: Logger
  ) {
    this.database = database;
    this.node = node;
    this.logger = logger;

    const options: LeadershipConfig = typeof config === 'object' ? config : {};
    this.name = options.name ?? DEFAULT_LEADER_NAME;
    this.interval = options.interval ?? DEFAULT_LEADERSHIP_INTERVAL;
    this.ttl = options.ttl ?? DEFAULT_LEADERSHIP_TTL;

    // An adapter without `acquireLeadership` cannot elect anyone. Rather than
    // leaving such a cluster leaderless -- which would stop staging entirely --
    // every node acts as leader, which is exactly the pre-#26 behavior.
    this.enabled = config !== false && typeof database.acquireLeadership === 'function';

    if (this.enabled) {
      this.validate();
    } else {
      this.leader = true;
    }
  }

  private validate(): void {
    if (this.interval < 1000) {
      throw new Error(
        `izi-queue: leadership.interval must be at least 1000ms, got ${this.interval}`
      );
    }

    // Renewing at least twice per lease means a single slow or failed renewal
    // cannot hand leadership to another node while this one is still healthy.
    if (this.ttl * 1000 < this.interval * 2) {
      throw new Error(
        `izi-queue: leadership.ttl (${this.ttl}s) must be at least twice leadership.interval ` +
          `(${this.interval}ms), otherwise the lease expires faster than it is renewed`
      );
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get scope(): string {
    return this.name;
  }

  isLeader(): boolean {
    return this.leader;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (!this.enabled) return;

    // Elected before returning, so a queue that starts and immediately stages
    // does not have to wait out a full interval to find out whether it may.
    await this.elect();

    this.timer = setInterval(() => {
      void this.elect();
    }, this.interval);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (!this.enabled) return;

    // Handing the lease back on a clean shutdown lets a successor take over
    // now instead of waiting out the TTL with nothing staging jobs.
    if (this.leader) {
      try {
        await this.database.releaseLeadership?.(this.name, this.node);
      } catch (error) {
        this.logger.error('Error releasing leadership', { error, node: this.node });
      }
      this.demote();
    }
  }

  /** The unexpired lease holder, or null. Always a fresh read. */
  async getLeader(): Promise<LeaderInfo | null> {
    if (!this.enabled || !this.database.getLeader) return null;
    return this.database.getLeader(this.name);
  }

  /**
   * One election round: acquire or renew, and reconcile local state with the
   * answer. Overlapping rounds are skipped rather than queued -- if a round is
   * still in flight when the next tick fires, the database is slow enough that
   * piling on another statement would only make it worse.
   */
  private async elect(): Promise<void> {
    if (!this.running || this.electing) return;

    const acquire = this.database.acquireLeadership;
    if (!acquire) return;

    this.electing = true;

    try {
      const acquired = await acquire.call(this.database, this.name, this.node, this.ttl);

      // A round that lands after stop() must not resurrect leadership.
      if (!this.running) return;

      if (acquired) {
        this.promote();
      } else {
        this.demote();
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Error acquiring leadership', { error: err, node: this.node });
      telemetry.emit('peer:error', { node: this.node, error: err });

      // Fail closed. A lease we cannot prove we hold is one another node may
      // already have taken, so standing down is the only safe reading -- and
      // the work being gated is maintenance, which the next healthy leader
      // picks up.
      this.demote();
    } finally {
      this.electing = false;
    }
  }

  private promote(): void {
    if (this.leader) return;
    this.leader = true;
    this.logger.info('Node elected leader', { node: this.node, leadership: this.name });
    telemetry.emit('peer:elected', { node: this.node, result: { name: this.name } });
  }

  private demote(): void {
    if (!this.leader) return;
    this.leader = false;
    this.logger.info('Node lost leadership', { node: this.node, leadership: this.name });
    telemetry.emit('peer:lost', { node: this.node, result: { name: this.name } });
  }
}
