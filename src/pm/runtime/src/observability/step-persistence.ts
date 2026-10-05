/**
 * @polyroot/runtime — Durable per-step persistence for the G4 loop.
 *
 * Wired as `G4CoreObservability.emitStepComplete`: every step (including
 * NO_TRADE abstains) is recorded so `polyroot explain` / `insight` show
 * real history. Trading logic is untouched — this is a passive observer.
 *
 * Schema notes (verified against migrations/ + live DB):
 * - market_snapshots.market_id REFERENCES markets(id): unregistered markets
 *   are skipped silently (expected, not operator-actionable).
 * - forecasts.probability_yes is NOT NULL: abstains (p === null) record no
 *   forecast row; the NO_TRADE reason still lands in the decision log.
 * - forecasts.confidence is derived as certainty = 2*|p - 0.5| (0 at p=0.5,
 *   1 at extremes), NOT a model self-report. Documented here and in lineage.
 * - paper_log.fill_status ∈ {FILLED,PARTIAL,CANCELLED}: missing fill → CANCELLED.
 * - shadow_log.fill_status MUST be 'NONE' (schema CHECK): SHADOW records
 *   decisions only, never fills.
 * - MICRO_LIVE/LIVE write snapshots + forecasts only; fills/orders persist
 *   through the executor path, never here.
 *
 * Persistence NEVER throws into the trading loop: createStepPersistence
 * fire-and-forgets with an error hook (default: console.warn).
 */

import type { QueryablePool } from "../mode-watcher.js";
import type {
  G4CoreInput,
  G4CoreResult,
  G4Mode,
  StepReasoning,
} from "../g4-core.js";
import { classifyRegime, resolveEdgeFloor } from "../g4-core.js";

export interface StepPersistenceDeps {
  pool: QueryablePool;
  mode: G4Mode;
  /** Model label for forecast rows (env POLYROOT_FORECAST_MODEL or unknown). */
  model?: string | undefined;
  /** Base edge floor the loop enforces (default 0.03, mirrors core default). */
  baseMinEdge?: number | undefined;
  /** Latest stated AI reasoning per market (best-effort, may be absent). */
  getReasoning?: ((marketId: string) => StepReasoning | undefined) | undefined;
  /** Called on persistence failure (default: console.warn). Never throws. */
  onError?: ((table: string, err: Error) => void) | undefined;
}

