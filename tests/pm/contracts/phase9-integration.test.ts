// tests/pm/contracts/phase9-integration.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import crypto from "node:crypto";
import type { MarketSnapshot, EvidenceItem, Forecast, GraphEdge } from "@polyroot/domain";
import { type StrategyProposal, type TradeIntent, type RiskPolicy } from "@polyroot/domain";
import { StrategyArbiter } from "@polyroot/strategy";
import { EvidenceDirectionalV2 } from "@polyroot/strategy";
import { ensembleForecast, SourceRegistry, conservativeOf } from "@polyroot/intelligence";

function createTestMarketSnapshot(marketId: string): MarketSnapshot {
  return {
    schema_version: "1.0.0",
    market_id: marketId,
    event_id: `event_${marketId}`,
    condition_id: `cond_${marketId}`,
    is_neg_risk: false,
    outcome: "YES",
    last_price: 0.5,
    volume_24h: 1000,
    liquidity: 10000,
    available: true,
  };
}

function createTestEvidence(evidenceId: string): EvidenceItem {
  return {
    schema_version: "1.0.0",
    evidence_id: evidenceId,
    source_id: `source_${evidenceId}`,
    epistemic_class: "PRIMARY",
    title: `Test Evidence ${evidenceId}`,
    body: `Test body for evidence ${evidenceId}`,
    published_at: new Date(),
    relevance: 0.8,
    reliability: { score: 0.9, sample_count: 100, window: 30 },
    is_duplicate_of: undefined,
    untrusted: false,
  };
}

class MockGraphEdgeStore {
  private edges: GraphEdge[] = [];
  async upsert(edge: GraphEdge): Promise<void> {
    this.edges.push(edge);
  }
  async getEdgesByMarket(marketId: string): Promise<GraphEdge[]> {
    return this.edges.filter(
      (e) => e.from_market_id === marketId || e.to_market_id === marketId
    );
  }
  async getEdgesByType(relationType: GraphEdge["relation_type"]): Promise<GraphEdge[]> {
    return this.edges.filter((e) => e.relation_type === relationType);
  }
  async deleteMarketEdges(marketId: string): Promise<void> {
    this.edges = this.edges.filter(
      (e) => e.from_market_id !== marketId && e.to_market_id !== marketId
    );
  }
}

