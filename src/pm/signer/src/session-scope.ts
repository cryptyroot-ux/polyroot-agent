/**
 * @polyroot/signer — Session key scope contracts (CT-31, PM-WALLET-10).
 *
 * Session keys are opt-in beta: actual scopes, bounded expiry, and
 * revocation finality via explicit receipt. Custom lifetime assumptions
 * (e.g. "sessions last forever", "revocation is instant on return")
 * are REJECTED, not silently clamped — callers must pass explicit,
 * policy-checked values.
 *
 * Pure functions (no I/O).
 */

export type SessionScope = "SIGN_ORDERS" | "READ" | "CANCEL_ORDERS";

const ALLOWED_SCOPES: readonly SessionScope[] = [
  "SIGN_ORDERS",
  "READ",
  "CANCEL_ORDERS",
];

/** Maximum session lifetime enforced by policy (beta default: 1 hour). */
export const MAX_SESSION_LIFETIME_MS = 3_600_000;

export type SessionScopeResult =
  | {
      ok: true;
      scopes: SessionScope[];
      expiresAt: Date;
      note: string;
    }
  | {
      ok: false;
      code: "SCOPE_NOT_ALLOWED" | "LIFETIME_ASSUMPTION_REJECTED";
      reason: string;
    };

/**
 * Validate a session-key grant. Every requested scope must be allowlisted;
 * the lifetime must be explicit and within the beta maximum. Requests
 * that assume custom lifetimes (zero, negative, unbounded, NaN) are
 * refused outright.
 */
export function grantSessionScope(input: {
  scopes: string[];
  lifetimeMs: number;
  now?: Date;
}): SessionScopeResult {
  const now = input.now ?? new Date();
  for (const scope of input.scopes) {
    if (!(ALLOWED_SCOPES as readonly string[]).includes(scope)) {
      return {
        ok: false,
        code: "SCOPE_NOT_ALLOWED",
        reason: `session scope not allowlisted: ${scope}`,
      };
    }
  }
  if (
    !Number.isFinite(input.lifetimeMs) ||
    input.lifetimeMs <= 0 ||
    input.lifetimeMs > MAX_SESSION_LIFETIME_MS
  ) {
    return {
      ok: false,
      code: "LIFETIME_ASSUMPTION_REJECTED",
      reason: `session lifetime must be explicit within (0, ${MAX_SESSION_LIFETIME_MS}]ms`,
    };
  }
  return {
    ok: true,
    scopes: [...input.scopes] as SessionScope[],
    expiresAt: new Date(now.getTime() + input.lifetimeMs),
    note: "session grant bounded with explicit expiry",
  };
}

export type RevocationFinality =
  | { final: true; note: string }
  | { ok: false; code: "REVOCATION_NOT_FINAL"; reason: string };

/**
 * Session revocation is final ONLY on an explicit revocation receipt.
 * A bare API return without a receipt proves nothing about on-chain
 * completion — finality must be evidenced, never assumed.
 */
export function checkRevocationFinality(input: {
  receiptId: string | null;
}): RevocationFinality {
  if (!input.receiptId) {
    return {
      ok: false,
      code: "REVOCATION_NOT_FINAL",
      reason: "no revocation receipt: revocation not final",
    };
  }
  return { final: true, note: `revocation evidenced by ${input.receiptId}` };
}
