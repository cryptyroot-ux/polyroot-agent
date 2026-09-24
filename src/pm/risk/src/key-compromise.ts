/**
 * @polyroot/risk — Key compromise response planner (PM-SEC-08).
 *
 * On a security event the agent does not improvise: it classifies the
 * compromised asset type and emits a deterministic escalation plan:
 *
 *   kill signing -> freeze entries -> reconcile -> cancel what can still be
 *   cancelled -> rotate / revoke the affected key class -> asset rescue is
 *   OWNER-ONLY (the agent proposes, the owner executes, audits logged).
 */

export type CompromiseClass =
  "L1_SIGNER" | "L2_API" | "RELAYER" | "OWNER_SESSION" | "UNKNOWN";

export interface CompromiseIntent {
  class: CompromiseClass;
  /** Freeze future entries for this wallet/scope. */
  freezeEntries: boolean;
  /**
   * Cancel is attempted IF still possible: an already-exfiltrated live key
   * must not be handed more authority, but pending orders can still be
   * withdrawn by the venue while the account is authenticated.
   */
  cancelPossible: boolean;
  observedAt: Date;
}

export type ResponseAction =
  | { action: "KILL_SIGNING" }
  | { action: "FREEZE_ENTRIES" }
  | { action: "RECONCILE" }
  | { action: "CANCEL_OPEN" }
  | { action: "REVOKE_L2" }
  | { action: "REVOKE_OWNER_SESSION" }
  | { action: "ROTATE_L1" }
  | { action: "OWNER_ASSET_RESCUE" };

export interface KeyCompromisePlan {
  order: ResponseAction[];
  tasks: string[];
  ownerOnly: string[];
  notes: string[];
}

function appendOrder(
  plan: KeyCompromisePlan,
  action: ResponseAction,
  task: string,
) {
  plan.order.push(action);
  plan.tasks.push(task);
}

/**
 * PM-SEC-08: emit the corrective sequence for a key class. `assumeBreached`
 * gates the defensive posture — call with the affected scope's class.
 */
export function planCompromiseResponse(
  intent: CompromiseIntent,
): KeyCompromisePlan {
  const plan: KeyCompromisePlan = {
    order: [],
    tasks: [],
    ownerOnly: [],
    notes: [],
  };

  // 1. Stop signing immediately (vault is the only signer authority).
  appendOrder(plan, { action: "KILL_SIGNING" }, "halt vault signing for scope");

  // 2. Freeze entries so no new risk is assumed under a suspect identity.
  if (intent.freezeEntries) {
    appendOrder(
      plan,
      { action: "FREEZE_ENTRIES" },
      "enter PAUSE_ENTRIES kill level",
    );
  }

  // 3. Reconcile ledger vs venue (what is actually open / matched?).
  appendOrder(
    plan,
    { action: "RECONCILE" },
    "reconcile orders/trades/positions",
  );

  // 4. Cancel what can still be cancelled, only if still possible.
  if (intent.cancelPossible) {
    appendOrder(
      plan,
      { action: "CANCEL_OPEN" },
      "request cancel via kill switch CANCEL_OPEN",
    );
  }

  // 5. Key-class specific revocation / rotation.
  switch (intent.class) {
    case "L1_SIGNER":
      appendOrder(
        plan,
        { action: "ROTATE_L1" },
        "rotate signer; quarantine old key",
      );
      plan.notes.push(
        "L1 rotation is owner-approved and audited (mandate-service binding).",
      );
      break;
    case "L2_API":
    case "RELAYER":
      appendOrder(
        plan,
        { action: "REVOKE_L2" },
        "revoke L2/relayer credentials at provider",
      );
      plan.notes.push("rotate L2 credentials before any LIVE re-enable.");
      break;
    case "OWNER_SESSION":
      appendOrder(
        plan,
        { action: "REVOKE_OWNER_SESSION" },
        "revoke owner sessions + re-auth",
      );
      plan.notes.push(
        "owner re-authentication required; sessions are short-lived.",
      );
      break;
    case "UNKNOWN":
      plan.notes.push(
        "unknown class: treat as full exposure; owner review required before any unlock.",
      );
      break;
  }

  // 6. Asset rescue is always owner-only.
  plan.ownerOnly.push(
    "Asset rescue (withdraw/move funds) is executed ONLY by the owner workflow, never by the agent.",
  );
  appendOrder(
    plan,
    { action: "OWNER_ASSET_RESCUE" },
    "owner initiates rescue per runbook",
  );

  plan.notes.push(
    "Every step is audit-logged with actor+action+resource (audit_log).",
  );
  return plan;
}

/* ─── CT-30: revocation receipt tracking (PM-SEC-08) ─────────────────── */

export type RevocationDomain = "api" | "session" | "approval";
export type RevocationState = "PENDING" | "REVOKED" | "FAILED";

export interface RevocationTracker {
  domains: Record<RevocationDomain, RevocationState>;
  /** Open orders that must remain visible until venue-confirmed closed. */
  openOrders: string[];
}

export function initRevocationTracker(
  openOrders: string[] = [],
): RevocationTracker {
  return {
    domains: { api: "PENDING", session: "PENDING", approval: "PENDING" },
    openOrders: [...openOrders],
  };
}

export type RevocationMarkResult =
  | { ok: true; tracker: RevocationTracker }
  | { ok: false; code: "UNKNOWN_DOMAIN"; reason: string };

/**
 * CT-30: record a revocation receipt per domain. Revoking the API key does
 * NOT auto-revoke sessions or approvals — each domain completes on its own
 * receipt. A FAILED receipt stays failed (retry explicitly); open orders
 * remain listed regardless of revocation progress.
 */
export function markRevoked(
  tracker: RevocationTracker,
  domain: string,
  revoked: boolean,
): RevocationMarkResult {
  if (domain !== "api" && domain !== "session" && domain !== "approval") {
    return {
      ok: false,
      code: "UNKNOWN_DOMAIN",
      reason: `unknown revocation domain: ${domain}`,
    };
  }
  return {
    ok: true,
    tracker: {
      domains: { ...tracker.domains, [domain]: revoked ? "REVOKED" : "FAILED" },
      openOrders: [...tracker.openOrders],
    },
  };
}

/** Fully revoked only when API, session AND approval are all REVOKED. */
export function isFullyRevoked(tracker: RevocationTracker): boolean {
  return (
    tracker.domains.api === "REVOKED" &&
    tracker.domains.session === "REVOKED" &&
    tracker.domains.approval === "REVOKED"
  );
}
