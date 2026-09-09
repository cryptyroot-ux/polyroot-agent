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
  private readonly counters: Map<string, number> = new Map();

  constructor(
    private readonly deps: {
      reconciler: Reconciler;
      persistence: Persistence;
      policy: RiskPolicy;
      now: () => Date;
    },
  ) {}

  /** Handle outcome of an orchestration step – updates local persistence. */
  onOrchestrateResult(res: OrchestrateResult): void {
    if (!res.ok) return;
    this.deps.persistence.set(res.order.order_id, res.state);
    // Increment order counter
    const current = this.counters.get(res.order.order_id) ?? 0;
    this.counters.set(res.order.order_id, current + 1);
  }

  /** Run the reconciliation loop to resolve drift. */
  async runReconciliation(): Promise<void> {
    await this.deps.reconciler.reconcileAll();
  }

  /** Periodic health check summary. */
  getHealthReport(): HealthReport {
    const unknownIds = this.deps.persistence.listUnknown();
    return {
      timestamp: this.deps.now(),
      unknownOrderCount: unknownIds.length,
      totalOrderCount: Array.from(this.counters.values()).reduce((a, b) => a + b, 0),
      unresolvedIntents: unknownIds.length, // Same as unknown orders for now
    };
  }
}
