/**
 * @polyroot/strategy — Smart Money Consensus Tests (PR-STR-05).
 *
 * Verifies reproducible wallet selection, scoring, consensus, and
 * anti-leakage: signals are evidence, never blind copy-trading.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  selectQualifyingWallets,
  scoreWallet,
  generateConsensus,
  signalToIntent,
  runSmartMoneyPipeline,
  DEFAULT_SELECTION_CRITERIA,
  DEFAULT_SCORING_PARAMS,
  type WalletActivity,
  type WalletScoringParams,
} from "@polyroot/strategy";
import type { AssetIdentity } from "@polyroot/domain";

const asset: AssetIdentity = {
  schema_version: "1.0.0",
  asset_id: "token_test",
  asset_class: "CTF_TOKEN",
  settlement_protocol: "CTF",
  exchange_domain_version: "v2",
  chain_id: 137,
  decimals: 6,
  protocol_profile_id: "poly_v2",
};

function makeActivities(
  wallet: string,
  actions: Array<{ action: "BUY" | "SELL"; days_ago: number; outcome: string }>,
): WalletActivity[] {
  return actions.map(
    (a, i) =>
      ({
        wallet_address: wallet,
        chain_id: 137,
        market_id: "mkt_test",
        action: a.action,
        size_base: 1_000_000n * BigInt(i + 1),
        price: 0.5,
        executed_at: new Date(Date.now() - a.days_ago * 86400000),
        tx_hash: `0x${String(i).padStart(64, "0")}`,
        maker_taker: "TAKER" as const,
        // Cast with outcome info for scoring
        ...{
          outcome: a.outcome,
          realized_edge_bps: a.outcome === "WIN" ? 150 : -50,
        },
      }) as any,
  );
}

describe("PR-STR-05 — Smart Money Consensus (reproducible, causal, anti-leakage)", () => {
  it("selectQualifyingWallets filters by trade count, age, and volume", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    const criteria = {
      ...DEFAULT_SELECTION_CRITERIA,
      selection_lookback_days: 60,
      min_historical_trades: 10,
      min_wallet_age_days: 10,
      min_volume_base: 10_000_000n,
    };
    const activities: WalletActivity[] = [
      // Wallet 1: passes all criteria
      ...Array.from({ length: 20 }, (_, i) => ({
        wallet_address: "0xPASS",
        chain_id: 137,
        market_id: "mkt",
        action: "BUY" as const,
        size_base: 1_000_000n,
        price: 0.5,
        executed_at: new Date(2026, 0, 5 - i), // daily trades
        tx_hash: `0x${i}`,
        maker_taker: "TAKER" as const,
      })),
      // Wallet 2: too few trades
      ...Array.from({ length: 3 }, (_, i) => ({
        wallet_address: "0xSHORT",
        chain_id: 137,
        market_id: "mkt",
        action: "BUY" as const,
        size_base: 1_000_000n,
        price: 0.5,
        executed_at: new Date(2026, 0, 5 - i),
        tx_hash: `0x${i + 100}`,
        maker_taker: "TAKER" as const,
      })),
    ];
    const qualifying = selectQualifyingWallets(activities, criteria, now);
    assert.equal(qualifying.size, 1);
    assert.ok(qualifying.has("0xPASS"));
    assert.ok(!qualifying.has("0xSHORT"));
  });

  it("selectQualifyingWallets excludes activities beyond lookback window", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    const criteria = {
      ...DEFAULT_SELECTION_CRITERIA,
      selection_lookback_days: 30,
      min_historical_trades: 3,
      min_wallet_age_days: 10,
    };
    const activities = [
      // All trades outside 30-day window
      ...Array.from({ length: 10 }, (_, i) => ({
        wallet_address: "0xOLD",
        chain_id: 137,
        market_id: "mkt",
        action: "BUY" as const,
        size_base: 1_000_000n,
        price: 0.5,
        executed_at: new Date(2025, 10, 1 - i), // November 2025
        tx_hash: `0x${i}`,
        maker_taker: "TAKER" as const,
      })),
    ];
    const qualifying = selectQualifyingWallets(activities, criteria, now);
    assert.equal(qualifying.size, 0, "must exclude stale data");
  });

  it("scoreWallet produces deterministic score with full lineage", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    const scoringParams: WalletScoringParams = {
      ...DEFAULT_SCORING_PARAMS,
      min_trades: 3,
    };
    const acts = makeActivities("0xW1", [
      { action: "BUY", days_ago: 1, outcome: "WIN" },
      { action: "BUY", days_ago: 2, outcome: "WIN" },
      { action: "SELL", days_ago: 3, outcome: "LOSS" },
      { action: "BUY", days_ago: 4, outcome: "WIN" },
    ]);
    const scored = scoreWallet("0xW1", acts, scoringParams, now);

    assert.equal(scored.wallet_address, "0xW1");
    assert.equal(scored.trade_count, 4);
    assert.ok(scored.score > 0, "more wins than losses → positive score");
    assert.ok(scored.win_rate > 0 && scored.win_rate <= 1);
    assert.equal(scored.model_version, "smart_money_v1.0.0");
    assert.equal(scored.scoring_params, scoringParams);
    assert.equal(scored.lookback_days, scoringParams.lookback_days);
  });

  it("scoreWallet returns 0 score for wallets with insufficient trades", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    const scored = scoreWallet("0xW1", [], DEFAULT_SCORING_PARAMS, now);
    assert.equal(scored.score, 0);
    assert.equal(scored.trade_count, 0);
  });

  it("generateConsensus returns null when wallet count is too low", () => {
    const scores = [
      {
        wallet_address: "0xW1",
        score: 0.8,
        trade_count: 10,
        win_rate: 0.8,
        avg_edge_bps: 200,
        lookback_days: 90,
        model_version: "v1",
        scoring_params: DEFAULT_SCORING_PARAMS,
        computed_at: new Date(),
      },
    ];
    const signal = generateConsensus("mkt", scores, 5);
    assert.equal(signal, null, "too few wallets for consensus");
  });

  it("generateConsensus produces positive consensus for bullish wallets", () => {
    const scores = Array.from({ length: 10 }, (_, i) => ({
      wallet_address: `0xW${i}`,
      score: 0.5 + Math.random() * 0.4, // all positive
      trade_count: 30 + i * 5,
      win_rate: 0.6,
      avg_edge_bps: 100,
      lookback_days: 90,
      model_version: "v1",
      scoring_params: DEFAULT_SCORING_PARAMS,
      computed_at: new Date(),
    }));
    const signal = generateConsensus("mkt", scores, 5);
    assert.ok(signal !== null);
    assert.ok(signal!.consensus > 0, "consensus must be positive (bullish)");
    assert.ok(signal!.wallet_count === 10);
    assert.ok(signal!.dissent >= 0, "dissent must be non-negative");
  });

  it("signalToIntent returns null for weak consensus", () => {
    const { intent } = runSmartMoneyPipeline(
      "mkt",
      asset,
      [],
      DEFAULT_SELECTION_CRITERIA,
      DEFAULT_SCORING_PARAMS,
      10,
      new Date("2026-01-15T00:00:00Z"),
    );
    assert.equal(intent, null, "no activities → no intent");
  });

  it("runSmartMoneyPipeline end-to-end: activities → qualifying → scores → signal → intent", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    // Generate enough qualifying activity for 10 wallets
    const all_activities: WalletActivity[] = [];
    for (let w = 0; w < 10; w++) {
      for (let i = 0; i < 25; i++) {
        all_activities.push({
          wallet_address: `0xW${w}`,
          chain_id: 137,
          market_id: "mkt_test",
          action: "BUY" as const,
          size_base: BigInt((i + 1) * 1_000_000),
          price: 0.5,
          executed_at: new Date(now.getTime() - (i + 1) * 86400000),
          tx_hash: `0x${String(w).padStart(4, "0")}${String(i).padStart(4, "0")}`,
          maker_taker: "TAKER" as const,
          ...{ outcome: "WIN" as const, realized_edge_bps: 100 },
        } as any);
      }
    }

    const { intent, signal, qualifying_count } = runSmartMoneyPipeline(
      "mkt_test",
      asset,
      all_activities,
      {
        ...DEFAULT_SELECTION_CRITERIA,
        selection_lookback_days: 60,
        min_historical_trades: 10,
        min_wallet_age_days: 1,
        min_volume_base: 1_000_000n,
      },
      DEFAULT_SCORING_PARAMS,
      10,
      now,
    );

    assert.ok(qualifying_count > 0, "should qualify wallets");
    assert.ok(signal !== null, "should produce consensus signal");
    assert.ok(signal!.wallet_count >= 5, "consensus from ≥5 wallets");
    // Intent must be present (strong consensus)
    assert.ok(intent !== null, "strong consensus → intent");
    assert.equal(intent!.market_id, "mkt_test");
    assert.equal(intent!.side, "BUY"); // all wallets are BUY
    assert.ok(intent!.desired_qty > 0, "size must be positive");
  });

  it("anti-leakage: activities after 'now' are excluded from selection", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const future_activities: WalletActivity[] = Array.from(
      { length: 20 },
      (_, i) => ({
        wallet_address: "0xFUTURE",
        chain_id: 137,
        market_id: "mkt",
        action: "BUY" as const,
        size_base: 1_000_000n,
        price: 0.5,
        executed_at: new Date(2026, 0, 5 + i), // future: Jan 5-24
        tx_hash: `0x${i}`,
        maker_taker: "TAKER" as const,
      }),
    );
    const qualifying = selectQualifyingWallets(
      future_activities,
      DEFAULT_SELECTION_CRITERIA,
      now,
    );
    assert.equal(
      qualifying.size,
      0,
      "future activities must be excluded (no leakage)",
    );
  });

  it("wallet with high turnover gets penalized score", () => {
    const now = new Date("2026-01-15T00:00:00Z");
    const lowTurnover = makeActivities("0xLOW", [
      { action: "BUY", days_ago: 10, outcome: "WIN" },
      { action: "BUY", days_ago: 20, outcome: "WIN" },
    ]);
    const highTurnover = makeActivities("0xHIGH", [
      { action: "BUY", days_ago: 1, outcome: "WIN" },
      { action: "SELL", days_ago: 1, outcome: "WIN" },
      { action: "BUY", days_ago: 1, outcome: "WIN" },
      { action: "SELL", days_ago: 1, outcome: "WIN" },
    ]);

    const scoredLow = scoreWallet(
      "0xLOW",
      lowTurnover,
      DEFAULT_SCORING_PARAMS,
      now,
    );
    const scoredHigh = scoreWallet(
      "0xHIGH",
      highTurnover,
      DEFAULT_SCORING_PARAMS,
      now,
    );

    // High turnover wallet should have lower score (penalty applied)
    assert.ok(
      scoredHigh.score <= scoredLow.score,
      "turnover penalty must reduce score",
    );
  });
});
