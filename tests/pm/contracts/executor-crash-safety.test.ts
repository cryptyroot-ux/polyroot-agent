import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Executor,
  type OrderLifecycleState,
} from "@polyroot/executor";
import type { VenueAdapter, SubmitOutcome } from "@polyroot/venue";
import type {
  ExecutionPermit,
  SignedOrder,
  OrderResult,
  VenueMode,
} from "@polyroot/domain";
import { randomUUID } from "crypto";
import { MemPermitStore, MemRecoveryLedger, MemLeaseStore } from "@polyroot/venue";

class FakeAdapter implements VenueAdapter {
  mode: VenueMode = "NORMAL";
  placeOrderFn: (o: SignedOrder) => Promise<SubmitOutcome> = async (o) => ({
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
    result: {
      success: true,
      submit_status: "ACKNOWLEDGED",
      timestamp: new Date(),
    },
  });
  getOrderStatusFn: (id: string) => Promise<OrderResult | null> = async () =>
    null;
  setMode(m: VenueMode) {
    this.mode = m;
  }
  async getOrderBook() {
    throw new Error("not used in tests");
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

function makePermit(over: Partial<ExecutionPermit> = {}): ExecutionPermit {
  return {
    schema_version: "1.1",
    permit_id: randomUUID(),
    decision_id: randomUUID(),
    intent_id: randomUUID(),
    ledger_version: "0003",
    policy_version: "v0-bootstrap",
    policy_hash: "ph_audited",
    quote_id: "quote_x",
    lease_epoch: 1,
    reservation_ids: ["res_1"],
    max_qty: 100,
    max_cash: 50,
    max_qty_base: 100_000_000n,
    max_cash_base: 50_000_000n,
    market_id: "mkt_1",
    side: "BUY",
    price_min_base: 500_000n,
    price_max_base: 500_000n,
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

function makeDeps(
  adapter: FakeAdapter,
  now: Date = new Date("2026-01-01T00:00:30Z"),
) {
  const seen = new Map<string, OrderLifecycleState>();
  const permitStore = new MemPermitStore({ clock: () => now });
  const recoveryLedger = new MemRecoveryLedger();
  const deps = {
    adapter,
    now: () => now,
    seen: {
      has: (id: string) => seen.has(id),
      add: (id: string, state: OrderLifecycleState) => void seen.set(id, state),
      get: (id: string) => seen.get(id),
    },
    permitStore,
    recoveryLedger,
    leaseEpoch: 1,
    walletId: "0xWALLET",
    holder: "0xHOLDER",
    leaseStore: new MemLeaseStore({ clock: () => now }),
  };
  return { deps, permitStore, recoveryLedger, seen };
}

describe("Executor — crash safety: SUBMITTING state (PM-EXE-07)", () => {
  it("marks order SUBMITTING before venue call; crash after submit retains SUBMISSION_UNKNOWN", async () => {
    const adapter = new FakeAdapter();
    const { deps, seen } = makeDeps(adapter);
    const executor = new Executor(deps);
    const order = makeSignedOrder("ord_crash_1");
    const permit = makePermit();

    // Capture state before venue call
    let preSubmitState: OrderLifecycleState | undefined;
    const originalPlaceOrder = adapter.placeOrder.bind(adapter);
    adapter.placeOrder = async (o) => {
      preSubmitState = seen.get(order.order_id);
      return originalPlaceOrder(o);
    };

    // Submit with a venue that returns SUBMISSION_UNKNOWN
    adapter.placeOrderFn = async () => ({
      ok: false,
      code: "SUBMISSION_UNKNOWN",
      reason: "outcome unknown",
    });

    const result = await executor.submit(order, permit);
    
    // Verify state was SUBMITTING before the venue call
    assert.equal(preSubmitState, "SUBMITTING");
    
    // Verify the final state after SUBMISSION_UNKNOWN
    assert.equal(result.state, "SUBMISSION_UNKNOWN");
    assert.equal(result.outcome, "NEEDS_RECONCILIATION");
  });

  it("marks order SUBMITTING in recovery ledger before venue call", async () => {
    const adapter = new FakeAdapter();
    const { deps, recoveryLedger } = makeDeps(adapter);
    const executor = new Executor(deps);
    const order = makeSignedOrder("ord_crash_2");
    const permit = makePermit();

    // Capture recovery ledger state before venue call
    let preSubmitLedgerState: OrderLifecycleState | undefined;
    const originalPlaceOrder = adapter.placeOrder.bind(adapter);
    adapter.placeOrder = async (o) => {
      const ledgerEntry = await recoveryLedger.get(order.order_id);
      preSubmitLedgerState = ledgerEntry?.state;
      return originalPlaceOrder(o);
    };

    adapter.placeOrderFn = async () => ({
      ok: false,
      code: "SUBMISSION_UNKNOWN",
      reason: "outcome unknown",
    });

    await executor.submit(order, permit);
    
    // Verify recovery ledger had SUBMITTING state before venue call
    assert.equal(preSubmitLedgerState, "SUBMITTING");
  });

  it("crash after submit with ACKNOWLEDGED retains ACKNOWLEDGED state", async () => {
    const adapter = new FakeAdapter();
    const { deps, seen } = makeDeps(adapter);
    const executor = new Executor(deps);
    const order = makeSignedOrder("ord_crash_3");
    const permit = makePermit();

    let preSubmitState: OrderLifecycleState | undefined;
    const originalPlaceOrder = adapter.placeOrder.bind(adapter);
    adapter.placeOrder = async (o) => {
      preSubmitState = seen.get(order.order_id);
      return originalPlaceOrder(o);
    };

    // Default adapter returns ACKNOWLEDGED
    const result = await executor.submit(order, permit);
    
    assert.equal(preSubmitState, "SUBMITTING");
    assert.equal(result.state, "ACKNOWLEDGED");
    assert.equal(result.outcome, "SUBMITTED");
  });

  it("crash after submit with DEFINITELY_NOT_SENT retains SUBMISSION_UNKNOWN", async () => {
    const adapter = new FakeAdapter();
    const { deps, seen } = makeDeps(adapter);
    const executor = new Executor(deps);
    const order = makeSignedOrder("ord_crash_4");
    const permit = makePermit();

    let preSubmitState: OrderLifecycleState | undefined;
    const originalPlaceOrder = adapter.placeOrder.bind(adapter);
    adapter.placeOrder = async (o) => {
      preSubmitState = seen.get(order.order_id);
      return originalPlaceOrder(o);
    };

    adapter.placeOrderFn = async () => ({
      ok: false,
      code: "DEFINITELY_NOT_SENT",
      reason: "network timeout before venue received request",
    });

    const result = await executor.submit(order, permit);
    
    assert.equal(preSubmitState, "SUBMITTING");
    assert.equal(result.state, "SUBMISSION_UNKNOWN");
    assert.equal(result.outcome, "NEEDS_RECONCILIATION");
  });
});