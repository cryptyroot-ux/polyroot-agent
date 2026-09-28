/**
 * @polyroot/runtime — Durable per-step persistence for the G4 loop.
 *
 * Wired as `G4CoreObservability.emitStepComplete`: every step (including
 * NO_TRADE abstains) is recorded so `polyroot explain` / `insight` show
 * real history. Trading logic is untouched — this is a passive observer.
 *
 * Schema notes (verified against migrations/ + live DB):
 * - market_snapshots.market_id REFERENCES markets(id): inserts for unknown
 *   markets (e.g. PAPER mock ids) fail FK and are skipped with a warning.
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
import type { G4CoreInput, G4CoreResult, G4Mode } from "../g4-core.js";

export interface StepPersistenceDeps {
  pool: QueryablePool;
  mode: G4Mode;
  /** Model label for forecast rows (env POLYROOT_FORECAST_MODEL or unknown). */
  model?: string | undefined;
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

  // 1. Market snapshot (best-effort: FK to markets(id) may fail for mocks).
  out.snapshot = await tryInsert(
    deps,
    "market_snapshots",
    `INSERT INTO market_snapshots (market_id, yes_price, no_price, spread)
     VALUES ($1, $2, $3, $4)`,
    [input.market_id, bid, ask, round4(Math.abs(ask - bid))],
  );

  // 2. Forecast row — only when p is a finite probability.
  const p =
    typeof result.p === "number" && Number.isFinite(result.p)
      ? round4(result.p)
      : null;
  if (p !== null) {
    const abstain =
      result.decision === "NO_TRADE" ? (result.reason ?? "abstained") : null;
    out.forecast = await tryInsert(
      deps,
      "forecasts",
      `INSERT INTO forecasts
         (market_id, horizon_sec, probability_yes, confidence, model,
          p_raw, p_calibrated, abstain_reason, lineage)
       VALUES ($1, 3600, $2, $3, $4, $2, $2, $5, $6)`,
      [
        result.market_id,
        p,
        certainty(p),
        deps.model ?? "unknown",
        abstain,
        JSON.stringify({ source: "g4-step", mode: deps.mode }),
      ],
    );
  }

  // 3. Decision log — PAPER/SHADOW tables; live modes persist via executor.
  const uncertainty = p === null ? 1 : round4(1 - certainty(p));
  const size =
    typeof result.size === "number" && Number.isFinite(result.size)
      ? result.size
      : 0;
  if (deps.mode === "PAPER") {
    const fill = result.fill;
    out.decisionLog = await tryInsert(
      deps,
      "paper_log",
      `INSERT INTO paper_log
         (market_id, action, forecast_p, size, fill_status, filled_size,
          fill_price, maker_fee, taker_fee, uncertainty, loop_epoch)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0)`,
      [
        result.market_id,
        result.decision,
        p,
        size,
        fill?.status ?? "CANCELLED",
        fill?.filledSize ?? 0,
        fill?.fillPrice ?? null,
        fill?.makerFee ?? 0,
        fill?.takerFee ?? 0,
        uncertainty,
      ],
    );
  } else if (deps.mode === "SHADOW") {
    out.decisionLog = await tryInsert(
      deps,
      "shadow_log",
      `INSERT INTO shadow_log (market_id, action, forecast_p, size, uncertainty)
       VALUES ($1,$2,$3,$4,$5)`,
      [result.market_id, result.decision, p, size, uncertainty],
    );
  } else {
    out.decisionLog = true; // live fills persist through the executor path
  }
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
