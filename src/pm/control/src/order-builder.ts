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
import { ulid } from "ulid";

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

  // 2. Clamp inside the permit reservation, in exact base units.
  const priceBase = decimalToBase(price);
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

  // 3. Venue side: SELL intents stay SELL; YES/NO/BUY buy the quoted token.
  const side: "BUY" | "SELL" = intent.side === "SELL" ? "SELL" : "BUY";

  // 4. Sign the canonical action with the exact clamped amount.
  const orderId = ulid();
  const request = {
    schema_version: "1.1",
    action: "ORDER_SUBMIT" as const,
    permit,
    wallet: input.wallet,
    amountBase: sizeBase,
    actionId: orderId,
    marketContext: intent.market_id,
    venueMode: input.venueMode,
    now: input.now,
    payloadHash: computePayloadHash({
      schema_version: "1.1",
      action: "ORDER_SUBMIT" as const,
      permit,
      wallet: input.wallet,
      amountBase: sizeBase,
      actionId: orderId,
      marketContext: intent.market_id,
      venueMode: input.venueMode,
      now: input.now,
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
  };
  const parsed = SignedOrderSchema.safeParse(order);
  if (!parsed.success) {
    return fail("ORDER_INVALID", parsed.error.message);
  }

  return { ok: true, order: parsed.data, permit };
}

export type { ExecutionPermit, SignedOrder, TradeIntent, WalletIdentity };