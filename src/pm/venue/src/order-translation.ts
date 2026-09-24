/**
 * @polyroot/venue — Domain SignedOrder → CLOB limit-order translation.
 *
 * Pure function, no network. Maps our canonical order (human-unit shares,
 * probability price, opaque market id) onto the SDK `placeLimitOrder`
 * request shape. Anything that cannot be mapped exactly is refused with a
 * named code — never coerced, never rounded through float.
 */

import type { SignedOrder } from "@polyroot/domain";

export interface LimitOrderRequest {
  assetId: string;
  price: number;
  size: number;
  side: "BUY" | "SELL";
  postOnly: boolean;
}

export type TranslationResult =
  | { ok: true; request: LimitOrderRequest }
  | { ok: false; code: string; reason: string };

/** CLOB asset ids are hex or decimal token ids — never opaque labels. */
const ASSET_ID_PATTERN = /^(0x[0-9a-fA-F]+|[0-9]+)$/;

function fail(code: string, reason: string): TranslationResult {
  return { ok: false, code, reason };
}

export function translateDomainOrderToLimit(
  order: SignedOrder,
): TranslationResult {
  if (!ASSET_ID_PATTERN.test(order.market_id)) {
    return fail(
      "VENUE_MARKET_UNRESOLVED",
      `market_id ${JSON.stringify(order.market_id)} is not a CLOB asset id (hex or decimal token id)`,
    );
  }
  const style = order.order_type ?? "LIMIT";
  if (style !== "LIMIT" && style !== "POST_ONLY") {
    return fail(
      "VENUE_ORDER_TYPE_UNSUPPORTED",
      `order type ${style} has no CLOB limit-order mapping (only LIMIT and POST_ONLY translate)`,
    );
  }
  if (order.expiration !== undefined && order.expiration !== null) {
    return fail(
      "VENUE_EXPIRATION_UNSUPPORTED",
      "GTD expirations need explicit design (minimum 3-minute horizon, clock-skew buffer); refusing instead of guessing units",
    );
  }
  if (!Number.isFinite(order.price) || order.price <= 0 || order.price >= 1) {
    return fail(
      "VENUE_PRICE_INVALID",
      `price ${order.price} is outside the (0, 1) probability range`,
    );
  }
  if (!Number.isFinite(order.size) || order.size <= 0) {
    return fail(
      "VENUE_SIZE_INVALID",
      `size ${order.size} must be a positive share count`,
    );
  }
  return {
    ok: true,
    request: {
      assetId: order.market_id,
      price: order.price,
      size: order.size,
      side: order.side,
      postOnly: style === "POST_ONLY",
    },
  };
}
