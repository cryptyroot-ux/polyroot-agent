/**
 * @polyroot/ledger — Incentive + builder attribution contracts
 * (CT-28 PM-PROTO-06, CT-29 PM-ECON-03).
 *
 *   CT-28 builder code/metadata — encoded builder fields travel with the
 *           order untouched, and fee/rebate accounting is computed
 *           INDEPENDENTLY of attribution: who referred the flow never
 *           changes what was paid or earned.
 *   CT-29 incentive accounting — maker rebates, LP rewards and taker
 *           incentives are separate categories with provenance; only
 *           CONFIRMED_PAID amounts in the confirmed payout asset count.
 *           Estimates never leak into confirmed books (see FT-43).
 *
 * Pure functions (no I/O).
 */

export type IncentiveCategory = "MAKER_REBATE" | "LP_REWARD" | "TAKER_INCENTIVE";

export interface AttributedOrder {
  orderId: string;
  cashBase: bigint;
  feeBase: bigint;
  builderCode?: string;
}

export interface BuilderAttribution {
  orderId: string;
  builderCode: string;
  cashBase: bigint;
  feeBase: bigint;
}

export type AttributionResult =
  | { ok: true; attribution: BuilderAttribution }
  | { ok: false; code: "BUILDER_CODE_MISSING"; reason: string };

/**
 * CT-28: attach builder attribution to an order without touching its
 * economics. Amounts are compared field-by-field: attribution metadata
 * must never alter cash or fee accounting.
 */
export function attributeBuilder(
  order: AttributedOrder,
  builderCode: string,
): AttributionResult {
  if (!builderCode) {
    return {
      ok: false,
      code: "BUILDER_CODE_MISSING",
      reason: "builder code required for attribution",
    };
  }
  return {
    ok: true,
    attribution: {
      orderId: order.orderId,
      builderCode,
      cashBase: order.cashBase,
      feeBase: order.feeBase,
    },
  };
}

export type PayoutState = "EXPECTED" | "CONFIRMED_PAID";

export interface IncentivePosting {
  category: IncentiveCategory;
  amountBase: bigint;
  asset: string;
  state: PayoutState;
  provenance: string;
}

export type IncentiveResult =
  | { ok: true; confirmedTotal: bigint; note: string }
  | { ok: false; code: "UNCONFIRMED_INCENTIVE"; reason: string };

/**
 * CT-29: post an incentive to the confirmed books. Only CONFIRMED_PAID
 * postings in the confirmed payout asset count; anything expected,
 * mis-categorized, or in the wrong asset is refused — estimates live in
 * the estimate ledger (FT-43), never here.
 */
export function postConfirmedIncentive(
  posting: IncentivePosting,
  confirmedAsset: string,
  confirmedTotal: bigint,
): IncentiveResult {
  if (posting.state !== "CONFIRMED_PAID") {
    return {
      ok: false,
      code: "UNCONFIRMED_INCENTIVE",
      reason: `category ${posting.category} is ${posting.state}, not CONFIRMED_PAID`,
    };
  }
  if (posting.asset !== confirmedAsset) {
    return {
      ok: false,
      code: "UNCONFIRMED_INCENTIVE",
      reason: `payout asset ${posting.asset} is not the confirmed asset ${confirmedAsset}`,
    };
  }
  if (posting.amountBase < 0n) {
    return {
      ok: false,
      code: "UNCONFIRMED_INCENTIVE",
      reason: "incentive amount must be non-negative",
    };
  }
  return {
    ok: true,
    confirmedTotal: confirmedTotal + posting.amountBase,
    note: `${posting.category} confirmed in ${confirmedAsset}`,
  };
}
