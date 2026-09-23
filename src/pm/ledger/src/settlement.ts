/**
 * @polyroot/ledger — Settlement finality contracts (FT-33, FT-34, FT-43).
 *
 * Trade settlement is tracked SEPARATELY from order status:
 *
 *   OPEN → MATCHED (provisional, NOT spendable) → CONFIRMED | FAILED
 *
 *   FT-33 settlement failure — a MATCHED fill that later FAILED (or reorgs)
 *           must post a compensating journal entry; provisional inventory
 *           is never spendable in any state but CONFIRMED.
 *   FT-34 double redeem — a receipt/stream delivered twice posts exactly
 *           one economic effect per unique transaction/log identity.
 *   FT-43 reward estimate reversal — EXPECTED/ACCRUED_ESTIMATE and
 *           CONFIRMED_PAID are separate ledgers; revising an estimate only
 *           corrects the estimate. No cash reservation is ever funded by
 *           an estimate.
 *
 * Pure functions (no I/O): the durable stores persist what these contracts
 * accept, keyed by the same idempotency identities.
 */

export type SettlementStatus =
  | "OPEN"
  | "MATCHED"
  | "MINED"
  | "RETRYING"
  | "CONFIRMED"
  | "FAILED";

export interface SettlementState {
  status: SettlementStatus;
  /** Journal entries posted (provisional + compensating), in order. */
  journal: string[];
  /** Whether holdings from this settlement may be spent. */
  spendable: boolean;
}

export type SettlementCode =
  | "SETTLEMENT_INVALID_TRANSITION"
  | "DUPLICATE_SUPPRESSED";

export type SettlementResult =
  | { ok: true; state: SettlementState; note: string }
  | { ok: false; code: SettlementCode; reason: string };

const VALID_TRANSITIONS: Record<SettlementStatus, SettlementStatus[]> = {
  OPEN: ["MATCHED"],
  MATCHED: ["MINED", "CONFIRMED", "FAILED"],
  MINED: ["CONFIRMED", "FAILED", "RETRYING"],
  RETRYING: ["MINED", "CONFIRMED", "FAILED"],
  CONFIRMED: [],
  FAILED: [],
};

export function applySettlementEvent(
  state: SettlementState,
  event: { kind: "MATCH" | "MINE" | "RETRY" | "CONFIRM" | "FAIL"; entry: string },
): SettlementResult {
  const target: SettlementStatus =
    event.kind === "MATCH"
      ? "MATCHED"
      : event.kind === "MINE"
        ? "MINED"
        : event.kind === "RETRY"
          ? "RETRYING"
          : event.kind === "CONFIRM"
            ? "CONFIRMED"
            : "FAILED";
  if (!VALID_TRANSITIONS[state.status].includes(target)) {
    return {
      ok: false,
      code: "SETTLEMENT_INVALID_TRANSITION",
      reason: `${state.status} -> ${target} is not a legal settlement transition`,
    };
  }
  // FT-33: a FAILED settlement posts a compensating entry that reverses the
  // provisional MATCH — the journal always nets to zero, never to a loss
  // that silently vanishes.
  const journal =
    target === "FAILED"
      ? [...state.journal, event.entry, `COMPENSATE:${event.entry}`]
      : [...state.journal, event.entry];
  return {
    ok: true,
    state: {
      status: target,
      journal,
      // Provisional inventory is spendable ONLY once CONFIRMED.
      spendable: target === "CONFIRMED",
    },
    note: target === "FAILED" ? "compensating entry posted" : `${target} recorded`,
  };
}

/**
 * CT-26 reorg/correction: a chain reorganization (or venue correction)
 * that invalidates a CONFIRMED settlement posts an explicit correction
 * pair and returns the settlement to FAILED. Reorgs are the ONLY path
 * out of CONFIRMED — there is no silent rewrite of a confirmed posting.
 */
export function applyReorgCorrection(
  state: SettlementState,
  entry: string,
): SettlementResult {
  if (state.status !== "CONFIRMED") {
    return {
      ok: false,
      code: "SETTLEMENT_INVALID_TRANSITION",
      reason: `reorg correction applies only to CONFIRMED, not ${state.status}`,
    };
  }
  return {
    ok: true,
    state: {
      status: "FAILED",
      journal: [...state.journal, entry, `REORG_CORRECT:${entry}`],
      spendable: false,
    },
    note: "reorg correction posted; settlement no longer spendable",
  };
}

export function initialSettlement(): SettlementState {
  return { status: "OPEN", journal: [], spendable: false };
}

/* ─── FT-34: idempotent receipt application ────────────────────────── */

export interface ReceiptLedger {
  /** Transaction/log identities already posted. */
  postedIds: Set<string>;
  /** Count of economic postings performed (must equal unique ids). */
  postingCount: number;
}

export type ReceiptResult =
  | { ok: true; posted: boolean; note: string }
  | { ok: false; code: "DUPLICATE_SUPPRESSED"; reason: string };

/**
 * Apply a settlement receipt exactly once per unique transaction/log
 * identity. A duplicate delivery is suppressed — it is NOT a second
 * economic posting and must never throw (at-least-once streams).
 */
export function applyReceiptOnce(
  ledger: ReceiptLedger,
  receiptId: string,
): ReceiptResult {
  if (ledger.postedIds.has(receiptId)) {
    return {
      ok: false,
      code: "DUPLICATE_SUPPRESSED",
      reason: `receipt ${receiptId} already posted; suppressed`,
    };
  }
  ledger.postedIds.add(receiptId);
  ledger.postingCount += 1;
  return { ok: true, posted: true, note: `posted ${receiptId}` };
}

/* ─── FT-43: estimate vs confirmed ledgers ─────────────────────────── */

export interface RewardBooks {
  /** Expected/accrued estimates (information only — never spendable). */
  estimateTotal: number;
  /** Confirmed paid rewards (the only spendable source). */
  confirmedTotal: number;
  /** Cash reservations funded — must ALWAYS remain estimate-free. */
  cashReserved: number;
}

export function reviseRewardEstimate(
  books: RewardBooks,
  revisedEstimate: number,
): RewardBooks {
  if (!Number.isFinite(revisedEstimate) || revisedEstimate < 0) {
    throw new Error("estimate must be a finite non-negative number");
  }
  // Only the estimate is corrected. Confirmed totals and cash reservations
  // are untouched: a pool change or a payout below expectation can never
  // retroactively fund (or unfund) a reservation.
  return { ...books, estimateTotal: revisedEstimate };
}
