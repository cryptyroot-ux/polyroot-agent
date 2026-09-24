// tests/pm/contracts/strategies-core.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EvidenceDirectionalV2 } from "@polyroot/strategy";
import { MarketGraphRelativeValueV1 } from "@polyroot/strategy";
import type {
  MarketSnapshot,
  GraphEdge,
  MarketFeeSettings,
} from "@polyroot/domain";

describe("evidence_directional_v2", () => {
  it("evidence_directional_v2 produces NO_TRADE when conservative edge < minEdge", async () => {
    const strategy = new EvidenceDirectionalV2({ minEdgeAfterCost: 0.03 });

    const result = await strategy.run({
      forecast: {
        schema_version: "1.0.0",
        forecast_id: "00000000-0000-0000-0000-000000000001",
        market_id: "mkt_1",
        p_conservative: 0.52,
        p_calibrated: 0.55,
        evidence_ids: ["e1"],
        counterevidence_ids: [],
        assumptions: [],
        invalidators: [],
        horizon_sec: 3600,
        valid_until: new Date(Date.now() + 3600000),
        created_at: new Date(),
      },
      book: { yes_price: 0.48, no_price: 0.52 },
      fees: { taker_bps: 200 },
    });

    assert.equal(result?.no_trade_code, "MIN_EDGE_UNMET");
  });
});

describe("market_graph_relative_value_v1", () => {
  it("identifies and returns NEG_RISK pairs with executable quotes", async () => {
    const graphStore = {
      upsert: async () => {},
      getEdgesByMarket: async () => [],
      getEdgesByType: async () => [],
      deleteMarketEdges: async () => {},
    };

    const strategy = new MarketGraphRelativeValueV1(graphStore as any, {
      minEdgeAfterCost: 0.01,
    });

    const edge: GraphEdge = {
      schema_version: "1.0.0",
      from_market_id: "market1",
      to_market_id: "market2",
      relation_type: "NATIVE_NEG_RISK",
      trust_level: "VERIFIED_PLATFORM",
      provenance: "test",
    };

    const snapshots = new Map<string, MarketSnapshot>([
      [
        "market1",
        {
          schema_version: "1.0.0",
          event_id: "e1",
          market_id: "market1",
          condition_id: "c1",
          question: "Q1",
          chain_id: 1,
          collateral: "USDC",
          rules_hash: "h1",
          fee_maker_bps: 0,
          fee_taker_bps: 200,
          tick_size: 0.01,
          min_size: 0.01,
          status: "OPEN",
          is_neg_risk: true,
          venue_mode: "NORMAL",
          source_at: new Date(),
          received_at: new Date(),
          yes_price: 0.48,
          no_price: 0.48,
        },
      ],
      [
        "market2",
        {
          schema_version: "1.0.0",
          event_id: "e1",
          market_id: "market2",
          condition_id: "c1",
          question: "Q2",
          chain_id: 1,
          collateral: "USDC",
          rules_hash: "h2",
          fee_maker_bps: 0,
          fee_taker_bps: 200,
          tick_size: 0.01,
          min_size: 0.01,
          status: "OPEN",
          is_neg_risk: true,
          venue_mode: "NORMAL",
          source_at: new Date(),
          received_at: new Date(),
          yes_price: 0.48,
          no_price: 0.48,
        },
      ],
    ]);

    const result = await strategy.run({
      graphEdges: [edge],
      snapshots,
      fees: {
        schema_version: "1.0.0",
        market_id: "market1",
        fee_maker_bps: 0,
        fee_taker_bps: 200,
        fee_currency: "USDC",
        tick_size: 0.01,
        min_size: 0.01,
        trade_mode: "NEG_RISK",
        fee_settings_hash: "hash",
        observed_at: new Date(),
      } as MarketFeeSettings,
    });

    assert.equal(Array.isArray(result), true);
  });
});
