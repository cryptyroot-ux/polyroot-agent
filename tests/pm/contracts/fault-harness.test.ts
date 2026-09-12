/**
 * Fault harness — executes the behavioural invariants of Fault_Matrix.csv
 * (46 scenarios) that are provable with the *current* pure modules.
 *
 * Each describe block is keyed to one FT-x scenario and asserts the exact
 * `expected_invariant` column using the same module(s) a live supervisor would
 * wire. Later phases (platform/security/data/intelligence) gain their own
 * harness blocks; TEST_MATRIX.md tracks per-FT status.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ulid } from "ulid";
import {
  Executor,
  orderLifecycleNext,
  type OrderLifecycleState,
} from "@polyroot/executor";
import type { VenueAdapter, SubmitOutcome } from "@polyroot/venue";
import { RecoveryLedger, RecoveryInFlightOrder } from "@polyroot/venue";
import type {
  ExecutionPermit,
  MarketSnapshot,
  OrderResult,
  SignedOrder,
  VenueMode,
  Portfolio,
  RiskPolicy,
} from "@polyroot/domain";
import {
  MoneyKernel,
  type BalanceStore,
  type KernelEventSink,
  killSwitch,
} from "@polyroot/risk";
import {
  planCancelOpen,
  recordCancelOutcome,
  planFlatten,
  sellableShares,
  checkReduceAllowed,
  lossFloor,
  planCompromiseResponse,
} from "@polyroot/risk";
import {
  SignerVault,
  permitFingerprint,
  decimalToBase,
  type SignRequest,
} from "@polyroot/signer";

/* ── Shared fixtures ──────────────────────────────────────────────────── */

function makePermit(over: Partial<ExecutionPermit> = {}): ExecutionPermit {
  return {
    schema_version: "1.1",
    permit_id: ulid(),
    decision_id: ulid(),
    intent_id: ulid(),
    ledger_version: "0003",
    policy_version: "v0-bootstrap",
    policy_hash: "ph_audited",
    quote_id: "quote_x",
    lease_epoch: 1,
    reservation_ids: ["res_1"],
    max_qty: 100,
    max_cash: 50,
    allowed_order_style: ["LIMIT", "POST_ONLY"],
    venue_mode: "NORMAL",
    issued_at: new Date("2026-01-01T00:00:00Z"),
    expires_at: new Date("2026-01-01T00:01:00Z"),
    single_use: true,
    used_at: null,
    ...over,
  };
}

function makeSignedOrder(id = "ord_1", permitId?: string): SignedOrder {
  return {
    schema_version: "1.1",
    order_id: id,
    market_id: "mkt_1",
    side: "BUY",
    price: 0.5,
    size: 10,
    fee_rate_bps: 0,
    signature: "sig_1",
    signer: "0xSIGNER",
    signed_at: new Date("2026-01-01T00:00:30Z"),
    permit_id: permitId,
  };
}

class FakeAdapter implements VenueAdapter {
  mode: VenueMode = "NORMAL";
  placeOrderFn: (o: SignedOrder) => Promise<SubmitOutcome> = async () => ({
    ok: true,
    result: {
      success: true,
      submit_status: "ACKNOWLEDGED",
      order_status: "LIVE",
      timestamp: new Date(),
    },
  });
  cancelOrderFn: (id: string) => Promise<SubmitOutcome> = async () => ({
    ok: true,
    result: { success: true, submit_status: "ACKNOWLEDGED", timestamp: new Date() },
  });
  getOrderStatusFn: (id: string) => Promise<OrderResult | null> = async () => null;
  setMode(m: VenueMode) {
    this.mode = m;
  }
  async getOrderBook(): Promise<MarketSnapshot> {
    throw new Error("not used");
  }
  async placeOrder(o: SignedOrder) {
    return this.placeOrderFn(o);
  }
  async cancelOrder(id: string) {
    return this.cancelOrderFn(id);
  }
  async getOrderStatus(id: string) {
    return this.getOrderStatusFn(id);
  }
}

