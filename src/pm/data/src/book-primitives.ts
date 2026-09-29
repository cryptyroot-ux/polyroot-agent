/**
 * @polyroot/data — Book primitives (leaf module).
 *
 * SettlementRulesRegistry, OrderBook, FeeGate and UniverseLog live here
 * (not in index.ts) so live-feed can import them WITHOUT creating an
 * index ⇄ live-feed import cycle. index.ts re-exports all four, so every
 * existing import path keeps working. Local cross-references
 * (RulesGateResult, FeeGateResult, MarketDecision) stay canonical in
 * index.ts and are imported type-only (erased at runtime — no cycle).
 */
import type {
  MarketFeeSettings,
  OrderBookFrame,
  SettlementRule,
} from "@polyroot/domain";
import type {
  RulesGateResult,
  FeeGateResult,
  MarketDecision,
} from "./index.js";

/** Versioned settlement-rules registry. A rules change invalidates existing
 * forecasts/intents: callers must re-research (PM-DATA-02). */
export class SettlementRulesRegistry {
  private readonly perMarket = new Map<string, SettlementRule>();

  upsert(rule: SettlementRule): void {
    this.perMarket.set(rule.market_id, rule);
  }

  current(marketId: string): SettlementRule | undefined {
    return this.perMarket.get(marketId);
  }

  /** Check an order/forescast pinned to a specific rule version. */
  check(marketId: string, pinnedRulesVersion: string): RulesGateResult {
    const cur = this.perMarket.get(marketId);
    if (!cur)
      return {
        ok: false,
        code: "RULES_CHANGED",
        expectedVersion: pinnedRulesVersion,
        currentVersion: "UNKNOWN",
      };
    if (cur.rule_version !== pinnedRulesVersion) {
      return {
        ok: false,
        code: "RULES_CHANGED",
        expectedVersion: pinnedRulesVersion,
        currentVersion: cur.rule_version,
      };
    }
    return { ok: true, rule: cur };
  }
}

/** Level book with resync semantics (PM-DATA-03): deltas are only applied on
 * an up-to-date snapshot; a reconnect forces `resync_required`. */
export class OrderBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private snapshotAt: Date | undefined;
  private connected = false;

  apply(frame: OrderBookFrame): void {
    if (frame.is_delta && !this.connected) {
      throw new Error("DELTA_WITHOUT_SNAPSHOT");
    }
    if (frame.resync_required || !this.connected) {
      this.bids = new Map((frame.bids ?? []).map(([p, q]) => [p, q]));
      this.asks = new Map((frame.asks ?? []).map(([p, q]) => [p, q]));
      this.snapshotAt = frame.received_at;
      this.connected = true;
      return;
    }
    if (frame.is_delta) {
      if (!this.snapshotAt) throw new Error("DELTA_WITHOUT_SNAPSHOT");
      for (const [p, q] of frame.bids ?? []) {
        if (q === 0) this.bids.delete(p);
        else this.bids.set(p, q);
      }
      for (const [p, q] of frame.asks ?? []) {
        if (q === 0) this.asks.delete(p);
        else this.asks.set(p, q);
      }
    }
  }

  /** After a disconnect, no execution may proceed until a fresh snapshot. */
  disconnect(): void {
    this.connected = false;
    this.snapshotAt = undefined;
  }

  ready(): boolean {
    return this.connected;
  }

  bestBid(): number | undefined {
    const prices = [...this.bids.keys()].sort((a, b) => b - a);
    return prices[0];
  }

  bestAsk(): number | undefined {
    const prices = [...this.asks.keys()].sort((a, b) => a - b);
    return prices[0];
  }
}

/**
 * Real fee settings (PM-DATA-04): fee, tick, min_size, trade_mode must be
 * observed before submit. Unknown fee data => reject entry, never assume.
 */
export class FeeGate {
  private readonly perMarket = new Map<string, MarketFeeSettings>();

  observe(settings: MarketFeeSettings): void {
    this.perMarket.set(settings.market_id, settings);
  }

  requireCurrent(marketId: string, modeHint?: string): FeeGateResult {
    const s = this.perMarket.get(marketId);
    if (!s) return { ok: false, code: "FEE_UNKNOWN" };
    if (modeHint !== undefined && s.trade_mode === "UNKNOWN")
      return { ok: false, code: "FEE_UNKNOWN" };
    if (s.fee_taker_bps > 0 && s.fee_currency === "")
      return { ok: false, code: "FEE_UNKNOWN" };
    return { ok: true, settings: s };
  }
}

/** Append-only log of every market considered (selection-bias audit). */
export class UniverseLog {
  private decisions: MarketDecision[] = [];

  record(d: MarketDecision): void {
    this.decisions.push(d);
  }

  get(id: string): MarketDecision | undefined {
    return this.decisions.find((d) => d.id === id);
  }

  all(): MarketDecision[] {
    return [...this.decisions];
  }

  traded(): MarketDecision[] {
    return this.decisions.filter((d) => d.eligible);
  }

  rejected(): MarketDecision[] {
    return this.decisions.filter((d) => !d.eligible);
  }

  /** Replay the exact set for a calendar day. */
  replayDay(day: Date): MarketDecision[] {
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth();
    const d = day.getUTCDate();
    return this.decisions.filter((x) => {
      const xd = x.decidedAt;
      return (
        xd.getUTCFullYear() === y &&
        xd.getUTCMonth() === m &&
        xd.getUTCDate() === d
      );
    });
  }
}
