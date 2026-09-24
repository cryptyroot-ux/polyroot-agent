/**
 * market_graph_relative_value_v1 — Relative Value via Market Graph
 *
 * Finds NEG_RISK pairs with verified edges, checks settlement logic compatibility,
 * computes executable quotes on both legs, verifies structural inconsistency > edge threshold.
 * Returns paired TradeIntent[] with atomic execution requirement.
 */
import { randomUUID } from "crypto";
import type {
  GraphEdge,
  MarketSnapshot,
  MarketFeeSettings,
  StrategyProposal,
} from "@polyroot/domain";
import type { GraphEdgeStore } from "@polyroot/data";

export interface MarketGraphRelativeValueV1Config {
  minEdgeAfterCost: number;
}

export interface MarketGraphRelativeValueV1Input {
  graphEdges: GraphEdge[];
  snapshots: Map<string, MarketSnapshot>;
  fees: MarketFeeSettings;
}

export class MarketGraphRelativeValueV1 {
  constructor(
    private graphStore: GraphEdgeStore,
    private config: MarketGraphRelativeValueV1Config,
  ) {}

  async run(
    input: MarketGraphRelativeValueV1Input,
  ): Promise<StrategyProposal[] | null> {
    const { graphEdges, snapshots, fees } = input;
    const proposals: StrategyProposal[] = [];

    // 1. Find NEG_RISK pairs with verified edges
    const negRiskEdges = graphEdges.filter(
      (e) =>
        e.relation_type === "NATIVE_NEG_RISK" &&
        e.trust_level === "VERIFIED_PLATFORM",
    );

    if (negRiskEdges.length === 0) {
      return null;
    }

    // 2. Check settlement logic compatibility (atomic No-to-other-Yes)
    // For NEG_RISK markets, they share the same condition_id and event_id
    // Settlement: buying NO on one + YES on other = risk-free if prices sum < 1 - fees

    for (const edge of negRiskEdges) {
      const marketA = snapshots.get(edge.from_market_id);
      const marketB = snapshots.get(edge.to_market_id);

      if (!marketA || !marketB) {
        continue;
      }

      // Verify both markets are NEG_RISK and share condition
      if (!marketA.is_neg_risk || !marketB.is_neg_risk) {
        continue;
      }

      if (
        marketA.condition_id !== marketB.condition_id ||
        marketA.event_id !== marketB.event_id
      ) {
        continue;
      }

      // 3. Compute executable quotes on both legs
      // For NEG_RISK: we can buy NO on A + YES on B (or vice versa)
      // The sum of NO_A + YES_B should be <= 1 - fees for arbitrage
      const yesPriceA = marketA.yes_price ?? 0;
      const noPriceA = marketA.no_price ?? 0;
      const yesPriceB = marketB.yes_price ?? 0;
      const noPriceB = marketB.no_price ?? 0;

      const takerFee = (fees.fee_taker_bps ?? 200) / 10000;

      // Check both directions
      const combo1 = noPriceA + yesPriceB + takerFee; // Buy NO on A, YES on B
      const combo2 = noPriceB + yesPriceA + takerFee; // Buy NO on B, YES on A

      // 4. Verify structural inconsistency > edge threshold
      // Edge = 1 - (sum of prices) - fees
      const edge1 = 1 - combo1;
      const edge2 = 1 - combo2;

      const bestEdge = Math.max(edge1, edge2);

      if (bestEdge < this.config.minEdgeAfterCost) {
        continue;
      }

      // Determine which direction gives better edge
      const direction = edge1 > edge2 ? "A_NO_B_YES" : "B_NO_A_YES";

      // 5. Return paired TradeIntent[] with atomic execution requirement
      const proposal = this.createProposal(
        marketA,
        marketB,
        direction,
        bestEdge,
        fees.fee_taker_bps,
        edge,
      );

      proposals.push(proposal);
    }

    return proposals.length > 0 ? proposals : null;
  }

  private createProposal(
    marketA: MarketSnapshot,
    marketB: MarketSnapshot,
    direction: "A_NO_B_YES" | "B_NO_A_YES",
    edge: number,
    takerBps: number,
    graphEdge: GraphEdge,
  ): StrategyProposal {
    const proposalId = randomUUID();

    if (direction === "A_NO_B_YES") {
      // Buy NO on A, YES on B
      const noPriceA = marketA.no_price ?? 0;
      const yesPriceB = marketB.yes_price ?? 0;

      return {
        schema_version: "1.0.0",
        proposal_id: proposalId,
        strategy: "market_graph_relative_value_v1",
        strategy_version: "1.0.0",
        strategy_params: {
          market_id_a: marketA.market_id,
          market_id_b: marketB.market_id,
          leg_a: {
            side: "NO",
            limit_price: noPriceA,
            market_id: marketA.market_id,
          },
          leg_b: {
            side: "YES",
            limit_price: yesPriceB,
            market_id: marketB.market_id,
          },
          execution_mode: "ATOMIC",
          edge_after_fees: edge,
        },
        forecast_refs: [],
        graph_refs: [graphEdge.from_market_id, graphEdge.to_market_id],
        entry_thesis: `NEG_RISK arb: NO@${noPriceA.toFixed(3)} + YES@${yesPriceB.toFixed(3)} = ${(noPriceA + yesPriceB).toFixed(3)} edge=${edge.toFixed(4)}`,
        exit_thesis:
          "Hold to resolution (risk-free) or unwind if prices revert",
        cost_assumptions: { taker_bps: takerBps },
        expected_edge_distribution: { mean: edge, std: 0.005 },
        expires_at: new Date(Date.now() + 3600000),
        reason_code: "NEG_RISK_ARBITRAGE",
      };
    } else {
      // Buy NO on B, YES on A
      const noPriceB = marketB.no_price ?? 0;
      const yesPriceA = marketA.yes_price ?? 0;

      return {
        schema_version: "1.0.0",
        proposal_id: proposalId,
        strategy: "market_graph_relative_value_v1",
        strategy_version: "1.0.0",
        strategy_params: {
          market_id_a: marketA.market_id,
          market_id_b: marketB.market_id,
          leg_a: {
            side: "YES",
            limit_price: yesPriceA,
            market_id: marketA.market_id,
          },
          leg_b: {
            side: "NO",
            limit_price: noPriceB,
            market_id: marketB.market_id,
          },
          execution_mode: "ATOMIC",
          edge_after_fees: edge,
        },
        forecast_refs: [],
        graph_refs: [graphEdge.from_market_id, graphEdge.to_market_id],
        entry_thesis: `NEG_RISK arb: YES@${yesPriceA.toFixed(3)} + NO@${noPriceB.toFixed(3)} = ${(yesPriceA + noPriceB).toFixed(3)} edge=${edge.toFixed(4)}`,
        exit_thesis:
          "Hold to resolution (risk-free) or unwind if prices revert",
        cost_assumptions: { taker_bps: takerBps },
        expected_edge_distribution: { mean: edge, std: 0.005 },
        expires_at: new Date(Date.now() + 3600000),
        reason_code: "NEG_RISK_ARBITRAGE",
      };
    }
  }
}
