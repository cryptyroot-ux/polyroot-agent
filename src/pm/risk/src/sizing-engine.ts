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
 *
 * Fixed-point precision: all intermediate fractions are kept in SCALE-scaled
 * integer units so small EV values are not truncated to zero by integer division.
 */

export const SCALE = 1_000_000n;

/**
 * Fixed-point multiply: (a/SCALE) * (b/SCALE) = (a*b)/SCALE^2, returned scaled.
 */
function mulScale(a: bigint, b: bigint): bigint {
  return (a * b) / SCALE;
}

/**
 * Fixed-point divide: (a/SCALE) / (b/SCALE) = a/b, returned scaled.
 * Equivalent to (a * SCALE) / b.
 */
function divScale(a: bigint, b: bigint): bigint {
  if (b === 0n) return 0n;
  return (a * SCALE) / b;
}

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
  /** Kelly fraction used (scaled by SCALE) */
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
   *
   * Precision: edge and odds fractions are computed in SCALE-scaled fixed-point
   * so a small positive EV (e.g. 20 base units) does NOT truncate to zero.
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

    // 1. Check minimum edge threshold.
    const minEdgeThreshold = BigInt(
      Math.round(
        (policy.min_edge_per_share ?? policy.min_edge_after_cost) * 10_000,
      ),
    );
    // EV per share in basis points (price is in base units; 1 unit = 1e6 base).
    const evBps = price > 0n ? divScale(ev * 10_000n, price) : 0n;

    if (evBps <= minEdgeThreshold) {
      return {
        size: 0n,
        kellyFraction: 0n,
        edgePerShareBps: evBps,
        capped: true,
        capReason: "MIN_EDGE",
      };
    }

    // 2. Compute Kelly fraction using fixed-point to preserve precision.
    // edge = EV / price for YES, EV / (1 - price) for NO.
    const edgeDenominator = side === "YES" ? price : SCALE - price;
    const edgeFractionScaled =
      edgeDenominator > 0n ? divScale(ev, edgeDenominator) : 0n;

    // odds = (1 - price) / price for YES, price / (1 - price) for NO.
    const oddsNumerator = side === "YES" ? SCALE - price : price;
    const oddsDenominator = side === "YES" ? price : SCALE - price;
    // odds scaled by SCALE.
    const oddsScaled =
      oddsDenominator > 0n ? divScale(oddsNumerator, oddsDenominator) : 0n;

    // Kelly fraction = edge / odds (both scaled).
    const kellyFraction =
      oddsScaled > 0n ? divScale(edgeFractionScaled, oddsScaled) : 0n;

    // Apply fractional Kelly (default 25%).
    // kellyFraction is scaled by SCALE (1e6); fraction is in basis points (2500 = 25%).
    const fraction = BigInt(
      Math.round((policy.kelly_fraction ?? 0.25) * 10_000),
    );
    const fractionalKelly = (kellyFraction * fraction) / 10_000n;

    // 3. Compute max position by each cap (in base units).
    const maxOrderBps = BigInt(Math.round(policy.max_order_pct * 10_000));
    const maxMarketBps = BigInt(Math.round(policy.max_market_pct * 10_000));
    const maxPortfolioBps = BigInt(
      Math.round(policy.max_portfolio_pct * 10_000),
    );

    const maxOrderSize = mulScale(portfolioValue, maxOrderBps);
    const maxMarketSize = mulScale(portfolioValue, maxMarketBps);
    const remainingMarketCap =
      maxMarketSize > marketExposure ? maxMarketSize - marketExposure : 0n;
    const maxPortfolioSize = mulScale(portfolioValue, maxPortfolioBps);
    const remainingPortfolioCap =
      maxPortfolioSize > portfolioExposure
        ? maxPortfolioSize - portfolioExposure
        : 0n;

    // Kelly size = portfolio_value * fractional_kelly (cash allocation).
    const kellyCash = mulScale(portfolioValue, fractionalKelly);

    // Apply caps in CASH units first; then convert final cash → shares.
    let cash = kellyCash;
    let capped = false;
    let capReason: SizingResult["capReason"] = undefined;

    if (cash > maxOrderSize) {
      cash = maxOrderSize;
      capped = true;
      capReason = "ORDER_PCT";
    }
    if (cash > remainingMarketCap) {
      cash = remainingMarketCap;
      capped = true;
      capReason = "MARKET_PCT";
    }
    if (cash > remainingPortfolioCap) {
      cash = remainingPortfolioCap;
      capped = true;
      capReason = "PORTFOLIO_PCT";
    }

    // P0-12 unit proof: convert cash allocation → share quantity.
    // shareQty = cash / price (price is per-share in base units; SCALE = 1 unit).
    const size = price > 0n ? (cash * SCALE) / price : 0n;

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
