/**
 * @polyroot/control — Order builder.
 *
 * Builds the canonical signed order from the reserved intent + permit, always
 * clamped INSIDE the permit's reservation (share quota and cash ceiling). Every
 * clamp happens in exact integer base units (PM-LED-02); floats never inflate
 * an order past its reservation.
 *
 * The signature is produced by the injected SignerVault, which enforces its own
 * pre-sign invariants (clock, expiry, single-use, identity, quota, payload).
 */

import type {
  ExecutionPermit,
  SignedOrder,
  TradeIntent,
  VenueMode,
  WalletIdentity,
} from "@polyroot/domain";
import { SignedOrderSchema } from "@polyroot/domain";
import { cashNeededFor } from "@polyroot/risk";
import { SignerVault } from "@polyroot/signer";
import { computePayloadHash } from "@polyroot/signer";
import { decimalToBase } from "@polyroot/signer";
import { randomUUID } from "crypto";

export interface OrderBuildInput {
  intent: TradeIntent;
  permit: ExecutionPermit;
  wallet: WalletIdentity;
  venueMode: VenueMode;
  now: Date;
}

export type OrderBuildResult =
  | { ok: true; order: SignedOrder; permit: ExecutionPermit }
  | { ok: false; code: string; reason: string };

function fail(code: string, reason: string): OrderBuildResult {
  return { ok: false, code, reason };
}

export async function buildSignedOrder(
  input: OrderBuildInput,
  signer: SignerVault,
): Promise<OrderBuildResult> {
  const { intent, permit } = input;

  // 1. Price — the single source of truth for the order.
  const price = intent.limit_price ?? intent.price;
  if (price === undefined) {
    return fail("PRICE_REQUIRED", "intent must carry a limit price");
  }
  const size =
    intent.desired_qty ??
    (intent.desired_notional !== undefined
      ? intent.desired_notional / price
      : undefined);
  if (size === undefined) {
    return fail("SIZE_REQUIRED", "intent must carry a size or a notional");
  }

  // 2. Permit binding — fail closed if intent conflicts with permit (P0-7).
  const side: "BUY" | "SELL" = intent.side === "SELL" ? "SELL" : "BUY";
  if (permit.side && permit.side !== side) {
    return fail(
      "SIDE_MISMATCH",
      `intent side ${side} conflicts with permit side ${permit.side}`,
    );
  }
  const priceBase = decimalToBase(price);
  if (
    (permit.price_min_base !== undefined &&
      permit.price_min_base !== null &&
      priceBase < permit.price_min_base) ||
    (permit.price_max_base !== undefined &&
      permit.price_max_base !== null &&
      priceBase > permit.price_max_base)
  ) {
    return fail(
      "PRICE_OUT_OF_BOUNDS",
      `price ${price} outside permit bounds [${permit.price_min_base}, ${permit.price_max_base}]`,
    );
  }
  if (permit.market_id && permit.market_id !== intent.market_id) {
    return fail(
      "MARKET_MISMATCH",
      `intent market ${intent.market_id} conflicts with permit market ${permit.market_id}`,
    );
  }
  const orderType = (intent.order_type ?? "LIMIT") as
    "LIMIT" | "POST_ONLY" | "FOK" | "IOC";
  if (
    permit.allowed_order_style.length > 0 &&
    !permit.allowed_order_style.includes(orderType)
  ) {
    return fail(
      "STYLE_NOT_ALLOWED",
      `order type ${orderType} not in permit allowed styles: ${permit.allowed_order_style.join(",")}`,
    );
  }

  // 3. Clamp inside the permit reservation, in exact base units.
  let sizeBase = decimalToBase(size);
  const maxQtyBase = decimalToBase(permit.max_qty);
  if (sizeBase > maxQtyBase) sizeBase = maxQtyBase;

  const maxCashBase = decimalToBase(permit.max_cash);
  const cashBase = cashNeededFor(sizeBase, priceBase);
  if (cashBase > maxCashBase) {
    // Scale the share count down to exactly fit the cash ceiling: shares =
    // (cash * 1e6) / price (integer floor), never overflowing the reservation.
    sizeBase = (maxCashBase * 1_000_000n) / priceBase;
  }
  if (sizeBase <= 0n) {
    return fail("SIZE_ZERO", "clamped order size collapsed to zero");
  }

  // 4. Sign the canonical action with the exact clamped amount.
  const orderId = randomUUID();
  const request = {
    schema_version: "1.1",
    action: "ORDER_SUBMIT" as const,
    permit,
    wallet: input.wallet,
    amountBase: sizeBase,
    actionId: orderId,
    intentId: permit.intent_id,
    marketContext: intent.market_id,
    venueMode: input.venueMode,
    now: input.now,
    side,
    priceBase,
    policyHash: permit.policy_hash,
    quoteId: permit.quote_id,
    expectedChainId: input.wallet.chain_id,
    expectedLeaseEpoch: permit.lease_epoch,
    payloadHash: computePayloadHash({
      schema_version: "1.1",
      action: "ORDER_SUBMIT" as const,
      permit,
      wallet: input.wallet,
      amountBase: sizeBase,
      actionId: orderId,
      intentId: permit.intent_id,
      marketContext: intent.market_id,
      venueMode: input.venueMode,
      now: input.now,
      side,
      priceBase,
      policyHash: permit.policy_hash,
      quoteId: permit.quote_id,
      expectedChainId: input.wallet.chain_id,
      expectedLeaseEpoch: permit.lease_epoch,
      payloadHash: "",
    }),
  };
  const signed = await signer.sign(request);
  if (!signed.ok) {
    return fail(signed.code, signed.reason);
  }

  // 5. Assemble and validate the signed order.
  const order: SignedOrder = {
    schema_version: "1.1",
    order_id: orderId,
    market_id: intent.market_id,
    side,
    price: Number(priceBase) / 1_000_000,
    size: Number(sizeBase) / 1_000_000,
    fee_rate_bps: 0,
    signature: signed.signature,
    signer: input.wallet.signer_address,
    signed_at: signed.signed_at,
    decision_id: permit.decision_id,
    permit_id: permit.permit_id,
    order_type: orderType,
  };
  const parsed = SignedOrderSchema.safeParse(order);
  if (!parsed.success) {
    return fail("ORDER_INVALID", parsed.error.message);
  }

  return { ok: true, order: parsed.data, permit };
}

export type { ExecutionPermit, SignedOrder, TradeIntent, WalletIdentity };
