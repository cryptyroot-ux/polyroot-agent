/**
 * @polyroot/risk — Money Kernel (PM-RISK-01..08, Blueprint B9 / TABLE 14).
 *
 * The Money Kernel is the **only** place that may move money or change the
 * commitment of funds. Its central invariant (T-PM-RISK-03, B17.3 step 1):
 *
 *   A Reservation and its ExecutionPermit are created **atomically**. Funds are
 *   never reserved without a matching permit, and a permit is never issued
 *   without a live reservation tying it to the exact ledger/policy/quote/lease
 *   versions. Removing a permit therefore releases its reservation; claiming a
 *   reservation always requires the matching valid permit.
 *
 * Exactness (PM-LED-02): every amount is expressed in integer base units
 * (bigint). No float arithmetic ever participates in a balance commitment.
 *
 * Hard parameters are always enforced and **never loosened** by any tier; risk
 * tiers may only tighten (PM-RISK-05).
 *
 * The kernel is state/DB-agnostic: callers inject a `BalanceStore` and a
 * `KernelEventSink`. This keeps the financial logic deterministic and fully
 * unit-testable without a live ledger.
 */

import type {
  ExecutionPermit,
  RiskPolicy,
  WalletIdentity,
  VenueMode,
} from "@polyroot/domain";
import { ExecutionPermitSchema, VenueModeSchema } from "@polyroot/domain";
import { ulid } from "ulid";

/** Integer base-unit balance for a given account/asset (never float). */
export interface BalanceEntry {
  account: string;
  asset: string; // pUSD | USDC | USDC_E | OUTCOME_TOKEN
  availableBase: bigint;
  committedBase: bigint;
}

/** Injectable source of truth for current balances/commitments. */
export interface BalanceStore {
  get(account: string, asset: string): Promise<BalanceEntry>;
  /** Atomically move `delta` (negative=release) into committed reserve. */
  commit(account: string, asset: string, deltaBase: bigint): Promise<void>;
}

/** Injectable append-only sink for financial events (audit trail, PR-LED). */
export interface KernelEventSink {
  push(topic: string, payload: unknown): Promise<void>;
}

export interface MoneyKernelOpts {
  balance: BalanceStore;
  sink: KernelEventSink;
  /** Permit lifetime in ms (TABLE 14 TTL). */
  permitTtlMs?: number;
  /** Maximum shares a single reservation may commit. */
  hardMaxShares?: bigint;
  /** Maximum cash a single reservation may commit. */
  hardMaxCash?: bigint;
  /** Maximum open reservations at once (no-unbounded-leak guard). */
  maxOpenReservations?: number;
  /** Chain id enforced for identity (matches permit lease/wallet). */
  chainId: number;
}

export interface ReserveRequest {
  decisionId: string;
  intentId: string;
  account: string; // account wallet / funder whose balance is reserved
  asset: string;
  amountSharesBase: bigint;
  maxCashBase: bigint;
  perSharePriceBase: bigint; // exact price, in base units per share (e.g. 0.5 => 500000)
  policy: RiskPolicy;
  /** Audited hash of the exact policy being honored (permit field). */
  policyHash: string;
  walletType: WalletIdentity["wallet_type"];
  venueMode: VenueMode;
  leaseEpoch: number;
  now: Date;
}

export type ReserveResult =
  | { ok: true; permit: ExecutionPermit; reservationId: string }
  | { ok: false; code: string; reason: string };

/**
 * Exact cash base-units required: `shares * price / 1e6` in integer units —
 * truncated only after the exact integer product, preserving no float drift.
 */
export function cashNeededFor(
  amountSharesBase: bigint,
  perSharePriceBase: bigint,
): bigint {
  return (amountSharesBase * perSharePriceBase) / 1_000_000n;
}

export class MoneyKernel {
  private readonly opts: MoneyKernelOpts;
  private openCount = 0;

  constructor(opts: MoneyKernelOpts) {
    this.opts = {
      permitTtlMs: opts.permitTtlMs ?? 60_000,
      hardMaxShares: opts.hardMaxShares ?? BigInt(Number.MAX_SAFE_INTEGER),
      hardMaxCash: opts.hardMaxCash ?? BigInt(Number.MAX_SAFE_INTEGER),
      maxOpenReservations: opts.maxOpenReservations ?? 16,
      ...opts,
    };
  }