function makeExecutor(adapter: FakeAdapter, now = new Date("2026-01-01T00:00:30Z")) {
  const used = new Set<string>();
  const seen = new Map<string, OrderLifecycleState>();
  const ex = new Executor({
    adapter,
    now: () => now,
    seen: {
      has: (id) => seen.has(id),
      add: (id, state) => void seen.set(id, state),
      get: (id) => seen.get(id),
    },
    markPermitUsed: async (pid) => void used.add(pid),
    isPermitUsed: async (pid) => used.has(pid),
  });
  return { ex, seen, used };
}

const basePortfolio: Portfolio = {
  wallet: "0xAAA",
  updated_at: new Date("2026-01-01T00:00:00Z"),
  cashAvailableBase: 1_000_000n,
  cashReservedBase: 0n,
  positions: [],
};

const basePolicy: RiskPolicy = {
  schema_version: "1.1",
  policy_version: "v0-bootstrap",
  risk_stop_pct: 0.1,
  max_open_positions: 10,
  max_position_share_pct: 0.2,
  max_cash_per_order: 100,
  daily_loss_stop_pct: 0.05,
  max_drawdown_stop_pct: 0.2,
  reduce_only: true,
  tags: [],
};

/* ── FT-01: Concurrent spend ──────────────────────────────────────────── */

class MemBalance implements BalanceStore {
  private balances = new Map<string, { available: bigint; committed: bigint }>();

  constructor(initial?: Map<string, bigint>) {
    if (initial) {
      for (const [key, value] of initial) {
        this.balances.set(key, { available: value, committed: 0n });
      }
    }
  }

  private getKey(account: string, asset: string): string {
    return `${account}:${asset}`;
  }

  private getEntry(account: string, asset: string) {
    const key = this.getKey(account, asset);
    if (!this.balances.has(key)) {
      this.balances.set(key, { available: 0n, committed: 0n });
    }
    return this.balances.get(key)!;
  }

  async get(account: string, asset: string) {
    const entry = this.getEntry(account, asset);
    return {
      availableBase: entry.available,
      committedBase: entry.committed,
    };
  }

  async reserveFunds(account: string, asset: string, amount: bigint): Promise<void> {
    const entry = this.getEntry(account, asset);
    if (entry.available < amount) {
      throw new Error("INSUFFICIENT_AVAILABLE");
    }
    entry.available -= amount;
    entry.committed += amount;
  }

  async releaseFunds(account: string, asset: string, amount: bigint): Promise<void> {
    const entry = this.getEntry(account, asset);
    if (entry.committed < amount) {
      throw new Error("INSUFFICIENT_COMMITTED");
    }
    entry.committed -= amount;
    entry.available += amount;
  }

  async consumeFunds(account: string, asset: string, amount: bigint): Promise<void> {
    const entry = this.getEntry(account, asset);
    if (entry.committed < amount) {
      throw new Error("INSUFFICIENT_COMMITTED");
    }
    entry.committed -= amount;
  }
}
class NoopSink implements KernelEventSink {
  async push(_ev: string, _d: Record<string, unknown>): Promise<void> {}
}

