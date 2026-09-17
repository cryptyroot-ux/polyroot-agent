/**
 * @polyroot/risk — Kelly Sizing Engine (PM-RISK-02, TABLE 12).
 *
 * Determines the optimal position size given edge, odds, and portfolio constraints.
 * This is the single source of truth for position sizing.
 *
 * Kelly Criterion (binary outcome):
 *   f* = edge / odds
 *
 * Fractional Kelly:
 *   f = fraction * f*  (fraction typically 0.25 for 25% Kelly)
 *
 * All amounts in base units (1e6 = $1).
 */

export interface SizingInput {
  /** EV in base units (output from EVCalculator) */
  ev: bigint;
  /** Market price (0..1, base units 1e6 = 1.0) */
  price: bigint;
  /** Side of the trade */
  side: "YES" | "NO";
  /** Current portfolio value in base units */
  portfolioValue: bigint;
  /** Current market exposure in base units */
  marketExposure: bigint;
  /** Current portfolio exposure in base units */
  portfolioExposure: bigint;
  /** Risk policy with all caps */
  policy: {
    max_order_pct: number;
    max_market_pct: number;
    max_portfolio_pct: number;
    min_edge_after_cost: number;
    min_edge_per_share?: number;
    kelly_fraction?: number;
  };
}

export interface SizingResult {
  /** Optimal size in base units (shares * 1e6) */
  size: bigint;
  /** Kelly fraction used */
  kellyFraction: bigint;
  /** Edge per share in basis points */
  edgePerShareBps: bigint;
  /** Whether sizing was capped by any limit */
  capped: boolean;
  /** Which cap was hit (if any) */
  capReason:
    | "ORDER_PCT"
    | "MARKET_PCT"
    | "PORTFOLIO_PCT"
    | "MIN_EDGE"
    | "ZERO_SIZE"
    | undefined;
}

export class SizingEngine {
  /**
   * Compute the optimal position size given edge, price, and portfolio constraints.
   */
  static size(input: SizingInput): SizingResult {
    const {
      ev,
      price,
      side,
      portfolioValue,
      marketExposure,
      portfolioExposure,
      policy,
    } = input;

    // 1. Check minimum edge threshold (use min_edge_per_share if set, else min_edge_after_cost)
    const minEdgeThreshold = BigInt(
      Math.round(
        (policy.min_edge_per_share ?? policy.min_edge_after_cost) * 10_000,
      ),
    );
    const evBps = price > 0n ? (ev * 10_000n) / price : 0n;

    if (evBps <= minEdgeThreshold) {
      return {
        size: 0n,
        kellyFraction: 0n,
        edgePerShareBps: evBps,
        capped: true,
        capReason: "MIN_EDGE",
      };
    }

    // 2. Compute Kelly fraction
    // edge = EV / price (for YES) or EV / (1 - price) for NO
    const edgeNumerator = ev;
    const edgeDenominator = side === "YES" ? price : 1_000_000n - price;
    const edgeFraction =
      edgeDenominator > 0n ? edgeNumerator / edgeDenominator : 0n;

    // odds = (1 - price) / price for YES, price / (1 - price) for NO
    const oddsNumerator = side === "YES" ? 1_000_000n - price : price;
    const oddsDenominator = side === "YES" ? price : 1_000_000n - price;
    const oddsFraction =
      oddsDenominator > 0n ? oddsNumerator / oddsDenominator : 0n;

    // Kelly fraction = edge / odds (scaled by 1e6)
    const kellyFraction =
      oddsFraction > 0n ? (edgeFraction * 1_000_000n) / oddsFraction : 0n;

    // Apply fractional Kelly (default 25%)
    const fraction = BigInt(
      Math.round((policy.kelly_fraction ?? 0.25) * 10_000),
    );
    const fractionalKelly = (kellyFraction * fraction) / 10_000n;

    // 3. Compute max position by each cap (in shares base units)
    const maxOrderBps = BigInt(Math.round(policy.max_order_pct * 10_000));
    const maxMarketBps = BigInt(Math.round(policy.max_market_pct * 10_000));
    const maxPortfolioBps = BigInt(
      Math.round(policy.max_portfolio_pct * 10_000),
    );

    const maxOrderSize = (portfolioValue * maxOrderBps) / 10_000n;
    const maxMarketSize = (portfolioValue * maxMarketBps) / 10_000n;
    const remainingMarketCap =
      maxMarketSize > marketExposure ? maxMarketSize - marketExposure : 0n;
    const maxPortfolioSize = (portfolioValue * maxPortfolioBps) / 10_000n;
    const remainingPortfolioCap =
      maxPortfolioSize > portfolioExposure
        ? maxPortfolioSize - portfolioExposure
        : 0n;

    // Kelly size = portfolio_value * fractional_kelly
    const kellySize = (portfolioValue * fractionalKelly) / 1_000_000n;

    // Take the minimum of all constraints
    let size = kellySize;
    let capped = false;
    let capReason: SizingResult["capReason"] = undefined;

    if (size > maxOrderSize) {
      size = maxOrderSize;
      capped = true;
      capReason = "ORDER_PCT";
    }
    if (size > remainingMarketCap) {
      size = remainingMarketCap;
      capped = true;
      capReason = "MARKET_PCT";
    }
    if (size > remainingPortfolioCap) {
      size = remainingPortfolioCap;
      capped = true;
      capReason = "PORTFOLIO_PCT";
    }

    if (size <= 0n) {
      return {
        size: 0n,
        kellyFraction: 0n,
        edgePerShareBps: evBps,
        capped: true,
        capReason: "ZERO_SIZE",
      };
    }

    return {
      size,
      kellyFraction: fractionalKelly,
      edgePerShareBps: evBps,
      capped,
      capReason,
    };
  }
}

export function pctToBps(pct: number): bigint {
  return BigInt(Math.round(pct * 10_000));
}
