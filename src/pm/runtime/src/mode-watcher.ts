/**
 * @polyroot/runtime — Dynamic Mode Watcher & Hot-Reload Engine.
 *
 * Polls `live_guard_state` in PostgreSQL to update the runtime mode dynamically
 * without process restart. Enforces fail-closed degradation (READ_ONLY) when
 * database connectivity is lost for > maxFailures.
 */

export type RuntimeMode =
  "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE" | "READ_ONLY";

export interface QueryablePool {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface ModeWatcherOptions {
  pool: QueryablePool;
  pollIntervalMs?: number | undefined;
  maxFailuresBeforeDegrade?: number | undefined;
  initialMode?: RuntimeMode | undefined;
  onModeChange?:
    ((from: RuntimeMode, to: RuntimeMode, reason: string) => void) | undefined;
  onDegrade?: ((reason: string) => void) | undefined;
}

export type ModeChangeResult =
  { ok: true; mode: RuntimeMode } | { ok: false; code: string; reason: string };

const LATCH_KEY = "micro-live";

export class ModeWatcher {
  private currentMode: RuntimeMode;
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private degraded = false;
  private preDegradedMode: RuntimeMode | null = null;

  private readonly pool: QueryablePool;
  private readonly pollIntervalMs: number;
  private readonly maxFailuresBeforeDegrade: number;
  private readonly onModeChange?:
    ((from: RuntimeMode, to: RuntimeMode, reason: string) => void) | undefined;
  private readonly onDegrade?: ((reason: string) => void) | undefined;

  constructor(opts: ModeWatcherOptions) {
    this.pool = opts.pool;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.maxFailuresBeforeDegrade = opts.maxFailuresBeforeDegrade ?? 3;
    this.currentMode = opts.initialMode ?? "PAPER";
    if (opts.onModeChange !== undefined) {
      this.onModeChange = opts.onModeChange;
    }
    if (opts.onDegrade !== undefined) {
      this.onDegrade = opts.onDegrade;
    }
  }

  getMode(): RuntimeMode {
    return this.currentMode;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  async pollOnce(): Promise<void> {
    try {
      const res = await this.pool.query(
        `SELECT runtime_mode, halted FROM live_guard_state WHERE key = $1`,
        [LATCH_KEY],
      );
      const row = res.rows[0];
      this.consecutiveFailures = 0;

      // Recover from degraded state if DB is back
      if (this.degraded) {
        this.degraded = false;
        const restoredMode =
          (row?.["runtime_mode"] as RuntimeMode) ??
          this.preDegradedMode ??
          "PAPER";
        const oldMode = this.currentMode;
        this.currentMode = restoredMode;
        this.preDegradedMode = null;
        if (this.onModeChange && oldMode !== restoredMode) {
          this.onModeChange(
            oldMode,
            restoredMode,
            "database connection restored",
          );
        }
        return;
      }

      if (row && typeof row["runtime_mode"] === "string") {
        const dbMode = row["runtime_mode"] as RuntimeMode;
        if (dbMode !== this.currentMode) {
          const oldMode = this.currentMode;
          this.currentMode = dbMode;
          if (this.onModeChange) {
            this.onModeChange(
              oldMode,
              dbMode,
              "mode updated via database live_guard_state",
            );
          }
        }
      }
    } catch (err) {
      this.consecutiveFailures++;
      if (
        !this.degraded &&
        this.consecutiveFailures >= this.maxFailuresBeforeDegrade
      ) {
        this.degraded = true;
        this.preDegradedMode = this.currentMode;
        const oldMode = this.currentMode;
        this.currentMode = "READ_ONLY";
        const reason = `database polling failed ${this.consecutiveFailures} times: ${(err as Error).message}`;
        if (this.onDegrade) this.onDegrade(reason);
        if (this.onModeChange) {
          this.onModeChange(oldMode, "READ_ONLY", reason);
        }
      }
    }
  }

  async requestModeChange(
    newMode: RuntimeMode,
    _operator: string,
  ): Promise<ModeChangeResult> {
    if (newMode === "LIVE" || newMode === "MICRO_LIVE") {
      const res = await this.pool.query(
        `SELECT halted FROM live_guard_state WHERE key = $1`,
        [LATCH_KEY],
      );
      const row = res.rows[0];
      if (row && row["halted"] === true) {
        return {
          ok: false,
          code: "LOSS_LATCH_ENGAGED",
          reason: "cannot upgrade to LIVE while loss latch is engaged",
        };
      }
    }

    try {
      await this.pool.query(
        `UPDATE live_guard_state 
         SET runtime_mode = $1, mode_updated_at = now() 
         WHERE key = $2`,
        [newMode, LATCH_KEY],
      );
      await this.pollOnce();
      return { ok: true, mode: this.currentMode };
    } catch (err) {
      return {
        ok: false,
        code: "DB_UPDATE_FAILED",
        reason: `failed to update mode in database: ${(err as Error).message}`,
      };
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.pollOnce().catch(() => {});
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