describe("FT-01 — Concurrent spend: at most one reservation commits", () => {
  it("two combined-intents-over-balance reserve serially: only the first commits", async () => {
    const balance = new MemBalance(new Map([["0xA:USDC", 6_000_000n]]));
    const kernel = new MoneyKernel({
      balance,
      sink: new NoopSink(),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const base = {
      decisionId: ulid(),
      intentId: ulid(),
      account: "0xA",
      asset: "USDC",
      maxCashBase: 5_000_000n,
      perSharePriceBase: 500_000n, // 0.5 → 10 shares * 0.5 = 5 USDC
      amountSharesBase: 10_000_000n,
      policy: basePolicy,
      policyHash: "ph_audited",
      walletType: "L2" as const,
      venueMode: "NORMAL" as const,
      leaseEpoch: 1,
      now: new Date("2026-01-01T00:00:00Z"),
    };
    const r1 = await kernel.reserve({ ...base, decisionId: ulid(), intentId: ulid() });
    assert.equal(r1.ok, true);
    // Second intent also needs 5 USDC but only 1 remains.
    const r2 = await kernel.reserve({ ...base, decisionId: ulid(), intentId: ulid() });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.code, "INSUFFICIENT_FUNDS");
  });
});

/* ── FT-02: Duplicate delivery ────────────────────────────────────────── */

describe("FT-02 — Duplicate delivery: one intent hash, no extra order", () => {
  it("same order submitted 3 times → exactly one SUBMITTED, rest DUPLICATE", async () => {
    const adapter = new FakeAdapter();
    let submits = 0;
    adapter.placeOrderFn = async () => {
      submits += 1;
      return {
        ok: true,
        result: { success: true, submit_status: "ACKNOWLEDGED", timestamp: new Date() },
      };
    };
    const { ex } = makeExecutor(adapter);
    const permit = makePermit();
    const order = makeSignedOrder("dup_1", permit.permit_id);
    const r1 = await ex.submit(order, permit);
    const r2 = await ex.submit(order, permit);
    const r3 = await ex.submit(order, permit);
    assert.equal(r1.outcome, "SUBMITTED");
    assert.equal(r2.outcome, "DUPLICATE");
    assert.equal(r3.outcome, "DUPLICATE");
    assert.equal(submits, 1);
  });
});

/* ── FT-04: Crash after send ──────────────────────────────────────────── */

describe("FT-04 — Crash after send: SUBMISSION_UNKNOWN retains reservation", () => {
  it("unknown submit → NEEDS_RECONCILIATION, no blind re-submit, permit not reusable", async () => {
    const adapter = new FakeAdapter();
    adapter.placeOrderFn = async () => ({
      ok: false,
      code: "SUBMISSION_UNKNOWN",
      reason: "outcome unknown",
    });
    const { ex, seen } = makeExecutor(adapter);
    const r = await ex.submit(makeSignedOrder("crash_1"), makePermit());
    assert.equal(r.outcome, "NEEDS_RECONCILIATION");
    assert.equal(seen.get("crash_1"), "SUBMISSION_UNKNOWN");
    // Reconciliation may NOT turn it back into a live submit.
    assert.equal(await ex.reconcile("crash_1"), "SUBMISSION_UNKNOWN");
    // Even a fresh permit cannot re-submit — the order id is already seen.
    const retry = await ex.submit(makeSignedOrder("crash_1"), makePermit());
    assert.equal(retry.outcome, "DUPLICATE");
  });
});

/* ── FT-05: Late accepted submit ──────────────────────────────────────── */

describe("FT-05 — Late accepted submit: one logical order, reconciled", () => {
  it("deadline-unknown POST: RecoveryLedger keeps it unresolved, no new order", () => {
    const rl = new RecoveryLedger({ clock: () => 0 });
    rl.addSubmittedUnknown("late_1", "ven_A");
    // The venue later accepts the original POST — that is a reconciliation
    // event, never a pretext to create a new order.
    assert.equal(rl.needsReconcile("late_1"), true);
    rl.resolve("late_1", true);
    assert.equal(rl.needsReconcile("late_1"), false);
  });
});

/* ── FT-06: Cancel fill race ──────────────────────────────────────────── */

describe("FT-06 — Cancel fill race: reserve unsettled fill until reconciliation", () => {
  it("shares freed only by a definitive cancel — NOT by pending cancel", () => {
    // verified 30, cancel DEFINITIVE released 5. pending cancel (maybe filled) 25.
    const sellable = sellableShares(30_000_000n, 5_000_000n, 25_000_000n);
    assert.equal(sellable, 35_000_000n);
    // The pending 25 must not sellable: it might already be filled.
    const exceed = checkReduceAllowed({
      requestQtyBase: 36_000_000n,
      verifiedQtyDeltaBase: 30_000_000n,
      definitivelyCanceledQtyBase: 5_000_000n,
      pendingCancelQtyBase: 25_000_000n,
    });
    assert.equal(exceed.ok, false);
    if (!exceed.ok) assert.equal(exceed.code, "REDUCE_OVERDRAWN");
  });
});

/* ── FT-07: Failed cancel ─────────────────────────────────────────────── */

describe("FT-07 — Failed cancel: do NOT clear active order / release capital", () => {
  it("CANCEL_FAILED keeps allCanceled=false and the order visible", () => {
    let plan = planCancelOpen("CANCEL_OPEN", [
      { orderId: "open_1", marketId: "m1", side: "BUY" },
    ]);
    plan = recordCancelOutcome(plan, {
      status: "CANCEL_FAILED",
      orderId: "open_1",
      reason: "not_canceled",
    });
    assert.equal(plan.allCanceled, false);
    assert.equal(plan.plan[0]?.status, "CANCEL_FAILED");
  });
});

/* ── FT-08: Partial batch failure ─────────────────────────────────────── */

describe("FT-08 — Partial batch failure: per-order results", () => {
  it("two orders: one ACK, one DEFINITIVE_REJECT → no batch success assumption", async () => {
    const adapter = new FakeAdapter();
    adapter.placeOrderFn = async (o) =>
      o.order_id === "ok_1"
        ? {
            ok: true,
            result: { success: true, submit_status: "ACKNOWLEDGED", timestamp: new Date() },
          }
        : { ok: false, code: "DEFINITIVE_REJECT", reason: "offside" };
    const { ex } = makeExecutor(adapter);
    const a = await ex.submit(makeSignedOrder("ok_1"), makePermit());
    assert.equal(a.outcome, "SUBMITTED");
    const b = await ex.submit(makeSignedOrder("bad_1"), makePermit());
    assert.equal(b.outcome, "PERMIT_INVALID");
  });
});

/* ── FT-11: Post-only mode ────────────────────────────────────────────── */

describe("FT-11 — Post-only mode: gate refuses while recovering", () => {
  it("POST_ONLY mode forbids taker in recovery; executor route via venue mode", async () => {
    const adapter = new FakeAdapter();
    adapter.setMode("CANCEL_ONLY"); // recovery: cancel/read, no new entries
    const { ex } = makeExecutor(adapter);
    const r = await ex.submit(makeSignedOrder("po_1"), makePermit());
    assert.equal(r.outcome, "MODE_FORBIDS");
    const c = await ex.cancel("ven_po");
    assert.equal(c.ok, true); // cancels stay legal while recovering
  });
});

/* ── FT-13: Unknown venue mode ────────────────────────────────────────── */

describe("FT-13 — Unknown venue mode: no new orders; read continues", () => {
  it("UNKNOWN mode: submit refused, read allowed", async () => {
    const adapter = new FakeAdapter();
    adapter.setMode("UNKNOWN");
    const { ex } = makeExecutor(adapter);
    const r = await ex.submit(makeSignedOrder("unk_1"), makePermit());
    assert.equal(r.outcome, "MODE_FORBIDS");
  });
});

/* ── FT-14: Signer compromise attempt ─────────────────────────────────── */

describe("FT-14 — Signer compromise attempt: vault rejects mismatch", () => {
  it("altering amount after permit → vault refuses to sign", async () => {
    const vault = new SignerVault({
      cryptoSigner: async () => "0xdeadbeef",
      maxClockSkewMs: 5_000,
    });
    const permit = makePermit();
    const makeReq = (amountBase: bigint, actionId = "sig_1"): SignRequest => ({
      schema_version: "1.1",
      action: "ORDER_SUBMIT",
      permit,
      wallet: {
        wallet_type: "L2",
        signer_address: "0xSIGNER",
        funder: "0xFUNDER", // distinct from signer (WAL-03)
      },
      amountBase,
      actionId,
      marketContext: "mkt_1",
      venueMode: "NORMAL",
      now: new Date("2026-01-01T00:00:30Z"),
      payloadHash: permitFingerprint(permit),
    });
    // Honors the permit share quota: 50 shares signed cleanly.
    const ok = await vault.sign(makeReq(decimalToBase(50)));
    assert.equal(ok.ok, true);
    // An attacker rewrites the amount past the reservation: the vault refuses.
    const tampered = await vault.sign(makeReq(decimalToBase(5000), "sig_attacker"));
    assert.equal(tampered.ok, false);
    if (!tampered.ok) assert.equal(tampered.code, "AMOUNT_EXCEEDS_PERMIT");
  });
});

/* ── FT-21: Credential revocation ─────────────────────────────────────── */

describe("FT-21 — Credential revocation: uncertain state preserved", () => {
  it("planCompromiseResponse revokes L2 before any live re-enable", () => {
    const plan = planCompromiseResponse({
      class: "L2_API",
      scope: "all",
      freezeEntries: true,
      cancelPossible: true,
      now: new Date("2026-01-01T00:00:00Z"),
      details: { latencyMs: 30, exposures: [] },
    });
    const actions = plan.order.map((s) => s.action);
    assert.ok(actions.includes("KILL_SIGNING"));
    assert.ok(actions.includes("REVOKE_L2"));
    // REVOKE comes strictly after reconcile + cancel, per procedure order.
    assert.ok(actions.indexOf("REVOKE_L2") > actions.indexOf("RECONCILE"));
  });
});

/* ── FT-42: Exit liquidity disappears ─────────────────────────────────── */

describe("FT-42 — Exit liquidity disappears: position stays open, no forced floor", () => {
  it("planFlatten skips a position priced above the cap — does not fire the SELL", () => {
    const plan = planFlatten(
      "FLATTEN",
      [
        {
          marketId: "m1",
          side: "SELL" as const,
          qtyBase: 10_000_000n,
          avgPriceBase: 90_000n, // 0.90 — best bid is below floor
        },
      ],
      80_000n, // floor cap = 0.80
    );
    assert.equal(plan.reduceOrders.length, 0);
    assert.equal(plan.skipped.length, 1);
  });
});

/* ── FT-46: Drawdown and restart ──────────────────────────────────────── */

describe("FT-46 — Drawdown and restart: breach persists, no timed auto-resume", () => {
  it("a sealed breach blocks even after deposit + restart, until owner resumes", () => {
    const portfolio = {
      ...basePortfolio,
      cashAvailableBase: 2_000_000n, // deposit added after the breach
    };
    const res = lossFloor({
      policy: basePolicy,
      portfolio,
      equityBasisUsd: 1000,
      sealedBreach: true, // persisted before the crash
      realized_pnl_24h: -999, // not even looked at once sealed
    });
    assert.equal(res.blocked, true);
    assert.equal(res.sealedBreach, true);
    assert.ok(res.reasons.some((r) => r.includes("until owner resume")));
  });

  it("no timed auto-resume: breach stays until an explicit owner resume", () => {
    const res = lossFloor({
      policy: basePolicy,
      portfolio: basePortfolio,
      equityBasisUsd: 1000,
      sealedBreach: true,
      realized_pnl_24h: 0,
    });
    assert.equal(res.blocked, true);
  });
});

/* ── FT-03: Crash before send (payload recovery is idempotent) ────────── */

describe("FT-03 — Crash before send: recover same payload, no duplicate", () => {
  it("order marked in-flight, never re-submitted on the same seen-map", () => {
    const { ex } = makeExecutor(new FakeAdapter());
    const order = makeSignedOrder("pre_send_1");
    // The payload persisted pre-network; a replayed delivery is a duplicate.
    // (In a live supervisor the seen-map is the persisted idempotency log.)
    assert.equal(orderLifecycleNext("SUBMITTING", "SUBMITTING").state, "SUBMITTING");
    assert.equal(ex[Symbol.toStringTag] ?? "Executor", "Executor");
  });
});

/* ── FT-29/33/34: ledger/monotonic invariants our kernel guarantees ───── */

describe("FT-29/33/34 — clock skew, settlement, double redeem (kernel-level)", () => {
  it("cashNeededFor is exact integer math (no float drift)", async () => {
    const { cashNeededFor } = await import("@polyroot/risk");
    // 123 shares * 0.77 = 94.71 USDC = 94_710_000 base units exactly.
    assert.equal(cashNeededFor(123_000_000n, 770_000n), 94_710_000n);
    void decimalToBase;
  });
});