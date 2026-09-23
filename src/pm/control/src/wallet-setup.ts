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

/* ─── CT-07: deposit wallet create/discover (PM-WALLET-04, G0/G1 half) ── */

export type WalletPresence = "EXISTING" | "ABSENT";

export interface WalletDiscovery {
  presence: WalletPresence;
  /** Canonical wallet address when EXISTING, else null. */
  address: string | null;
  note: string;
}

/**
 * CT-07 discovery: an on-chain lookup result maps to EXISTING (with its
 * canonical address) or ABSENT. ABSENT never fabricates an address —
 * creation is a separate, owner-authorized step.
 */
export function discoverWallet(reportedAddress: string | null): WalletDiscovery {
  if (reportedAddress && reportedAddress.length > 0) {
    return {
      presence: "EXISTING",
      address: reportedAddress,
      note: "wallet exists at reported address",
    };
  }
  return { presence: "ABSENT", address: null, note: "no wallet deployed" };
}

export type CreateReconciliation =
  | { ok: true; created: boolean; address: string; note: string }
  | { ok: false; code: "CREATE_CONFLICT"; reason: string };

/**
 * CT-07 WALLET-CREATE idempotent reconciliation: creating when ABSENT
 * yields the new address; creating when an EXISTING wallet is already
 * recorded returns it unchanged (no duplicate deployment). A create that
 * names a DIFFERENT address than the recorded one conflicts — the caller
 * must reconcile explicitly, never by deploying a second wallet.
 */
export function reconcileWalletCreate(
  discovery: WalletDiscovery,
  requestedAddress: string,
): CreateReconciliation {
  if (discovery.presence === "ABSENT") {
    if (!requestedAddress) {
      return {
        ok: false,
        code: "CREATE_CONFLICT",
        reason: "absent wallet requires an explicit address to create",
      };
    }
    return {
      ok: true,
      created: true,
      address: requestedAddress,
      note: "wallet created at requested address",
    };
  }
  if (discovery.address !== requestedAddress) {
    return {
      ok: false,
      code: "CREATE_CONFLICT",
      reason: `recorded wallet ${discovery.address} differs from requested ${requestedAddress}`,
    };
  }
  return {
    ok: true,
    created: false,
    address: discovery.address as string,
    note: "already exists; reconciled without redeploy",
  };
}

/* ─── CT-08: approval caller/spender (PM-WALLET-05, G0 half) ─────────── */

export type ApprovalTokenStandard = "ERC20" | "ERC1155";

export type ApprovalCallResult =
  | { ok: true; note: string }
  | { ok: false; code: "WRONG_CALLER" | "WRONG_SPENDER"; reason: string };

/**
 * CT-08: an approval call (ERC20 collateral or ERC1155 operator) must
 * originate from the correct account wallet AND name the intended
 * spender. A caller mismatch and a spender mismatch are distinct,
 * typed refusals.
 */
export function checkApprovalCall(input: {
  caller: string;
  accountWallet: string;
  spender: string;
  intendedSpender: string;
  tokenStandard: ApprovalTokenStandard;
}): ApprovalCallResult {
  if (input.caller !== input.accountWallet) {
    return {
      ok: false,
      code: "WRONG_CALLER",
      reason: `${input.tokenStandard} approval must originate from account wallet ${input.accountWallet}`,
    };
  }
  if (input.spender !== input.intendedSpender) {
    return {
      ok: false,
      code: "WRONG_SPENDER",
      reason: `approval names ${input.spender}, mandate requires ${input.intendedSpender}`,
    };
  }
  return { ok: true, note: `${input.tokenStandard} approval call valid` };
}

/* ─── CT-10: relayer nonce conflicts (PM-WALLET-04, G0/G1 half) ─────── */

export type NonceVerdict =
  | { ok: true; note: string }
  | { ok: false; code: "NONCE_REPLAY" | "NONCE_GAP"; reason: string };

/**
 * CT-10: relayer nonces must advance by exactly one. A repeated nonce is
 * a replay (idempotent resubmit path handles retries instead); a jumped
 * nonce means a lost operation — never silently skipped.
 */
export function checkRelayerNonce(
  lastSeenNonce: number | null,
  incomingNonce: number,
): NonceVerdict {
  if (!Number.isInteger(incomingNonce) || incomingNonce < 0) {
    return {
      ok: false,
      code: "NONCE_REPLAY",
      reason: "incoming nonce must be a non-negative integer",
    };
  }
  if (lastSeenNonce === null) {
    return { ok: true, note: "first nonce accepted" };
  }
  if (incomingNonce <= lastSeenNonce) {
    return {
      ok: false,
      code: "NONCE_REPLAY",
      reason: `nonce ${incomingNonce} already seen (last ${lastSeenNonce})`,
    };
  }
  if (incomingNonce > lastSeenNonce + 1) {
    return {
      ok: false,
      code: "NONCE_GAP",
      reason: `nonce jump ${lastSeenNonce} -> ${incomingNonce}: missing operation, never skip`,
    };
  }
  return { ok: true, note: "nonce advances by exactly one" };
}
