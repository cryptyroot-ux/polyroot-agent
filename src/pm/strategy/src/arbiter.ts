/**
 * Strategy Arbiter — Deduplication + Netting via Market Graph
 * 
 * Consumes StrategyProposal[] from multiple strategies, produces bounded TradeIntent[]
 * after deduplication/netting using Market Graph relationships:
 * - NEG_RISK: net opposite sides
 * - COMPLEMENT: sum exposures
 * - CORRELATED: apply correlation discount
 */
import { randomUUID } from "crypto";
import type {
  StrategyProposal,
  TradeIntent,
  GraphEdge,
  RiskPolicy,
  IntentPurpose,
} from "@polyroot/domain";
import type { GraphEdgeStore } from "@polyroot/data";

export interface StrategyArbiterConfig {
  graphStore: GraphEdgeStore;
  policy: RiskPolicy;
}

interface NormalizedProposal {
  proposal: StrategyProposal;
  marketId: string;
  side: "BUY" | "SELL";
  qty: number;
  purpose: IntentPurpose;
}

interface MarketExposure {
  marketId: string;
  netQty: number; // positive = net BUY, negative = net SELL
  proposals: NormalizedProposal[];
}

export class StrategyArbiter {
  private graphStore: GraphEdgeStore;
  private policy: RiskPolicy;

  constructor(config: StrategyArbiterConfig) {
    this.graphStore = config.graphStore;
    this.policy = config.policy;
  }

  async arbitrate(proposals: StrategyProposal[]): Promise<TradeIntent[]> {
    // Step 1: Filter expired/stale/invalid
    const validProposals = this.filterValidProposals(proposals);

    // Step 2: Normalize to economic exposure
    const normalized = await this.normalizeProposals(validProposals);

    // Step 3: Deduplicate via Market Graph
    const nettedExposures = await this.deduplicateViaGraph(normalized);

    // Step 4: Apply strategy budgets and risk limits
    const boundedExposures = this.applyBudgets(nettedExposures);

    // Step 5: Emit bounded TradeIntent[]
    return this.emitIntents(boundedExposures);
  }

  private filterValidProposals(proposals: StrategyProposal[]): StrategyProposal[] {
    const now = new Date();
    return proposals.filter((p) => {
      // Filter expired
      if (p.expires_at && new Date(p.expires_at) <= now) {
        return false;
      }
      // Filter proposals without market_id
      if (!p.strategy_params || typeof p.strategy_params !== "object" || !("market_id" in p.strategy_params)) {
        return false;
      }
      return true;
    });
  }

  private async normalizeProposals(
    proposals: StrategyProposal[],
  ): Promise<NormalizedProposal[]> {
    const normalized: NormalizedProposal[] = [];

    for (const proposal of proposals) {
      if (!proposal.strategy_params || typeof proposal.strategy_params !== "object") {
        continue;
      }
      const params = proposal.strategy_params as Record<string, unknown>;
      const marketId = params["market_id"] as string;
      const side = (params["side"] as "BUY" | "SELL") ?? "BUY";
      const desiredQty = (params["desired_qty"] as number) ?? 0;
      const purpose = (params["purpose"] as IntentPurpose) ?? "ENTRY";

      if (marketId && desiredQty > 0) {
        normalized.push({
          proposal,
          marketId,
          side,
          qty: desiredQty,
          purpose,
        });
      }
    }

    return normalized;
  }

