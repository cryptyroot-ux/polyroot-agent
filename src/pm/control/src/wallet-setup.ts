/**
 * @polyroot/control — Wallet setup contracts (FT-22, FT-23).
 *
 * Setup-phase safety for the Wallet and Credential Service flow:
 *
 *   FT-22 deposit setup ambiguity — a relayer confirmation that never
 *           arrives leaves the operation UNKNOWN (never assumed confirmed);
 *           resubmitting the same operation_id returns the SAME record
 *           without a new nonce or a duplicate wallet setup.
 *   FT-23 wrong spender approval — available-to-trade counts ONLY the
 *           exact required spender's allowance. An owner-EOA approval (or
 *           any other spender) contributes ZERO; no order may be signed
 *           off a mismatched approval.
 *
 * Pure functions (no I/O): the durable relayer/allowance stores persist
 * what these contracts accept, keyed by the same identities.
 */

export type RelayerOpStatus = "SUBMITTED" | "CONFIRMED" | "UNKNOWN" | "FAILED";

export interface RelayerOperation {
  operationId: string;
  nonce: number;
  status: RelayerOpStatus;
  attempts: number;
}

export type RelayerResult =
  | { ok: true; op: RelayerOperation; duplicate: boolean }
  | { ok: false; code: "INVALID_NONCE"; reason: string };

/**
 * Submit (or resubmit) a relayer operation. Idempotent on operation_id:
 * a retry after a timeout returns the SAME operation with an incremented
 * attempt counter — never a fresh nonce, never a duplicate setup.
 */
export function submitRelayerOp(
  existing: RelayerOperation | null,
  operationId: string,
  nonce: number,
): RelayerResult {
  if (existing) {
    if (existing.nonce !== nonce) {
      return {
        ok: false,
        code: "INVALID_NONCE",
        reason: `operation ${operationId} already exists with nonce ${existing.nonce}, got ${nonce}`,
      };
    }
    return {
      ok: true,
      op: { ...existing, attempts: existing.attempts + 1 },
      duplicate: true,
    };
  }
  return {
    ok: true,
    op: { operationId, nonce, status: "SUBMITTED", attempts: 1 },
    duplicate: false,
  };
}

export type ConfirmationOutcome = "CONFIRMED" | "STILL_UNKNOWN";

/**
 * A confirmation timeout moves SUBMITTED → UNKNOWN and STAYS there until
 * positive receipt evidence arrives. UNKNOWN is never promoted by waiting
 * longer, and no new setup action is derived from it.
 */
export function noteConfirmationTimeout(op: RelayerOperation): {
  op: RelayerOperation;
  outcome: ConfirmationOutcome;
} {
  if (op.status !== "SUBMITTED") {
    return {
      op,
      outcome: op.status === "CONFIRMED" ? "CONFIRMED" : "STILL_UNKNOWN",
    };
  }
  return {
    op: { ...op, status: "UNKNOWN" },
    outcome: "STILL_UNKNOWN",
  };
}

/* ─── FT-23: exact-spender availability ────────────────────────────── */

export interface SpenderAllowance {
  spender: string;
  allowance: number;
}

export type SpenderCheckResult =
  | { ok: true; availableToTrade: number }
  | {
      ok: false;
      code: "SPENDER_NOT_APPROVED";
      reason: string;
      availableToTrade: 0;
    };

/**
 * Available-to-trade counts ONLY the required spender's allowance.
 * Approvals held by any other identity (owner EOA included) contribute
 * exactly zero — a mismatched approval must never authorize a signature.
 */
export function availableToTrade(
  allowances: SpenderAllowance[],
  requiredSpender: string,
  balance: number,
): SpenderCheckResult {
  const grant = allowances.find((a) => a.spender === requiredSpender);
  const approved = grant && grant.allowance > 0 ? grant.allowance : 0;
  if (approved <= 0) {
    return {
      ok: false,
      code: "SPENDER_NOT_APPROVED",
      reason: `required spender ${requiredSpender} has no positive allowance`,
      availableToTrade: 0,
    };
  }
  return { ok: true, availableToTrade: Math.min(balance, approved) };
}
