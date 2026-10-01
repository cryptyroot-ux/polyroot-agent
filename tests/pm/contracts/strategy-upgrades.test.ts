import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateEdge, clobTakerFeePerShare } from "@polyroot/control";
import type { Forecast, MarketSnapshot } from "@polyroot/domain";
import {
  classifyRegime,
  resolveEdgeFloor,
  flbExtremePremium,
  expiryEdgePremium,
  smartMoneyGuardPremium,
  executeG4Step,
  getDefaultModeConfig,
} from "@polyroot/runtime";
import {
  parseGammaEvents,
  parseDiscoveryBounds,
  filterTightSpreadTokens,
  touchDepthNotionalUsd,
  type TokenTouch,
} from "@polyroot/venue";
import { kellyFraction, kellyShares, QuoteEngine, evaluateMultiOutcomeArb, scoreOpportunity, selectMarketsForPass, equityBankroll, PositionTracker } from "@polyroot/strategy";
import { countComponentFamilies } from "../../../src/pm/intelligence/src/ensemble-pg";
import { countEnsembleFamilies } from "../../../src/pm/intelligence/src/calibration";
import { randomUUID } from "crypto";

function close(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

function makeForecast(over: Partial<Forecast> = {}): Forecast {
  return {
    schema_version: "1.1",
    forecast_id: randomUUID(),
    market_id: "mkt_1",
    p_calibrated: 0.7,
    confidence: 0.8,
    horizon_sec: 3600,
    valid_until: new Date("2026-01-01T01:00:00Z"),
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function makeBook(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    schema_version: "1.1",
    event_id: "evt_1",
    market_id: "mkt_1",
    question: "Will X happen?",
    chain_id: 137,
    collateral: "0xCOLLAT",
    rules_hash: "rh_1",
    fee_maker_bps: 0,
    fee_taker_bps: 0,
    tick_size: 0.01,
    min_size: 1,
    status: "ACTIVE",
    is_neg_risk: false,
    venue_mode: "NORMAL",
    yes_price: 0.4,
    no_price: 0.6,
    source_at: new Date("2026-01-01T00:00:00Z"),
    received_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

/* ─── U1: CLOB Θ fee model ─────────────────────────────────────────── */

describe("CLOB taker fee Θ·p·(1−p)", () => {
  it("peaks at mid-prices and vanishes at extremes", () => {
    assert.ok(close(clobTakerFeePerShare(0.5, 0.05), 0.0125));
    assert.ok(close(clobTakerFeePerShare(0.1, 0.05), 0.0045));
    assert.ok(close(clobTakerFeePerShare(0.9, 0.05), 0.0045));
    assert.ok(close(clobTakerFeePerShare(0.0, 0.05), 0));
    assert.ok(close(clobTakerFeePerShare(NaN), 0));
  });

  it("evaluateEdge prices each side at its own touch when feeTheta set", () => {
    const res = evaluateEdge(
      { forecast: makeForecast({ p_calibrated: 0.6 }), book: makeBook({ yes_price: 0.55 }) },
      { minEdge: 0.03, feeTheta: 0.05 },
    );
    // gross 0.05, fee Θ·0.55·0.45 = 0.012375 → net 0.037625 ≥ 0.03
    assert.equal(res.action, "TRADE");
    assert.ok(close(res.edge_after_fees, 0.05 - 0.05 * 0.55 * 0.45));
  });

  it("explicit flat takerFeeBps still wins (backward compatible)", () => {
    const res = evaluateEdge(
      { forecast: makeForecast({ p_calibrated: 0.6 }), book: makeBook({ yes_price: 0.55 }) },
      { minEdge: 0.025, takerFeeBps: 200, feeTheta: 0.05 },
    );
    // flat 2% wins over Θ: net ≈ 0.03 ≥ 0.025 → TRADE
    assert.equal(res.action, "TRADE");
    assert.ok(Math.abs(res.edge_after_fees - 0.03) < 1e-9);
  });

  it("legacy books without feeTheta behave exactly as before", () => {
    const res = evaluateEdge(
      { forecast: makeForecast(), book: makeBook() },
      { minEdge: 0.05 },
    );
    assert.equal(res.action, "TRADE");
    assert.ok(close(res.edge_after_fees, 0.3));
  });
});

/* ─── Guards: FLB extremes + expiry ────────────────────────────────── */

describe("research-backed edge guards", () => {
  it("flbExtremePremium charges +2pp under 10¢ / over 90¢ only", () => {
    assert.equal(flbExtremePremium(0.05), 0.02);
    assert.equal(flbExtremePremium(0.95), 0.02);
    assert.equal(flbExtremePremium(0.5), 0);
    assert.equal(flbExtremePremium(0.1), 0);
    assert.equal(flbExtremePremium(NaN), 0);
  });

  it("expiryEdgePremium steps up with distance to resolution", () => {
    assert.equal(expiryEdgePremium(null), 0);
    assert.equal(expiryEdgePremium(undefined), 0);
    assert.equal(expiryEdgePremium(3), 0);
    assert.equal(expiryEdgePremium(7), 0.005);
    assert.equal(expiryEdgePremium(30), 0.005);
    assert.equal(expiryEdgePremium(31), 0.01);
    assert.equal(expiryEdgePremium(-1), 0);
  });

  it("resolveEdgeFloor adds the guard premium without touching the base", () => {
    assert.ok(close(resolveEdgeFloor(0.03, 0.1), 0.08));
    assert.ok(close(resolveEdgeFloor(0.03, 0.1, 0.02), 0.1));
    assert.ok(close(resolveEdgeFloor(0.03, 0.1, NaN), 0.08));
  });
});

/* ─── U4: regime enforcement in the live step ──────────────────────── */

describe("executeG4Step enforces book regime (no longer display-only)", () => {
  function core() {
    return {
      config: getDefaultModeConfig("SHADOW", { minEdgeAfterCost: 0.03 }),
      deps: {
        venueMode: () => "NORMAL",
        forecast: async () => 0.65,
        sizeIntent: () => {
          throw new Error("must not reach sizing on untradeable books");
        },
        now: () => new Date(),
      },
    };
  }

  it("DUST books abstain before sizing", async () => {
    assert.equal(classifyRegime(0.005, 0.015), "DUST");
    const res = await executeG4Step(
      { market_id: "dust", bid: 0.005, ask: 0.015, forecastOverride: 0.65 },
      core() as never,
      { cancelProbability: 0 } as never,
    );
    assert.equal(res.decision, "NO_TRADE");
    assert.ok((res.reason ?? "").includes("DUST"));
  });

  it("TIGHT_CONSENSUS books abstain before sizing", async () => {
    assert.equal(classifyRegime(0.5, 0.51), "TIGHT_CONSENSUS");
    const res = await executeG4Step(
      { market_id: "tight", bid: 0.5, ask: 0.51, forecastOverride: 0.65 },
      core() as never,
      { cancelProbability: 0 } as never,
    );
    assert.equal(res.decision, "NO_TRADE");
    assert.ok((res.reason ?? "").includes("TIGHT_CONSENSUS"));
  });
});

/* ─── U3/U5: discovery expiry + depth + churn ──────────────────────── */

describe("discovery: expiry, depth and wash guards", () => {
  it("parseGammaEvents captures endDate (market, then event fallback)", () => {
    const out = parseGammaEvents([
      {
        endDate: "2026-12-31T00:00:00Z",
        markets: [
          {
            question: "Q1",
            slug: "q1",
            clobTokenIds: '["1","2"]',
            volume24hr: "20000",
            endDate: "2026-06-01T00:00:00Z",
          },
          {
            question: "Q2",
            slug: "q2",
            clobTokenIds: '["3","4"]',
            volume24hr: "20000",
          },
        ],
      },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0]?.endDateMs, Date.parse("2026-06-01T00:00:00Z"));
    assert.equal(out[1]?.endDateMs, Date.parse("2026-12-31T00:00:00Z"));
  });

  it("parseDiscoveryBounds gains safe defaults for the new guardrails", () => {
    const b = parseDiscoveryBounds({});
    assert.equal(b.minHoursToExpiry, 2);
    assert.equal(b.minTouchDepthUsd, 25);
    assert.equal(b.maxChurnRatio, 2000);
    const off = parseDiscoveryBounds({
      POLYROOT_DISCOVERY_MIN_HOURS_TO_EXPIRY: "0",
      POLYROOT_DISCOVERY_MIN_TOUCH_DEPTH_USD: "0",
      POLYROOT_DISCOVERY_MAX_CHURN_RATIO: "0",
    });
    assert.equal(off.minHoursToExpiry, 0);
    assert.equal(off.minTouchDepthUsd, 0);
    assert.equal(off.maxChurnRatio, 0);
    const bad = parseDiscoveryBounds({
      POLYROOT_DISCOVERY_MIN_HOURS_TO_EXPIRY: "nope",
    });
    assert.equal(bad.minHoursToExpiry, 2);
  });

  it("touchDepthNotionalUsd values touch depth, null on missing sizes", () => {
    assert.ok(
      close(
        touchDepthNotionalUsd({
          tokenId: "t",
          bid: 0.5,
          ask: 0.55,
          bidSizeShares: 100,
          askSizeShares: 200,
        }) ?? -1,
        0.5 * 100 + 0.55 * 200,
      ),
    );
    assert.equal(
      touchDepthNotionalUsd({ tokenId: "t", bid: 0.5, ask: 0.55 }),
      null,
    );
  });

  const deepTouch = (id: string): TokenTouch => ({
    tokenId: id,
    bid: 0.5,
    ask: 0.55,
    bidSizeShares: 10_000,
    askSizeShares: 10_000,
  });

  it("rejects near-expiry gambles and thin/washy books", async () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const mk = (q: string, endDateMs?: number, volume24h = 50_000) => ({
      question: q,
      slug: q,
      yesTokenId: `${q}-Y`,
      noTokenId: `${q}-N`,
      volume24h,
      ...(endDateMs === undefined ? {} : { endDateMs }),
    });
    // expiring in 30min < 2h default → dropped without touching the book
    let hits = 0;
    const counting = async (id: string) => {
      hits += 1;
      return deepTouch(id);
    };
    const out = await filterTightSpreadTokens(
      [mk("soon", now + 30 * 60_000)],
      0.1,
      counting,
      { nowMs: now },
    );
    assert.equal(out.length, 0);
    assert.equal(hits, 0);

    // $10 touch depth on $50k volume → churn 5000 > 2000 → dropped
    const thin: TokenTouch = {
      tokenId: "thin-Y",
      bid: 0.5,
      ask: 0.55,
      bidSizeShares: 10,
      askSizeShares: 10,
    };
    const out2 = await filterTightSpreadTokens(
      [mk("washy", now + 30 * 24 * 3_600_000)],
      0.1,
      async (id) => (id.endsWith("-Y") ? thin : deepTouch(id)),
      { nowMs: now },
    );
    assert.ok(!out2.flatMap((m) => m.tokenIds).includes("washy-Y"));
    assert.ok(out2.flatMap((m) => m.tokenIds).includes("washy-N"));
  });

  it("price-only touches keep the legacy spread-only verdict", async () => {
    const out = await filterTightSpreadTokens(
      [
        {
          question: "legacy",
          slug: "legacy",
          yesTokenId: "L-Y",
          noTokenId: "L-N",
          volume24h: 50_000,
        },
      ],
      0.1,
      async (id) => ({ tokenId: id, bid: 0.5, ask: 0.55 }),
    );
    assert.deepEqual(out.flatMap((m) => m.tokenIds).sort(), ["L-N", "L-Y"]);
  });
});

/* ─── QuoteEngine: own-side pricing + depth honesty ──────────────────── */

describe("QuoteEngine prices the intent's own token side", () => {
  const engine = () =>
    new QuoteEngine({
      minEdgeAfterCost: 0.03,
      maxSlippageAbs: 0.05,
      makerFeeBps: 0,
      takerFeeBps: 200,
    });

  const intent = (over: Record<string, unknown> = {}) => ({
    schema_version: "1.1",
    intent_id: randomUUID(),
    dedupe_key: "k",
    purpose: "ENTRY",
    market_id: "mkt_1",
    side: "YES",
    forecast_refs: [],
    evidence_ids: [],
    ...over,
  });

  it("YES intent is edged against yes_price (not no_price)", () => {
    // valuation 0.70 vs YES 0.60 → edge 0.10 − 0.02 fee = 0.08 ≥ 0.03.
    // maxSlippageAbs 0.5 disables clamping so this tests pure edge math.
    const eng = new QuoteEngine({
      minEdgeAfterCost: 0.03,
      maxSlippageAbs: 0.5,
      makerFeeBps: 0,
      takerFeeBps: 200,
    });
    const q = eng.adjustQuote(
      intent({ side: "YES", price: 0.7, size: 10 }) as never,
      { yes_price: 0.6, no_price: 0.4 },
    );
    assert.equal(q.valid, true);
    assert.ok(Math.abs(q.edgeAfterCost - 0.08) < 1e-9);
    // Old inverted code read no_price (0.40): edge would have been 0.28.
    assert.ok(q.edgeAfterCost < 0.2);
  });

  it("NO intent is edged against no_price", () => {
    const eng = new QuoteEngine({
      minEdgeAfterCost: 0.03,
      maxSlippageAbs: 0.5,
      makerFeeBps: 0,
      takerFeeBps: 200,
    });
    const q = eng.adjustQuote(
      intent({ side: "NO", price: 0.72, size: 10 }) as never,
      { yes_price: 0.6, no_price: 0.65 },
    );
    assert.equal(q.valid, true);
    assert.ok(Math.abs(q.edgeAfterCost - (0.72 - 0.65 - 0.02)) < 1e-9);
  });

  it("slippage clamps toward the touch (exact 2¢ books stay exact)", () => {
    // valuation 0.70 vs YES 0.60, maxSlip 5¢ → clamped to 0.65, edge 3¢.
    const q = engine().adjustQuote(
      intent({ side: "YES", price: 0.7, size: 10 }) as never,
      { yes_price: 0.6, no_price: 0.4 },
    );
    assert.equal(q.valid, true);
    assert.ok(Math.abs((q.price ?? -1) - 0.65) < 1e-9);
    assert.equal(q.reason, "SLIPPAGE_CLAMPED");
  });

  it("bare BUY/SELL without a token side is invalid (fail-closed)", () => {
    const q = engine().adjustQuote(
      intent({ side: "BUY", price: 0.7, size: 10 }) as never,
      { yes_price: 0.6, no_price: 0.4 },
    );
    assert.equal(q.valid, false);
    assert.equal(q.reason, "SIDE_AMBIGUOUS");
  });

  it("size scales down to resting depth (no book-walking)", () => {
    const q = engine().adjustQuote(
      intent({ side: "YES", price: 0.7, size: 100 }) as never,
      { yes_price: 0.6, no_price: 0.4, depth: 12 },
    );
    assert.equal(q.valid, true);
    assert.equal(q.size, 12);
    assert.equal(q.reason, "DEPTH_SCALED");
  });
});

/* ─── Maker quoter (post-only primitive) ───────────────────────────── */

describe("maker quoter never crosses the touch", () => {
  const q = (side: "BUY" | "SELL", bid: number, ask: number) =>
    new QuoteEngine({
      minEdgeAfterCost: 0.03,
      maxSlippageAbs: 0.5,
      makerFeeBps: 0,
      takerFeeBps: 200,
    }).makerQuote(side, { bid, ask });

  it("improves by one tick when the spread allows", () => {
    const b = q("BUY", 0.5, 0.55);
    assert.equal(b.valid, true);
    assert.ok(Math.abs(b.price - 0.51) < 1e-9);
    assert.equal(b.reason, "IMPROVE_BID");
    const s = q("SELL", 0.5, 0.55);
    assert.equal(s.valid, true);
    assert.ok(Math.abs(s.price - 0.54) < 1e-9);
    assert.equal(s.reason, "IMPROVE_ASK");
  });

  it("joins the touch on a 1-tick spread (safe direction)", () => {
    const b = q("BUY", 0.5, 0.51);
    assert.equal(b.valid, true);
    assert.ok(Math.abs(b.price - 0.5) < 1e-9);
    assert.equal(b.reason, "JOIN_BID");
  });

  it("refuses crossed books and garbage", () => {
    assert.equal(q("BUY", 0.55, 0.5).reason, "CROSSED_BOOK");
    assert.equal(q("BUY", NaN, 0.5).reason, "BAD_INPUT");
  });
});

/* ─── Smart-money contradiction guard ──────────────────────────────── */

describe("smart-money contradiction guard (one-way)", () => {
  const flow = (over = {}) => ({
    netFlowUsd: -5000,
    buyUsd: 0,
    sellUsd: 5000,
    wallets: 3,
    updatedAtMs: Date.now(),
    ...over,
  });

  it("charges +2pp on strong, fresh, corroborated opposing flow", () => {
    const r = smartMoneyGuardPremium(flow());
    assert.equal(r.premium, 0.02);
    assert.ok((r.note ?? "").includes("3 wallets"));
  });

  it("pays nothing for aligned, thin, small, stale or missing flow", () => {
    assert.equal(smartMoneyGuardPremium({ ...flow(), netFlowUsd: 5000 }).premium, 0);
    assert.equal(smartMoneyGuardPremium({ ...flow(), wallets: 1 }).premium, 0);
    assert.equal(smartMoneyGuardPremium({ ...flow(), netFlowUsd: -500 }).premium, 0);
    assert.equal(
      smartMoneyGuardPremium({ ...flow(), updatedAtMs: Date.now() - 31 * 60_000 }).premium,
      0,
    );
    assert.equal(smartMoneyGuardPremium(null).premium, 0);
    assert.equal(smartMoneyGuardPremium(undefined).premium, 0);
  });

  it("opposing flow blocks a marginal trade in executeG4Step", async () => {
    // book 0.45/0.55 (spread 10¢ → floor 8¢), p=0.65 → net ≈8.76¢ TRADE
    // clean, but +2pp contradiction premium floors it at 10¢ → NO_TRADE.
    const deps = {
      venueMode: () => "NORMAL",
      forecast: async () => 0.65,
      sizeIntent: () => {
        throw new Error("must not reach sizing when blocked");
      },
      now: () => new Date(),
      getSmartMoneyFlow: () => flow(),
    };
    const core = {
      config: getDefaultModeConfig("SHADOW", { minEdgeAfterCost: 0.03 }),
      deps,
    };
    const res = await executeG4Step(
      { market_id: "m1", bid: 0.45, ask: 0.55, forecastOverride: 0.65 },
      core as never,
      { cancelProbability: 0 } as never,
    );
    assert.equal(res.decision, "NO_TRADE");
    assert.equal(res.reason, "MIN_EDGE_UNMET");
  });
});

/* ─── Portfolio allocator: agent decides HOW MANY + HOW MUCH ───────── */

describe("portfolio allocator (autonomy inside owner walls)", () => {
  it("scoreOpportunity scales edge by conviction, garbage scores -inf", () => {
    assert.ok(
      Math.abs(scoreOpportunity(0.08, 0.65) - 0.08 * 0.3) < 1e-9,
    );
    assert.equal(scoreOpportunity(0.08, undefined), 0.08 * 0.5);
    assert.equal(scoreOpportunity(undefined, 0.65), Number.NEGATIVE_INFINITY);
    assert.equal(scoreOpportunity(NaN, 0.65), Number.NEGATIVE_INFINITY);
  });

  it("warmup evaluates everything; then top-K by score, rest defer", () => {
    const ids = ["a", "b", "c", "d"];
    const warm = selectMarketsForPass(new Map(), ids, 2, 1000);
    assert.deepEqual(warm.selected, ids);
    assert.deepEqual(warm.deferred, []);
    const mem = new Map([
      ["a", { marketId: "a", score: 0.01, scoredAtMs: 900 }],
      ["b", { marketId: "b", score: 0.09, scoredAtMs: 900 }],
      ["c", { marketId: "c", score: 0.05, scoredAtMs: 900 }],
      ["d", { marketId: "d", score: -1, scoredAtMs: 900 }],
    ]);
    const pick = selectMarketsForPass(mem, ids, 2, 1000);
    assert.deepEqual(pick.selected, ["b", "c"]);
    assert.deepEqual(pick.deferred, ["a", "d"]);
  });

  it("stale scores sink but never starve; K<=0 means unbounded", () => {
    const mem = new Map([
      ["old", { marketId: "old", score: 0.9, scoredAtMs: 0 }],
    ]);
    const pick = selectMarketsForPass(mem, ["old", "new"], 1, 20 * 60_000);
    assert.deepEqual(pick.selected, ["new"]);
    assert.deepEqual(pick.deferred, ["old"]);
    const all = selectMarketsForPass(mem, ["old", "new"], 0, 1000);
    assert.deepEqual(all.selected, ["old", "new"]);
  });

  it("equityBankroll compounds wins, floors ruin at zero", () => {
    assert.equal(equityBankroll(100, 25), 125);
    assert.equal(equityBankroll(100, -30), 70);
    assert.equal(equityBankroll(100, -100), 0);
    assert.equal(equityBankroll(100, -500), 0);
    assert.equal(equityBankroll(0, 50), 0);
    assert.equal(equityBankroll(100, NaN), 100);
  });

  it("PositionTracker frees only settled capital, never negative", () => {
    const t = new PositionTracker();
    t.add("tokA", 50);
    t.add("tokA", 25);
    t.add("tokB", 10);
    t.add("", -5);
    assert.equal(t.total(), 85);
    assert.equal(t.count(), 2);
    const r = t.resolve(["tokA", "ghost"]);
    assert.deepEqual(r, { reclaimedUsd: 75, count: 1 });
    assert.equal(t.total(), 10);
    assert.deepEqual(t.resolve([]), { reclaimedUsd: 0, count: 0 });
  });
});

describe("multi-outcome arbitrage detector", () => {
  it("BUY_ALL_YES when YES prices sum under $1 after fees", () => {
    const v = evaluateMultiOutcomeArb(
      [
        { tokenId: "a", yesPrice: 0.2 },
        { tokenId: "b", yesPrice: 0.25 },
        { tokenId: "c", yesPrice: 0.3 },
      ],
      { minEdge: 0.03 },
    );
    assert.equal(v.valid, true);
    assert.equal(v.direction, "BUY_ALL_YES");
    assert.equal(v.guaranteedPayout, 1);
    const fees = 0.05 * (0.2 * 0.8 + 0.25 * 0.75 + 0.3 * 0.7);
    assert.ok(Math.abs(v.edge - (1 - 0.75 - fees)) < 1e-9);
  });

  it("BUY_ALL_NO when YES prices sum over $1 after fees", () => {
    const v = evaluateMultiOutcomeArb(
      [
        { tokenId: "a", yesPrice: 0.4 },
        { tokenId: "b", yesPrice: 0.4 },
        { tokenId: "c", yesPrice: 0.4 },
      ],
      { minEdge: 0.03 },
    );
    assert.equal(v.valid, true);
    assert.equal(v.direction, "BUY_ALL_NO");
    assert.equal(v.guaranteedPayout, 2);
    assert.ok(v.edge >= 0.03);
  });

  it("NO_EDGE on a fair book, BAD_INPUT on garbage", () => {
    const fair = evaluateMultiOutcomeArb(
      [
        { tokenId: "a", yesPrice: 0.33 },
        { tokenId: "b", yesPrice: 0.33 },
        { tokenId: "c", yesPrice: 0.34 },
      ],
      { minEdge: 0.03 },
    );
    assert.equal(fair.valid, false);
    assert.equal(fair.reason, "NO_EDGE");
    assert.equal(
      evaluateMultiOutcomeArb([{ tokenId: "a", yesPrice: 0.5 }]).reason,
      "BAD_INPUT",
    );
    assert.equal(
      evaluateMultiOutcomeArb([
        { tokenId: "a", yesPrice: 0 },
        { tokenId: "b", yesPrice: 0.5 },
      ]).reason,
      "BAD_INPUT",
    );
    assert.equal(
      evaluateMultiOutcomeArb([
        { tokenId: "a", yesPrice: 0.4 },
        { tokenId: "", yesPrice: 0.4 },
      ]).reason,
      "BAD_INPUT",
    );
  });
});

describe("ensemble PG stores count real families", () => {
  it("counts distinct component names (both stores agree)", () => {
    const two = [
      { component: "llm-a", p_raw: 0.6 },
      { component: "llm-a", p_raw: 0.7 },
      { component: "smart-money", p_raw: 0.5 },
    ];
    assert.equal(countComponentFamilies(two), 2);
    assert.equal(countEnsembleFamilies(two), 2);
    assert.equal(countComponentFamilies(JSON.stringify(two)), 2);
    assert.equal(countComponentFamilies([]), 1);
    assert.equal(countEnsembleFamilies("garbage{"), 1);
    assert.equal(countEnsembleFamilies(null), 1);
  });
});

/* ─── U7: fractional-Kelly sizing ──────────────────────────────────── */

describe("fractional-Kelly sizing", () => {
  it("even odds: full Kelly 20%, quarter Kelly 5%", () => {
    assert.ok(close(kellyFraction(0.6, 0.5, 1), 0.2));
    assert.ok(close(kellyFraction(0.6, 0.5), 0.05));
  });

  it("never bets without edge or on garbage", () => {
    assert.equal(kellyFraction(0.5, 0.5), 0);
    assert.equal(kellyFraction(0.4, 0.5), 0);
    assert.equal(kellyFraction(NaN, 0.5), 0);
    assert.equal(kellyFraction(0.6, 1.5), 0);
  });

  it("kellyShares converts stake at touch, capped at legacy size", () => {
    // p=0.65, q=0.55: f = 0.10/0.45 × 0.25 ≈ 5.55% of $100 = $5.55 → 10 shares
    assert.equal(
      kellyShares({ p: 0.65, price: 0.55, bankrollUsd: 100 }),
      10,
    );
    // whale bankroll still caps at the legacy 100 (may only shrink)
    assert.equal(
      kellyShares({ p: 0.9, price: 0.5, bankrollUsd: 1_000_000 }),
      100,
    );
    // dust edge stakes nothing
    assert.equal(
      kellyShares({ p: 0.505, price: 0.5, bankrollUsd: 100 }),
      0,
    );
    assert.equal(
      kellyShares({ p: 0.65, price: 0.55, bankrollUsd: 0 }),
      0,
    );
  });
});
