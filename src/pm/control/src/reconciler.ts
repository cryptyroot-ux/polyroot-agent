import type { Executor, OrderLifecycleState } from "@polyroot/executor";
import type { Persistence } from "./persistence.js";

/** Reconciler – resolves orders left in SUBMISSION_UNKNOWN state. */
export class Reconciler {
  constructor(private readonly executor: Executor, private readonly persistence: Persistence) {}

  /** Reconcile all unknown orders. */
  async reconcileAll(): Promise<void> {
    const unknownIds = this.persistence.listUnknown();
    for (const id of unknownIds) {
      const newState = await this.executor.reconcile(id);
      this.persistence.set(id, newState as OrderLifecycleState);
    }
  }
}
