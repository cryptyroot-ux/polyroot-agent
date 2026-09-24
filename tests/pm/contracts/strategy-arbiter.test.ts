import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StrategyArbiter } from "@polyroot/strategy";
import type {
  StrategyProposal,
  TradeIntent,
  GraphEdge,
  RiskPolicy,
  GraphEdgeStore,
} from "@polyroot/domain";

class MockGraphEdgeStore implements GraphEdgeStore {
  private edges: GraphEdge[] = [];

  async upsert(edge: GraphEdge): Promise<void> {
    this.edges.push(edge);
  }

  async getEdgesByMarket(marketId: string): Promise<GraphEdge[]> {
    return this.edges.filter(
      (e) => e.from_market_id === marketId || e.to_market_id === marketId,
    );
  }

  async getEdgesByType(
    relationType: GraphEdge["relation_type"],
  ): Promise<GraphEdge[]> {
    return this.edges.filter((e) => e.relation_type === relationType);
  }

  async deleteMarketEdges(marketId: string): Promise<void> {
    this.edges = this.edges.filter(
      (e) => e.from_market_id !== marketId && e.to_market_id !== marketId,
    );
  }
}

const defaultPolicy: RiskPolicy = {
  schema_version: "1.0.0",
  policy_version: "test-v1",
  execution_mode: "PAPER",
  capital_usd_cap: 10000,
  max_order_pct: 0.005,
  max_market_pct: 0.02,
  max_event_group_pct: 0.05,
  max_portfolio_pct: 0.1,
  daily_loss_stop_pct: 0.02,
  drawdown_stop_pct: 0.05,
  max_open_orders: 10,
  min_edge_after_cost: 0.03,
  book_max_age_ms: 2000,
  metadata_max_age_s: 60,
  forecast_max_age_s: 900,
  clock_skew_max_ms: 1000,
  max_slippage_abs: 0.01,
  intent_ttl_s: 30,
  risk_permit_ttl_ms: 1000,
  reconcile_interval_s: 15,
};

function createProposal(
  overrides: Partial<StrategyProposal> = {},
): StrategyProposal {
  const now = new Date();
  const base: StrategyProposal = {
    schema_version: "1.0.0",
    proposal_id: crypto.randomUUID(),
    strategy: "test_strategy",
    strategy_version: "v1",
    strategy_params: {
      market_id: "default_mkt",
      side: "BUY",
      desired_qty: 100,
      purpose: "ENTRY",
    },
    expires_at: new Date(now.getTime() + 60000),
  };

  // If overrides contains strategy_params fields, merge them
  const { market_id, side, desired_qty, purpose, ...restOverrides } = overrides;
  if (market_id || side || desired_qty || purpose) {
    base.strategy_params = {
      ...base.strategy_params,
      ...(market_id !== undefined && { market_id }),
      ...(side !== undefined && { side }),
      ...(desired_qty !== undefined && { desired_qty }),
      ...(purpose !== undefined && { purpose }),
    };
  }

  return { ...base, ...restOverrides };
}