export interface PersistedStep {
  snapshot: boolean;
  forecast: boolean;
  decisionLog: boolean;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Certainty derived from p: 0 at p=0.5 (coin flip), 1 at p=0/1. */
function certainty(p: number): number {
  return round4(Math.min(1, Math.max(0, 2 * Math.abs(p - 0.5))));
}

async function tryInsert(
  deps: StepPersistenceDeps,
  table: string,
  sql: string,
  params: unknown[],
): Promise<boolean> {
  try {
    await deps.pool.query(sql, params);
    return true;
  } catch (err) {
    const hook =
      deps.onError ??
      ((t, e) => console.warn(`⚠️  persist ${t} skipped: ${e.message}`));
    try {
      hook(table, err as Error);
    } catch {
      // error hook itself must never break the loop either
    }
    return false;
  }
}

/**
 * Persist one G4 step. Never throws (per-table failures resolve false).
 * Exported for tests; the loop uses createStepPersistence instead.
 */
export async function persistStep(
  deps: StepPersistenceDeps,
  input: Pick<G4CoreInput, "market_id" | "bid" | "ask">,
  result: Pick<
    G4CoreResult,
    "market_id" | "decision" | "reason" | "p" | "size" | "fill"
  >,
): Promise<PersistedStep> {
  const out: PersistedStep = {
    snapshot: false,
    forecast: false,
    decisionLog: false,
  };
  const bid = round4(input.bid);
  const ask = round4(input.ask);

  // 1. Market snapshot. Skipped SILENTLY when the market is not registered
  // in markets(id): undiscovered/manual tokens have no parent row, and that
  // is expected — not operator-actionable, so no warning (unlike real errors).
  let registered = true;
  try {
    const check = await deps.pool.query(
      `SELECT 1 FROM markets WHERE id = $1 LIMIT 1`,
      [input.market_id],
    );
    registered = check.rows.length > 0;
  } catch {
    registered = true; // check itself failed: attempt insert, warn on failure
  }
  out.snapshot = registered
    ? await tryInsert(
        deps,
        "market_snapshots",
        `INSERT INTO market_snapshots (market_id, yes_price, no_price, spread)
         VALUES ($1, $2, $3, $4)`,
        [input.market_id, bid, ask, round4(Math.abs(ask - bid))],
      )
    : false;

  // 2. Forecast row — only when p is a finite probability.
  const p =
    typeof result.p === "number" && Number.isFinite(result.p)
      ? round4(result.p)
      : null;
  if (p !== null) {
    const abstain =
      result.decision === "NO_TRADE" ? (result.reason ?? "abstained") : null;
    const reasoning = deps.getReasoning?.(result.market_id);
    const lineage: Record<string, unknown> = {
      source: "g4-step",
      mode: deps.mode,
      regime: classifyRegime(input.bid, input.ask),
      edgeFloor: resolveEdgeFloor(
        deps.baseMinEdge ?? 0.03,
        Math.abs(input.ask - input.bid),
      ),
    };
    if (reasoning?.rationale) lineage["rationale"] = reasoning.rationale;
    if (reasoning && reasoning.factors.length > 0) {
      lineage["factors"] = reasoning.factors;
    }
    out.forecast = await tryInsert(
      deps,
      "forecasts",
      `INSERT INTO forecasts
         (market_id, horizon_sec, probability_yes, confidence, model,
          p_raw, p_calibrated, abstain_reason, assumptions, lineage)
       VALUES ($1, 3600, $2, $3, $4, $2, $2, $5, $6, $7)`,
      [
        result.market_id,
        p,
        certainty(p),
        reasoning?.model ?? deps.model ?? "unknown",
        abstain,
        reasoning?.rationale ? [reasoning.rationale.slice(0, 280)] : [],
        JSON.stringify(lineage),
      ],
    );
  }

  // 3. Decision log — one audit table for every mode. paper_log went
  // away with PAPER; live fills persist through the executor path and
  // this row is the step audit trail (fill columns stay NONE per schema).
  const uncertainty = p === null ? 1 : round4(1 - certainty(p));
  const size =
    typeof result.size === "number" && Number.isFinite(result.size)
      ? result.size
      : 0;
  out.decisionLog = await tryInsert(
    deps,
    "shadow_log",
    `INSERT INTO shadow_log (market_id, action, forecast_p, size, uncertainty)
     VALUES ($1,$2,$3,$4,$5)`,
    [result.market_id, result.decision, p, size, uncertainty],
  );
  return out;
}

const pendingWrites = new Set<Promise<PersistedStep>>();

/**
 * Wait for all in-flight step writes to settle. The trading loop never
 * calls this per step (fire-and-forget there); shutdown paths (`--once`,
 * SIGINT) call it before closing the pool so the last steps are not lost.
 */
export async function flushStepPersistence(): Promise<void> {
  await Promise.allSettled([...pendingWrites]);
}

/**
 * Build the G4CoreObservability hook for bootstrapAgent. Fire-and-forget:
 * the returned hook never blocks or throws into the trading loop.
 */
export function createStepPersistence(deps: StepPersistenceDeps): {
  emitStepComplete(input: G4CoreInput, result: G4CoreResult): void;
} {
  return {
    emitStepComplete: (input, result) => {
      const p = persistStep(deps, input, result);
      pendingWrites.add(p);
      void p.finally(() => {
        pendingWrites.delete(p);
      });
    },
  };
}