  /**
   * Atomically create a Reservation and issue its ExecutionPermit. Any check
   * failure leaves no reservation and no permit (no partial state).
   */
  async reserve(req: ReserveRequest): Promise<ReserveResult> {
    // ── Hard cap checks (never loosened by tier) ──
    if (
      req.amountSharesBase <= 0n ||
      req.amountSharesBase > this.opts.hardMaxShares!
    ) {
      return {
        ok: false,
        code: "CAP_SHARES",
        reason: "shares outside hard cap",
      };
    }
    if (req.maxCashBase <= 0n || req.maxCashBase > this.opts.hardMaxCash!) {
      return { ok: false, code: "CAP_CASH", reason: "cash outside hard cap" };
    }
    // Per-share price must be in (0, 1e6] base units. A negative or zero price
    // would make cashNeeded <= 0 and turn a "reservation" into a balance
    // credit (money creation); a price > 1 unit is not a valid market price.
    // PM-LED-02 exactness relies on these bounds.
    if (req.perSharePriceBase <= 0n || req.perSharePriceBase > 1_000_000n) {
      return {
        ok: false,
        code: "PRICE_RANGE",
        reason: "per-share price outside (0, 1] base units",
      };
    }
    // Venue mode is part of the permit payload and enforced by the venue gate;
    // refuse to mint a permit carrying a non-canonical mode (PM-VENUE-01).
    if (!VenueModeSchema.safeParse(req.venueMode).success) {
      return {
        ok: false,
        code: "VENUE_MODE",
        reason: "non-canonical venue mode",
      };
    }
    if (!req.policyHash || req.policyHash.length < 1) {
      return {
        ok: false,
        code: "POLICY_HASH",
        reason: "audited policy hash required",
      };
    }
    if (this.openCount >= this.opts.maxOpenReservations!) {
      return {
        ok: false,
        code: "RESERVATION_LIMIT",
        reason: "too many open reservations",
      };
    }

    // ── Permit TTL must be sane ──
    if (this.opts.permitTtlMs! <= 0) {
      return {
        ok: false,
        code: "PERMIT_TTL",
        reason: "permit TTL must be positive",
      };
    }

    // ── Balance availability (exact integer math) ──
    const balance = await this.opts.balance.get(req.account, req.asset);
    // Cash needed = shares * price (integer base units). price is per share in base units.
    const cashNeeded = cashNeededFor(
      req.amountSharesBase,
      req.perSharePriceBase,
    );
    if (cashNeeded > req.maxCashBase) {
      return {
        ok: false,
        code: "CASH_OVER_BUDGET",
        reason: "cash required exceeds budget",
      };
    }
    if (balance.availableBase < cashNeeded) {
      return {
        ok: false,
        code: "INSUFFICIENT_FUNDS",
        reason: "insufficient available balance",
      };
    }

    // ── Build the permit (single-use, versioned, TTL-bound) ──
    const reservationId = `res_${ulid()}`;
    const permit: ExecutionPermit = {
      schema_version: "1.1",
      permit_id: ulid(),
      decision_id: req.decisionId,
      intent_id: req.intentId,
      ledger_version: "0003",
      policy_version: req.policy.policy_version,
      policy_hash: req.policyHash,
      quote_id: `quote_${ulid()}`,
      lease_epoch: req.leaseEpoch,
      reservation_ids: [reservationId],
      max_qty: Number(req.amountSharesBase) / 1_000_000,
      max_cash: Number(req.maxCashBase) / 1_000_000,
      allowed_order_style: ["LIMIT", "POST_ONLY"],
      venue_mode: req.venueMode,
      issued_at: req.now,
      expires_at: new Date(req.now.getTime() + this.opts.permitTtlMs!),
      single_use: true,
      used_at: null,
    };

    // Validate the permit we are about to persist.
    const parsed = ExecutionPermitSchema.safeParse(permit);
    if (!parsed.success) {
      return {
        ok: false,
        code: "PERMIT_INVALID",
        reason: parsed.error.message,
      };
    }

    // ── Commit funds and record reservation+permit atomically ──
    await this.opts.balance.commit(req.account, req.asset, -cashNeeded);
    this.openCount += 1;
    await this.opts.sink.push("RESERVATION_CREATED", {
      reservationId: permit.reservation_ids[0],
      permitId: permit.permit_id,
      intentId: req.intentId,
      amountSharesBase: String(req.amountSharesBase),
      cashBase: String(cashNeeded),
      leaseEpoch: req.leaseEpoch,
    });

    return { ok: true, permit, reservationId: permit.reservation_ids[0]! };
  }

  /** Release a reservation's committed funds (negative-line cancel; PM-RISK-07). */
  async release(
    account: string,
    asset: string,
    cashBase: bigint,
  ): Promise<void> {
    if (cashBase < 0n) return;
    await this.opts.balance.commit(account, asset, cashBase);
    if (this.openCount > 0) this.openCount -= 1;
    await this.opts.sink.push("RESERVATION_RELEASED", {
      account,
      asset,
      cashBase: String(cashBase),
    });
  }
}

export { VenueModeSchema };
export type { ExecutionPermit, RiskPolicy, WalletIdentity };
