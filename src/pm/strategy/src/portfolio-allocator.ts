/**
 * @polyroot/strategy — Portfolio allocator (PM-STR-11).
 *
 * Answers the two questions a fixed-size loop cannot: HOW MUCH per trade
 * (Kelly on live equity — see sizing.ts) and HOW MANY markets per pass.
 * The agent decides both from live conditions; the owner sets only the
 * outer walls (max concurrent markets, portfolio cap, loss latch).
 *
 * Per-pass flow in G4Pipeline.runContinuous:
 *   1. settle resolved positions (frees capital back),
 *   2. portfolio-full gate (exposure >= cap -> skip pass),
 *   3. rank markets by previous-pass scores, evaluate top-K only,
 *   4. record scores + fills for the next pass.
 *
 * Scoring uses the previous pass's edge (ordering heuristic only —
 * every decision still re-evaluates fresh books and AI forecasts, so a
 * stale score can delay a market by passes but never fabricate a trade).
 * First pass has no scores: evaluate everything (warmup).
 */

/** Score from the previous pass: edge scaled by conviction. */
export function scoreOpportunity(
  edgeAfterFees: number | undefined,
  p: number | undefined,
): number {
  if (edgeAfterFees === undefined || !Number.isFinite(edgeAfterFees)) {
    return Number.NEGATIVE_INFINITY;
  }
  const conviction =
    p !== undefined && Number.isFinite(p)
      ? Math.min(Math.max(Math.abs(p - 0.5) * 2, 0), 1)
      : 0.5;
  return edgeAfterFees * conviction;
}

export interface RankedMarket {
  marketId: string;
  score: number;
  scoredAtMs: number;
}

/**
 * Choose which markets to evaluate this pass. Warmup (empty memory)
 * evaluates all; afterwards the top-K by score go first and the rest
 * defer. Stale scores (older than staleAfterMs) sink below fresh ones
 * but still evaluate when budget remains — unknown markets are never
 * starved forever.
 */
export function selectMarketsForPass(
  memory: Map<string, RankedMarket>,
  inputIds: string[],
  k: number,
  nowMs = Date.now(),
  staleAfterMs = 10 * 60_000,
): { selected: string[]; deferred: string[] } {
  const limit =
    !Number.isFinite(k) || k <= 0 ? inputIds.length : Math.floor(k);
  if (memory.size === 0 || limit >= inputIds.length) {
    return { selected: [...inputIds], deferred: [] };
  }
  const ranked = inputIds.map((id) => {
    const m = memory.get(id);
    // Unknown markets score neutral (0): above proven losers, below proven
    // winners — new opportunities always get evaluated, never starved.
    // Stale scores sink to -Infinity: outdated praise must not outrank
    // fresh evidence, but still evaluates when budget remains.
    const score =
      m === undefined
        ? 0
        : nowMs - m.scoredAtMs <= staleAfterMs
          ? m.score
          : Number.NEGATIVE_INFINITY;
    return { id, score };
  });
  ranked.sort((a, b) => b.score - a.score);
  return {
    selected: ranked.slice(0, limit).map((r) => r.id),
    deferred: ranked.slice(limit).map((r) => r.id),
  };
}

/**
 * Live equity bankroll: owner cap plus realized session P&L, floored at
 * zero (a blown account sizes everything to zero — fail-closed). Lets
 * Kelly sizing compound wins and shrink on losses without owner input.
 */
export function equityBankroll(
  capUsd: number,
  sessionPnlUsd: number,
): number {
  if (!Number.isFinite(capUsd) || capUsd <= 0) return 0;
  const pnl = Number.isFinite(sessionPnlUsd) ? sessionPnlUsd : 0;
  return Math.max(capUsd + pnl, 0);
}

/**
 * Open-position tracker: notional USD resting in fills. Positions leave
 * only via settlement (resolution/redeem feed) — there is no exit engine
 * in the loop, so nothing here ever "sells to free capital". Pure ledger.
 */
export class PositionTracker {
  private readonly open = new Map<string, number>();

  /** Record a fill (accumulates per token). Ignores garbage silently. */
  add(tokenId: string, notionalUsd: number): void {
    if (!tokenId || !Number.isFinite(notionalUsd) || notionalUsd <= 0) return;
    this.open.set(tokenId, (this.open.get(tokenId) ?? 0) + notionalUsd);
  }

  /**
   * Remove settled tokens, returning reclaimed notional + count.
   * Unknown ids are ignored (never negative, never throws).
   */
  resolve(tokenIds: string[]): { reclaimedUsd: number; count: number } {
    let reclaimedUsd = 0;
    let count = 0;
    for (const id of tokenIds) {
      const v = this.open.get(id);
      if (v !== undefined) {
        reclaimedUsd += v;
        count += 1;
        this.open.delete(id);
      }
    }
    return { reclaimedUsd, count };
  }

  total(): number {
    let sum = 0;
    for (const v of this.open.values()) sum += v;
    return sum;
  }

  count(): number {
    return this.open.size;
  }
}