async function runFullPipeline(
  marketSnapshot: MarketSnapshot,
  evidence: EvidenceItem
): Promise<TradeIntent> {
  // 1. Ingest market data → build native edges
  const graphStore = new MockGraphEdgeStore();
  await graphStore.upsert({
    schema_version: "1.0.0",
    from_market_id: marketSnapshot.market_id,
    to_market_id: "mkt_related",
    relation_type: "NATIVE_EVENT_MEMBER",
    trust_level: "VERIFIED_PLATFORM",
    provenance: `polymarket:event:${marketSnapshot.event_id}`,
  });

  // 2. Fetch evidence → source registry → feature frames
  const registry = new SourceRegistry();
  const sourceRecord = {
    schema_version: "1.0.0" as const,
    source_id: evidence.source_id,
    url: `https://news.example.com/${evidence.evidence_id}`,
    epistemic_class: evidence.epistemic_class,
    domain: "news.example.com",
    source_class: "FINANCIAL_NEWS" as const,
    reliability: evidence.reliability,
    registered_at: new Date(),
  };
  // register() is async: the family id MUST be awaited into a stable
  // string. Using the raw Promise would only work by reference-equality
  // accident and violates deterministic lineage (Blueprint §6).
  const familyId = await registry.register(sourceRecord);
  assert.equal(typeof familyId, "string");

  // 3. Generate forecasts → ensemble + calibration
  const weightBooks = new Map<string, Map<string, number>>();
  const classWeights = new Map<string, number>();
  classWeights.set(familyId, 1.0);
  weightBooks.set("POLITICAL", classWeights);

  const ensembleResult = ensembleForecast({
    components: [
      { p_yes: 0.75, familyId, weight: 1.0 },
    ],
    eventClass: "POLITICAL",
    weightBooks,
    version: "v1-test",
  });

  assert.equal(ensembleResult.ok, true);
  const pRaw = ensembleResult.ok ? ensembleResult.p_yes : 0.5;
  const pCalibrated = 0.72; // Calibrated down from raw
  const pConservative = conservativeOf(pRaw, pCalibrated);

  const forecast: Forecast = {
    schema_version: "1.0.0",
    forecast_id: crypto.randomUUID(),
    market_id: marketSnapshot.market_id,
    p_raw: pRaw,
    p_calibrated: pCalibrated,
    p_conservative: pConservative,
    evidence_ids: [evidence.evidence_id],
    counterevidence_ids: [],
    created_at: new Date(),
    valid_until: new Date(Date.now() + 3600000),
  };

  // 4. evidence_directional_v2 → StrategyProposal
  const strategy = new EvidenceDirectionalV2({
    minEdgeAfterCost: 0.01,
  });

  const proposal = await strategy.run({
    forecast,
    book: { yes_price: 0.55, no_price: 0.45 },
    fees: { taker_bps: 1 },
  });

  assert.ok(proposal);
  assert.equal(proposal.strategy, "evidence_directional_v2");
  assert.equal(proposal.no_trade_code, undefined);

  // Normalize side and desired_qty for arbiter if needed
  // Note: StrategyArbiter expects side to be 'BUY' | 'SELL' and positive integer qty
  if (proposal.strategy_params) {
    if (proposal.strategy_params.side === "YES") {
      proposal.strategy_params.side = "BUY";
    } else if (proposal.strategy_params.side === "NO") {
      proposal.strategy_params.side = "SELL";
    }
    // Convert float desired_qty to integer shares for arbiter rounding
    if (typeof proposal.strategy_params.desired_qty === "number") {
      proposal.strategy_params.desired_qty = Math.max(1, Math.round(proposal.strategy_params.desired_qty * 100));
    }
  }

  // 5. Arbiter → TradeIntent
  const policy: RiskPolicy = {
    schema_version: "1.0.0",
    policy_version: "test-v1",
    execution_mode: "PAPER",
    capital_usd_cap: 10000,
    max_order_pct: 0.05,
    max_market_pct: 0.1,
    max_event_group_pct: 0.2,
    max_portfolio_pct: 0.5,
    daily_loss_stop_pct: 0.02,
    drawdown_stop_pct: 0.05,
    max_open_orders: 10,
    min_edge_after_cost: 0.01,
    book_max_age_ms: 2000,
    metadata_max_age_s: 60,
    forecast_max_age_s: 900,
    clock_skew_max_ms: 1000,
    max_slippage_abs: 0.01,
    intent_ttl_s: 30,
    risk_permit_ttl_ms: 1000,
    reconcile_interval_s: 15,
  };

  const arbiter = new StrategyArbiter({ graphStore, policy });
  const intents = await arbiter.arbitrate([proposal]);

  assert.ok(intents.length > 0, "No intents generated");
  const intent = intents[0];

  // 6. Validate intent passes risk gate properties / state
  assert.ok(intent);
  assert.equal(intent.status, "CREATED");
  assert.equal(intent.market_id, marketSnapshot.market_id);

  return intent;
}

describe("Phase 9 Integration Test", () => {
  it("full pipeline: MarketSnapshot → Graph → Forecast → Ensemble → Strategy → Intent", async () => {
    const testMarketSnapshot = createTestMarketSnapshot("mkt_phase9_test");
    const testEvidence = createTestEvidence("ev_phase9_test");

    const intent = await runFullPipeline(testMarketSnapshot, testEvidence);
    assert.ok(intent);
    assert.equal(intent.status, "CREATED");
  });

  it("syndication folding: two wire copies of one article collapse to ONE family (PM-INTEL-02)", async () => {
    const registry = new SourceRegistry();
    const parent = "https://origin.example.com/article-1";
    const famA = await registry.register({
      schema_version: "1.0.0" as const,
      source_id: "src_wire_a",
      url: "https://wire-a.example.com/article-1",
      epistemic_class: "WIRE_SERVICE" as any,
      domain: "wire-a.example.com",
      source_class: "FINANCIAL_NEWS" as const,
      syndication_parent: parent,
      reliability: { score: 0.9, sample_count: 100, window: 30 },
      registered_at: new Date(),
    } as any);
    const famB = await registry.register({
      schema_version: "1.0.0" as const,
      source_id: "src_wire_b",
      url: "https://wire-b.example.com/article-1",
      epistemic_class: "WIRE_SERVICE" as any,
      domain: "wire-b.example.com",
      source_class: "FINANCIAL_NEWS" as const,
      syndication_parent: parent,
      reliability: { score: 0.9, sample_count: 100, window: 30 },
      registered_at: new Date(),
    } as any);
    assert.equal(typeof famA, "string");
    assert.equal(famA, famB);
    // An ensemble over the two copies must count ONE effective family,
    // never two independent confirmations.
    const out = ensembleForecast({
      components: [
        { p_yes: 0.7, familyId: famA, weight: 1.0 },
        { p_yes: 0.7, familyId: famB, weight: 1.0 },
      ],
      eventClass: "POLITICAL",
      weightBooks: new Map(),
      version: "v1-test",
    });
    assert.equal(out.ok, true);
    if (out.ok) assert.equal(out.effectiveFamilyCount, 1);
  });
});
