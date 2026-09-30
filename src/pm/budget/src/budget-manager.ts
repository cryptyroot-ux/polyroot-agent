/**
 * @polyroot/budget — Budget Conservation (P0-3).
 * Enforces accounting invariants and domain‑aware budgeting.
 */

import type { ReservationManager } from "../risk/src/reservation-manager.js";
import type { EffectiveAuthorityResolver } from "../auth/src/effective-authority-resolver.js";
import type {
  BudgetReservation,
  BudgetConstraint,
  BudgetAccountResult,
} from "./types.js";

export class BudgetManager {
  private reservationManager: ReservationManager;
  private authResolver: EffectiveAuthorityResolver;

  constructor(deps: {
    reservationManager: ReservationManager;
    authResolver: EffectiveAuthorityResolver;
  }) {
    this.reservationManager = deps.reservationManager;
    this.authResolver = deps.authResolver;
  }

  /** Validate a reservation request against effective authority and accounting invariants. */
  async validateReservation(
    account: string,
    domain: string,
    requestedNotional: bigint,
    reservationId?: string,
  ): Promise<BudgetAccountResult> {
    // 1. Effective authority check
    const authContext = await this.buildAuthContext(account);
    const authResult = this.authResolver.resolve(
      authContext,
      domain,
      requestedNotional,
    );
    if (!authResult.ok) {
      return {
        ok: false,
        code: authResult.code,
        reason: authResult.reason,
        effectiveBudget: authResult.effectiveMaxNotional,
        effectiveCapacity: 0n,
      };
    }

    // 2. Accounting invariants (P0-3) – ensure no double spend / over‑consumption.
    if (reservationId) {
      const status = await this.reservationManager.get(reservationId);
      if (!status) {
        return {
          ok: false,
          code: "RES_NOT_FOUND",
          reason: "reservation not found",
        }; // placeholder
      }
      // Check if the reservation already fully consumed or released.
      if (
        status.consumed_amount >= status.amount ||
        status.released_amount >= status.amount
      ) {
        return {
          ok: false,
          code: "RES_EXHAUSTED",
          reason: "reservation already fully consumed or released",
        };
      }
      // Ensure requested notional does not exceed remaining capacity.
      const remaining =
        status.amount - status.consumed_amount - status.released_amount;
      if (requestedNotional > remaining) {
        return {
          ok: false,
          code: "OVER_CONSUME",
          reason: `requested ${requestedNotional} > remaining ${remaining}`,
        };
      }
    }

    return {
      ok: true,
      effectiveBudget: authResult.effectiveMaxNotional,
      effectiveCapacity: authResult.effectiveMaxNotional,
    };
  }

  /**
   * Build a minimal auth context from the account.
   * In a real implementation this would fetch the actual authority lineage from a ledger.
   */
  private async buildAuthContext(account: string): Promise<any> {
    // Placeholder: use a static lineage for demo; actual implementation reads from ledger.
    return {
      identity: account,
      lineage: [
        {
          id: "root",
          allowedDomains: ["trading", "staking", "governance"],
          maxNotionalBase: 100_000_000_000n,
          policyVersion: "v1",
        },
        {
          id: account,
          parentId: "root",
          allowedDomains: ["trading"],
          maxNotionalBase: 50_000_000_000n,
          policyVersion: "v1",
        },
      ],
    };
  }
}
