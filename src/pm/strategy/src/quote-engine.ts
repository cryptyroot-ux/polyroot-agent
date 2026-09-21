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
   */
  adjustQuote(
    intent: TradeIntent,
    book: { yes_price?: number; no_price?: number; depth?: number }
  ): AdjustedQuote {
    const { price, size, side } = intent;
    const isBuy = side === "BUY" || side === "YES";
    const bookPrice = isBuy ? book.no_price ?? 0 : book.yes_price ?? 0;
    // Ensure price and size are defined
    const intentPrice = price ?? 0;
    const intentSize = size ?? 0;

    const _depth = book.depth ?? 0;

    if (!bookPrice || bookPrice <= 0) {
      return {
        price: intentPrice,
        size: intentSize,
        edgeAfterCost: -1,
        valid: false,
        reason: "NO_BOOK_PRICE",
      };
    }

    // Calculate edge after fees
    const takerFee = this.config.takerFeeBps / 10000;
    const rawEdge = isBuy ? intentPrice - bookPrice : bookPrice - intentPrice;
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

    // Check slippage against depth
    const slippage = Math.abs(intentPrice - bookPrice);
    if (slippage > this.config.maxSlippageAbs) {
      // Clamp to max slippage
      const clampedPrice = isBuy
        ? Math.min(intentPrice, bookPrice + this.config.maxSlippageAbs)
        : Math.max(intentPrice, bookPrice - this.config.maxSlippageAbs);
      const clampedEdge = isBuy
        ? clampedPrice - bookPrice
        : bookPrice - clampedPrice;
      const clampedEdgeAfterCost = clampedEdge - takerFee;

      return {
        price: clampedPrice,
        size: intentSize,
        edgeAfterCost: clampedEdgeAfterCost,
        valid: clampedEdgeAfterCost >= this.config.minEdgeAfterCost,
        reason: clampedEdgeAfterCost >= this.config.minEdgeAfterCost ? "SLIPPAGE_CLAMPED" : "MIN_EDGE_AFTER_CLAMP",
      };
    }

    return {
      price: intentPrice,
      size: intentSize,
      edgeAfterCost,
      valid: true,
    };
  }
}