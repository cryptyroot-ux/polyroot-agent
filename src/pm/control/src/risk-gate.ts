/**
 * @polyroot/control — Risk gate.
 *
 * Validates an intent against the commissioned risk policy BEFORE any money
 * moves, and — when everything passes — reserves funds atomically inside the
 * Money Kernel (PR-RISK-01..08), producing the matched ExecutionPermit.
 *
 * The gate itself computes no float money: exposure checks run in USD-decimal
 * space (policy dimensions), while the kernel reservation runs in exact integer
 * base units via `decimalToBase` / `cashNeededFor`.
 */

import type {
  ExecutionPermit,
  RiskDecision,
  RiskPolicy,
  TradeIntent,
  VenueMode,
  WalletIdentity,
} from "@polyroot/domain";
import { RiskDecisionSchema, RiskPolicySchema, TradeIntentSchema } from "@polyroot/domain";
import { MoneyKernel, cashNeededFor } from "@polyroot/risk";
import { decimalToBase } from "@polyroot/signer";
import { ulid } from "ulid";

export interface RiskGateInput {
  intent: TradeIntent;
  policy: RiskPolicy;
  wallet: WalletIdentity;
  venueMode: VenueMode;
  leaseEpoch: number;
  now: Date;
  policyHash: string;
  /** Current committed exposure for this market (USD). */
  currentMarketExposureUsd?: number;
  /** Current committed exposure across the whole portfolio (USD). */
  currentPortfolioExposureUsd?: number;
  /** Explicit commissioned capital basis, used when the policy has no cap. */
  capitalBasisUsd?: number;
}

export type RiskGateResult =
  | {
      ok: true;
      decision: RiskDecision;
      permit: ExecutionPermit;
      reservationId: string;
    }
  | { ok: false; code: string; reason: string };

function fail(code: string, reason: string): RiskGateResult {
  return { ok: false, code, reason };
}

export async function validateAndReserve(
  input: RiskGateInput,
  kernel: MoneyKernel,
): Promise<RiskGateResult> {
  // 1. Parse hard type boundaries — never gate on untyped JSON.
  const policyParsed = RiskPolicySchema.safeParse(input.policy);
  if (!policyParsed.success) {
    return fail("POLICY_INVALID", "risk policy schema invalid");
  }
  const intentParsed = TradeIntentSchema.safeParse(input.intent);
  if (!intentParsed.success) {
    return fail("INTENT_INVALID", "trade intent schema invalid");
  }
  const policy = policyParsed.data;
  const intent = intentParsed.data;

  // 2. Capital basis: the commissioned cap, else an explicit override, else —.
  const capitalUsd =
    policy.capital_usd_cap ?? input.capitalBasisUsd ?? null;
  if (capitalUsd === null) {
    return fail(
      "NO_CAPITAL_BASIS",
      "no commissioned capital basis; refusing to compute % limits",
    );
  }

  // 3. Order dimensions (USD-decimal domain view).
  const price = intent.limit_price ?? intent.price;
  if (price === undefined) {
    return fail("PRICE_REQUIRED", "intent must carry a limit price");
  }
  const size =
    intent.desired_qty ?? (intent.desired_notional !== undefined ? intent.desired_notional / price : undefined);
  if (size === undefined) {
    return fail("SIZE_REQUIRED", "intent must carry a size or a notional");
  }
  const orderNotional = size * price;

  // 4. Policy percentage limits (percentages of the commissioned capital).
  if (orderNotional > capitalUsd * policy.max_order_pct) {
    return fail(
      "ORDER_PCT_EXCEEDED",
      `order ${orderNotional} exceeds max_order_pct of capital ${policy.max_order_pct}`,
    );
  }
  const marketExposure = (input.currentMarketExposureUsd ?? 0) + orderNotional;
  if (marketExposure > capitalUsd * policy.max_market_pct) {
    return fail(
      "MARKET_PCT_EXCEEDED",
      `market exposure ${marketExposure} exceeds max_market_pct of capital ${policy.max_market_pct}`,
    );
  }
  const portfolioExposure =
    (input.currentPortfolioExposureUsd ?? 0) + orderNotional;
  if (portfolioExposure > capitalUsd * policy.max_portfolio_pct) {
    return fail(
      "PORTFOLIO_PCT_EXCEEDED",
      `portfolio exposure ${portfolioExposure} exceeds max_portfolio_pct of capital ${policy.max_portfolio_pct}`,
    );
  }

  // 5. Exact reservation in base units, atomic with the permit (PR-RISK-03).
  const sizeBase = decimalToBase(size);
  const priceBase = decimalToBase(price);
  const maxCashBase = cashNeededFor(sizeBase, priceBase);
  const decisionId = ulid();

  const reserved = await kernel.reserve({
    decisionId,
    intentId: intent.intent_id,
    account: input.wallet.funder,
    asset: "pUSD",
    amountSharesBase: sizeBase,
    maxCashBase,
    perSharePriceBase: priceBase,
    policy,
    policyHash: input.policyHash,
    walletType: input.wallet.wallet_type,
    venueMode: input.venueMode,
    leaseEpoch: input.leaseEpoch,
    now: input.now,
  });

  if (!reserved.ok) {
    return fail(reserved.code, reserved.reason);
  }

  const permit = reserved.permit;
  const decision: RiskDecision = {
    schema_version: "1.1",
    decision_id: decisionId,
    intent_id: intent.intent_id,
    status: "ACCEPTED",
    reservation_ids: permit.reservation_ids,
    reservation_id: permit.reservation_ids[0],
    max_qty: permit.max_qty,
    max_cash: permit.max_cash,
    allowed_order_style: permit.allowed_order_style,
    reason_codes: [],
    venue_mode: input.venueMode,
    ledger_version: permit.ledger_version,
    policy_version: permit.policy_version,
    risk_metrics: {
      portfolio_impact: orderNotional,
      market_impact: orderNotional,
    },
    decided_at: input.now,
  };
  const decisionParsed = RiskDecisionSchema.safeParse(decision);
  if (!decisionParsed.success) {
    await kernel.release(input.wallet.funder, "pUSD", maxCashBase);
    return fail("DECISION_INVALID", "risk decision schema invalid");
  }

  return { ok: true, decision: decisionParsed.data, permit, reservationId: reserved.reservationId };
}

export type { ExecutionPermit, RiskDecision, RiskPolicy, TradeIntent, WalletIdentity };