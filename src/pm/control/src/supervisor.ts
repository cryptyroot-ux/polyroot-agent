import type { RiskPolicy } from "@polyroot/domain";
import type { OrchestrateResult } from "./orchestrator.js";
import type { Reconciler } from "./reconciler.js";
import type { Persistence } from "./persistence.js";

/** Supervisor health report metrics. */
export interface HealthReport {
  timestamp: Date;
  unknownOrderCount: number;
  totalOrderCount: number;
  unresolvedIntents: number;
}

/** Supervisor handles governance, auditing, and triggering of reconciliation. */
export class Supervisor {
  protected readonly counters: Map<string, number> = new Map();

  constructor(
    protected readonly deps: {
      reconciler: Reconciler;
      persistence: Persistence;
      policy: RiskPolicy;
      now: () => Date;
    },
  ) {}

  /** Handle outcome of an orchestration step – updates local persistence. */
  async onOrchestrateResult(res: OrchestrateResult): Promise<void> {
    if (!res.ok) return;
    await this.deps.persistence.set(res.order.order_id, res.state);
    // Increment order counter
    const current = this.counters.get(res.order.order_id) ?? 0;
    this.counters.set(res.order.order_id, current + 1);
  }

  /** Run the reconciliation loop to resolve drift. */
  async runReconciliation(): Promise<void> {
    await this.deps.reconciler.reconcileAll();
  }

  /**
   * Start a periodic reconciliation scheduler (point #3 of the autonomy loop).
   * Runs `runReconciliation()` every `intervalMs`, guarded against overlapping
   * executions. Returns a stop function. Policy-driven interval defaults to
   * `reconcile_interval_s * 1000` when present.
   */
  startPeriodicReconciliation(intervalMs?: number): () => void {
    const interval =
      intervalMs ?? (this.deps.policy.reconcile_interval_s ?? 15) * 1000;
    let running = false;
    let stopped = false;

    const timer = setInterval(async () => {
      if (running || stopped) return;
      running = true;
      try {
        await this.runReconciliation();
      } catch (err) {
        // Surface the error but never let the loop die silently.
        const msg =
          err instanceof Error ? err.message : String(err);
        this.deps.persistence.set(`supervisor:error:${Date.now()}`, "DEFINITIVE_REJECT");
        console.error(`[supervisor] periodic reconciliation failed: ${msg}`);
      } finally {
        running = false;
      }
    }, interval);

    // Do not hold the process open.
    timer.unref();

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  /** Periodic health check summary. */
  async getHealthReport(): Promise<HealthReport> {
    const unknownIds = await this.deps.persistence.listUnknown();
    return {
      timestamp: this.deps.now(),
      unknownOrderCount: unknownIds.length,
      totalOrderCount: Array.from(this.counters.values()).reduce((a, b) => a + b, 0),
      unresolvedIntents: unknownIds.length, // Same as unknown orders for now
    };
  }
}
