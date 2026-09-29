/**
 * @polyroot/strategy — QuoteEngine: Adjusts intent quotes based on order book and fees.
 *
 * Ensures the target edge is maintained after accounting for:
 * - Bid/ask spread
 * - Maker/taker fees
 * - Adverse selection risk
 * - Minimum size constraints
 */
import type { TradeIntent } from "@polyroot/domain";

export interface QuoteEngineConfig {
  minEdgeAfterCost: number;
  maxSlippageAbs: number;
  makerFeeBps: number;
  takerFeeBps: number;
}

export interface AdjustedQuote {
  price: number;
  size: number;
  edgeAfterCost: number;
  valid: boolean;
  reason?: string;
}

export class QuoteEngine {
  constructor(private readonly config: QuoteEngineConfig) {}

  /**
   * Adjust the quote based on current order book state.
   * Returns an adjusted quote or marks as invalid if edge cannot be maintained.
   *
   * Reference-price rule (fixed 2026-09-29): the book price must be the
   * INTENT'S OWN token side (YES→yes_price, NO→no_price). The old code
   * compared BUY/YES intents against no_price, inverting every edge sign.
   * A bare BUY/SELL without a token side cannot be priced — invalid
   * (fail-closed) instead of guessing the token.
   */
  adjustQuote(
    intent: TradeIntent,
    book: { yes_price?: number; no_price?: number; depth?: number },
  ): AdjustedQuote {
    const { price, size, side } = intent;
    const tokenSide = side === "YES" ? "YES" : side === "NO" ? "NO" : null;
    // Ensure price and size are defined
    const intentPrice = price ?? 0;
    const intentSize = size ?? 0;

    if (!tokenSide) {
      return {
        price: intentPrice,
        size: intentSize,
        edgeAfterCost: -1,
        valid: false,
        reason: "SIDE_AMBIGUOUS",
      };
    }
    const rawBookPrice =
      tokenSide === "YES" ? book.yes_price : book.no_price;
    const bookPrice = rawBookPrice ?? 0;

    if (!bookPrice || bookPrice <= 0) {
      return {
        price: intentPrice,
        size: intentSize,
        edgeAfterCost: -1,
        valid: false,
        reason: "NO_BOOK_PRICE",
      };
    }

    // Calculate edge after fees: our valuation minus the market cost,
    // both on the intent's own token side.
    const takerFee = this.config.takerFeeBps / 10000;
    const rawEdge = intentPrice - bookPrice;
    const edgeAfterCost = rawEdge - takerFee;

    // Check minimum edge
    if (edgeAfterCost < this.config.minEdgeAfterCost) {
      return {
        price: intentPrice,
        size: intentSize,
        edgeAfterCost,
        valid: false,
        reason: "MIN_EDGE_UNMET",
      };
    }

    // Honest depth: never quote more shares than rest at the touch —
    // the excess would walk the book (unmodeled slippage). Scale down
    // and say so; zero/unknown depth leaves size untouched (fail-open
    // on missing data, the edge gate above already passed).
    let finalSize = intentSize;
    let depthNote: string | undefined;
    const depth = book.depth ?? 0;
    if (depth > 0 && intentSize > depth) {
      finalSize = depth;
      depthNote = "DEPTH_SCALED";
    }

    // Check slippage against depth
    const slippage = Math.abs(intentPrice - bookPrice);
    if (slippage > this.config.maxSlippageAbs) {
      // Clamp to max slippage
      const clampedPrice = Math.min(
        intentPrice,
        bookPrice + this.config.maxSlippageAbs,
      );
      const clampedEdge = clampedPrice - bookPrice;
      const clampedEdgeAfterCost = clampedEdge - takerFee;

      return {
        price: clampedPrice,
        size: finalSize,
        edgeAfterCost: clampedEdgeAfterCost,
        valid: clampedEdgeAfterCost >= this.config.minEdgeAfterCost,
        reason:
          clampedEdgeAfterCost >= this.config.minEdgeAfterCost
            ? depthNote ?? "SLIPPAGE_CLAMPED"
            : "MIN_EDGE_AFTER_CLAMP",
      };
    }

    return {
      price: intentPrice,
      size: finalSize,
      edgeAfterCost,
      valid: true,
      ...(depthNote ? { reason: depthNote } : {}),
    };
  }
}
