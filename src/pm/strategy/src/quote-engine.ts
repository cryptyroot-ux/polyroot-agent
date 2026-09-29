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

export interface MakerQuote {
  /** Resting limit price (never crosses the touch). */
  price: number;
  valid: boolean;
  reason:
    | "IMPROVE_BID"
    | "JOIN_BID"
    | "IMPROVE_ASK"
    | "JOIN_ASK"
    | "CROSSED_BOOK"
    | "BAD_INPUT";
}

export class QuoteEngine {
  constructor(private readonly config: QuoteEngineConfig) {}

  /**
   * Post-only (maker) quote inside the spread: improves the touch by one
   * tick when the spread allows, otherwise joins the touch. Never crosses —
   * a crossing "maker" order executes as a taker and pays taker fees, which
   * is exactly the cost this quoter exists to avoid. Maker fee is $0
   * (+rebates on some categories), so no fee is subtracted here.
   *
   * Research primitive for now: validated in unit tests, live rollout
   * pending a shadow A/B that measures maker fill rates before risking
   * real queue position. NOT wired into any entry path.
   */
  makerQuote(
    side: "BUY" | "SELL",
    book: { bid?: number; ask?: number },
    tickSize = 0.01,
  ): MakerQuote {
    const bad = (reason: MakerQuote["reason"]): MakerQuote => ({
      price: NaN,
      valid: false,
      reason,
    });
    if (side !== "BUY" && side !== "SELL") return bad("BAD_INPUT");
    const { bid, ask } = book;
    if (
      !Number.isFinite(bid) ||
      !Number.isFinite(ask) ||
      (bid as number) <= 0 ||
      (ask as number) >= 1 ||
      !Number.isFinite(tickSize) ||
      tickSize <= 0
    ) {
      return bad("BAD_INPUT");
    }
    const b = bid as number;
    const a = ask as number;
    if (a <= b) return bad("CROSSED_BOOK");
    if (side === "BUY") {
      const improved = b + tickSize;
      if (improved < a) return { price: improved, valid: true, reason: "IMPROVE_BID" };
      return { price: b, valid: true, reason: "JOIN_BID" };
    }
    const improved = a - tickSize;
    if (improved > b) return { price: improved, valid: true, reason: "IMPROVE_ASK" };
    return { price: a, valid: true, reason: "JOIN_ASK" };
  }

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
