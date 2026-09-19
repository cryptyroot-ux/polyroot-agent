/**
 * Simple in‑memory persistence for order lifecycle state.
 * In production this will be replaced by a Postgres table.
 */
import type { OrderLifecycleState } from "@polyroot/executor";
import type { RiskDecision } from "@polyroot/domain";

export interface Persistence {
  /** Get stored state for an order, or undefined if not present. */
  get(orderId: string): Promise<OrderLifecycleState | undefined>;
  /** Set stored state for an order. */
  set(orderId: string, state: OrderLifecycleState): Promise<void>;
  /** List order ids whose state is SUBMISSION_UNKNOWN (needs reconciliation). */
  listUnknown(): Promise<string[]>;
  /** Persist a risk decision atomically. */
  saveRiskDecision(decision: RiskDecision): Promise<void>;
}

/** In‑memory implementation used for tests and early phases. */
export class InMemoryPersistence implements Persistence {
  private readonly store = new Map<string, OrderLifecycleState>();
  private readonly riskDecisions = new Map<string, RiskDecision>();

  async get(orderId: string): Promise<OrderLifecycleState | undefined> {
    return this.store.get(orderId);
  }

  async set(orderId: string, state: OrderLifecycleState): Promise<void> {
    this.store.set(orderId, state);
  }

  async listUnknown(): Promise<string[]> {
    const out: string[] = [];
    for (const [id, st] of this.store.entries()) {
      if (st === "SUBMISSION_UNKNOWN") out.push(id);
    }
    return out;
  }

  async saveRiskDecision(decision: RiskDecision): Promise<void> {
    this.riskDecisions.set(decision.decision_id, decision);
  }
}