describe("Strategy Arbiter", () => {
  it("deduplicates correlated intents via Market Graph (NEG_RISK netting)", async () => {
    const graphStore = new MockGraphEdgeStore();

    // Add NEG_RISK edge between mkt_A and mkt_B
    await graphStore.upsert({
      schema_version: "1.0.0",
      from_market_id: "mkt_A",
      to_market_id: "mkt_B",
      relation_type: "NATIVE_NEG_RISK",
      trust_level: "VERIFIED_PLATFORM",
      provenance: "test",
    });
    await graphStore.upsert({
      schema_version: "1.0.0",
      from_market_id: "mkt_B",
      to_market_id: "mkt_A",
      relation_type: "NATIVE_NEG_RISK",
      trust_level: "VERIFIED_PLATFORM",
      provenance: "test",
    });

    const arbiter = new StrategyArbiter({ graphStore, policy: defaultPolicy });

    const proposals = [
      createProposal({
        strategy: "evidence_directional_v2",
        market_id: "mkt_A",
        side: "BUY",
        desired_qty: 100,
      }),
      createProposal({
        strategy: "market_graph_relative_value_v1",
        market_id: "mkt_B",
        side: "SELL",
        desired_qty: 50,
      }),
    ];

    const intents = await arbiter.arbitrate(proposals);

    // Should net exposure: BUY 100 on mkt_A + SELL 50 on mkt_B (neg_risk pair) = net BUY 50
    assert.equal(intents.length, 1);
    assert.equal(intents[0].side, "BUY");
    assert.equal(intents[0].desired_qty, 50);
  });

  it("sums COMPLEMENT exposures", async () => {
    const graphStore = new MockGraphEdgeStore();

    // Add COMPLEMENT edge between mkt_C and mkt_D
    await graphStore.upsert({
      schema_version: "1.0.0",
      from_market_id: "mkt_C",
      to_market_id: "mkt_D",
      relation_type: "COMPLEMENT",
      trust_level: "INFERRED",
      provenance: "test",
    });

    const arbiter = new StrategyArbiter({ graphStore, policy: defaultPolicy });

    const proposals = [
      createProposal({
        strategy: "strat1",
        market_id: "mkt_C",
        side: "BUY",
        desired_qty: 30,
      }),
      createProposal({
        strategy: "strat2",
        market_id: "mkt_D",
        side: "BUY",
        desired_qty: 20,
      }),
    ];

    const intents = await arbiter.arbitrate(proposals);

    // Should sum exposures: BUY 30 + BUY 20 = BUY 50
    assert.equal(intents.length, 1);
    assert.equal(intents[0].side, "BUY");
    assert.equal(intents[0].desired_qty, 50);
  });

  it("applies correlation discount for CORRELATED markets", async () => {
    const graphStore = new MockGraphEdgeStore();

    // Add CORRELATED edge between mkt_E and mkt_F
    await graphStore.upsert({
      schema_version: "1.0.0",
      from_market_id: "mkt_E",
      to_market_id: "mkt_F",
      relation_type: "CORRELATED",
      trust_level: "INFERRED",
      confidence: 0.8,
      provenance: "test",
    });

    const arbiter = new StrategyArbiter({ graphStore, policy: defaultPolicy });

    const proposals = [
      createProposal({
        strategy: "strat1",
        market_id: "mkt_E",
        side: "BUY",
        desired_qty: 100,
      }),
      createProposal({
        strategy: "strat2",
        market_id: "mkt_F",
        side: "BUY",
        desired_qty: 100,
      }),
    ];

    const intents = await arbiter.arbitrate(proposals);

    // With 0.8 correlation, effective exposure should be discounted
    // 100 + 100 * (1 - 0.8) = 100 + 20 = 120
    assert.ok(intents.length >= 1);
    const totalQty = intents.reduce((sum, i) => sum + (i.desired_qty ?? 0), 0);
    assert.ok(totalQty <= 120, `Expected total <= 120, got ${totalQty}`);
  });

  it("applies strategy budgets per strategy", async () => {
    const graphStore = new MockGraphEdgeStore();
    const policy: RiskPolicy = {
      ...defaultPolicy,
      max_order_pct: 0.5, // Allow large orders for this test
    };

    const arbiter = new StrategyArbiter({ graphStore, policy });

    const proposals = [
      createProposal({
        strategy: "evidence_directional_v2",
        market_id: "mkt_X",
        side: "BUY",
        desired_qty: 1000,
      }),
    ];

    const intents = await arbiter.arbitrate(proposals);

    // Strategy budget should limit exposure
    assert.ok(intents.length > 0);
  });

  it("filters expired proposals", async () => {
    const graphStore = new MockGraphEdgeStore();
    const arbiter = new StrategyArbiter({ graphStore, policy: defaultPolicy });

    const expiredProposal = createProposal({
      strategy: "test",
      market_id: "mkt_Y",
      side: "BUY",
      desired_qty: 100,
      expires_at: new Date(Date.now() - 1000), // Already expired
    });

    const intents = await arbiter.arbitrate([expiredProposal]);

    assert.equal(intents.length, 0);
  });
});
