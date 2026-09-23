/**
 * @polyroot/runtime — Platform safety contracts (FT-35, FT-36, FT-45).
 *
 * The platform under the money path can fail while the money itself must
 * not:
 *
 *   FT-35 DB outage (PM-RISK-02) — reservation store unreachable: no new
 *           signing; entries halt; only an isolated, audited emergency
 *           cancel policy may run.
 *   FT-36 restore backup (PM-OPS-05) — a database behind the venue after
 *           PITR stays RECOVERING: ledger catch-up plus epoch sync plus
 *           venue reconciliation must ALL complete before any permit is
 *           issued. PostgreSQL merely starting is not recovery.
 *   FT-45 supply-chain drift (PM-SEC-06) — every pinned production
 *           dependency must match its locked digest; any drift blocks the
 *           path with the offending package named.
 *
 * Pure functions (no I/O): the supervisor/operator persists and enforces
 * what these contracts decide.
 */

export interface DegradedMode {
  signing: "BLOCKED";
  entries: "BLOCKED";
  emergencyCancel: "ISOLATED_AUDITED";
  reason: string;
}

export type PlatformState =
  | { ok: true; mode: "NORMAL" }
  | { ok: false; code: "DB_UNREACHABLE"; mode: DegradedMode };

/**
 * FT-35: with the reservation store unreachable there is exactly one
 * legal posture — everything financial halts except isolated, audited
 * emergency cancels.
 */
export function degradedMode(dbReachable: boolean): PlatformState {
  if (dbReachable) return { ok: true, mode: "NORMAL" };
  return {
    ok: false,
    code: "DB_UNREACHABLE",
    mode: {
      signing: "BLOCKED",
      entries: "BLOCKED",
      emergencyCancel: "ISOLATED_AUDITED",
      reason:
        "reservation store unreachable: no new signing; emergency cancel runs isolated and audited",
    },
  };
}

/* ─── FT-36: recovery gate ─────────────────────────────────────────── */

export type RecoveryVerdict =
  | { ok: true; ready: true; note: string }
  | { ok: false; code: "STILL_RECOVERING"; reason: string; missing: string[] };

/**
 * FT-36: after PITR restore the system is RECOVERING until ledger catch-up,
 * policy/credential epoch sync, AND venue reconciliation are all complete.
 * Permit issuance stays blocked until then.
 */
export function recoveryGate(input: {
  ledgerCaughtUp: boolean;
  epochsSynced: boolean;
  venueReconciled: boolean;
}): RecoveryVerdict {
  const missing: string[] = [];
  if (!input.ledgerCaughtUp) missing.push("ledger catch-up");
  if (!input.epochsSynced) missing.push("epoch sync");
  if (!input.venueReconciled) missing.push("venue reconciliation");
  if (missing.length > 0) {
    return {
      ok: false,
      code: "STILL_RECOVERING",
      reason: `recovery incomplete: ${missing.join(", ")} pending; no permits issued`,
      missing,
    };
  }
  return { ok: true, ready: true, note: "recovery complete: permits may resume" };
}

/* ─── FT-45: supply-chain pin ──────────────────────────────────────── */

export type SupplyChainVerdict =
  | { ok: true; checked: number }
  | { ok: false; code: "SUPPLY_CHAIN_DRIFT"; reason: string; packages: string[] };

/**
 * FT-45: every pinned production dependency must match its locked digest.
 * First drift blocks the path and names every offending package.
 */
export function verifySupplyChainPin(
  locked: Readonly<Record<string, string>>,
  observed: Readonly<Record<string, string>>,
): SupplyChainVerdict {
  const drifted = Object.keys(locked).filter((name) => observed[name] !== locked[name]);
  if (drifted.length > 0) {
    return {
      ok: false,
      code: "SUPPLY_CHAIN_DRIFT",
      reason: `supply-chain drift in: ${drifted.join(", ")}`,
      packages: drifted,
    };
  }
  return { ok: true, checked: Object.keys(locked).length };
}