  private async deduplicateViaGraph(
    normalized: NormalizedProposal[],
  ): Promise<MarketExposure[]> {
    // Group by market
    const byMarket = new Map<string, NormalizedProposal[]>();
    for (const np of normalized) {
      const group = byMarket.get(np.marketId) ?? [];
      group.push(np);
      byMarket.set(np.marketId, group);
    }

    // For each market, sum exposures by side
    const exposures = new Map<string, MarketExposure>();
    for (const [marketId, proposals] of byMarket) {
      let netQty = 0;
      for (const p of proposals) {
        if (p.side === "BUY") netQty += p.qty;
        else netQty -= p.qty;
      }
      exposures.set(marketId, { marketId, netQty, proposals });
    }

    // Apply graph-based deduplication
    const processed = new Set<string>();
    const result: MarketExposure[] = [];

    for (const [marketId, exposure] of exposures) {
      if (processed.has(marketId)) continue;

      const edges = await this.graphStore.getEdgesByMarket(marketId);
      const negRiskEdges = edges.filter(
        (e: GraphEdge) => e.relation_type === "NATIVE_NEG_RISK" && e.trust_level === "VERIFIED_PLATFORM",
      );
      const complementEdges = edges.filter((e: GraphEdge) => e.relation_type === "COMPLEMENT");
      const correlatedEdges = edges.filter((e: GraphEdge) => e.relation_type === "CORRELATED");

      // Handle NEG_RISK: net with paired market
      let netQty = exposure.netQty;
      let relatedMarketId: string | null = null;

      for (const edge of negRiskEdges) {
        const otherMarket =
          edge.from_market_id === marketId ? edge.to_market_id : edge.from_market_id;
        const otherExposure = exposures.get(otherMarket);

        if (otherExposure && !processed.has(otherMarket)) {
          // NEG_RISK pairs have opposite exposure directions
          // Net them: BUY on A + SELL on B = net exposure
          netQty += otherExposure.netQty;
          relatedMarketId = otherMarket;
          processed.add(otherMarket);
        }
      }

      // Handle COMPLEMENT: sum with complementary market
      for (const edge of complementEdges) {
        const otherMarket =
          edge.from_market_id === marketId ? edge.to_market_id : edge.from_market_id;
        const otherExposure = exposures.get(otherMarket);

        if (otherExposure && !processed.has(otherMarket)) {
          // COMPLEMENT: same direction, sum exposures
          netQty += otherExposure.netQty;
          processed.add(otherMarket);
        }
      }

      // Handle CORRELATED: apply correlation discount
      let correlationDiscount = 1.0;
      for (const edge of correlatedEdges) {
        if (edge.confidence !== undefined) {
          // Correlation reduces effective diversification
          correlationDiscount = Math.min(correlationDiscount, 1 - edge.confidence * 0.5);
        }
      }
      netQty = Math.round(netQty * correlationDiscount);

      processed.add(marketId);

      if (netQty !== 0) {
        result.push({
          marketId: relatedMarketId ?? marketId,
          netQty,
          proposals: [...exposure.proposals],
        });
      }
    }

    return result;
  }

  private applyBudgets(exposures: MarketExposure[]): MarketExposure[] {
    const maxOrderQty = Math.floor(
      (this.policy.capital_usd_cap ?? 10000) * this.policy.max_order_pct,
    );
    const maxMarketQty = Math.floor(
      (this.policy.capital_usd_cap ?? 10000) * this.policy.max_market_pct,
    );

    return exposures.map((exp) => {
      let netQty = exp.netQty;

      // Apply per-order cap
      if (Math.abs(netQty) > maxOrderQty) {
        netQty = netQty > 0 ? maxOrderQty : -maxOrderQty;
      }

      // Apply per-market cap
      if (Math.abs(netQty) > maxMarketQty) {
        netQty = netQty > 0 ? maxMarketQty : -maxMarketQty;
      }

      return { ...exp, netQty };
    });
  }

  private emitIntents(exposures: MarketExposure[]): TradeIntent[] {
    const intents: TradeIntent[] = [];

    for (const exp of exposures) {
      if (exp.netQty === 0) continue;

      const side: "BUY" | "SELL" = exp.netQty > 0 ? "BUY" : "SELL";
      const qty = Math.abs(exp.netQty);

      // Use the first proposal's strategy as reference
      const strategy = exp.proposals[0]?.proposal?.strategy ?? "arbitrated";
      const proposalId = exp.proposals[0]?.proposal?.proposal_id ?? randomUUID();

      intents.push({
        schema_version: "1.0.0",
        intent_id: randomUUID(),
        dedupe_key: `arb_${proposalId}_${exp.marketId}_${side}`,
        purpose: exp.proposals[0]?.purpose ?? "ENTRY",
        market_id: exp.marketId,
        side,
        desired_qty: qty,
        strategy_ref: strategy,
        forecast_refs: exp.proposals.flatMap((p) => p.proposal.forecast_refs ?? []),
        evidence_ids: exp.proposals.flatMap((p) => p.proposal.graph_refs ?? []),
        status: "CREATED",
        created_at: new Date(),
      });
    }

    return intents;
  }
}