import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Executor,
  orderLifecycleNext,
  type OrderLifecycleState,
} from "@polyroot/executor";
import type { VenueAdapter, SubmitOutcome } from "@polyroot/venue";
import type {
  ExecutionPermit,
  SignedOrder,
  MarketSnapshot,
  VenueMode,
} from "@polyroot/domain";
import { ulid } from "ulid";

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
  setMode(m: VenueMode) {
    this.mode = m;
  }
  async getOrderBook(): Promise<MarketSnapshot> {
    throw new Error("not used in tests");
  }
  async placeOrder(o: SignedOrder) {
    return this.placeOrderFn(o);
  }
  async cancelOrder(id: string) {
    return this.cancelOrderFn(id);
  }
}

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

function makeSignedOrder(id = "ord_1"): SignedOrder {
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
    permit_id: "permit_1",
  };
}

function makeDeps(
  adapter: FakeAdapter,
  now: Date = new Date("2026-01-01T00:00:30Z"),
) {
  const used = new Set<string>();
  const seen = new Map<string, OrderLifecycleState>();
  const deps = {
    adapter,
    now: () => now,
    seen: {
      has: (id: string) => seen.has(id),
      add: (id: string, state: OrderLifecycleState) => void seen.set(id, state),
      get: (id: string) => seen.get(id),
    },
    markPermitUsed: async (pid: string) => void used.add(pid),
    isPermitUsed: async (pid: string) => used.has(pid),
  };
  return { deps, used, seen };
}

describe("Executor — order lifecycle, idempotency, no-blind-retry (PR-EXE-03..06)", () => {
  it("submits a fresh order exactly once and moves to ACKNOWLEDGED", async () => {
    const adapter = new FakeAdapter();
    const { deps } = makeDeps(adapter);
    const ex = new Executor(deps);
    const res = await ex.submit(makeSignedOrder(), makePermit());
    assert.equal(res.outcome, "SUBMITTED");
    // A second submit of the same order id is refused as a duplicate.
    const dup = await ex.submit(makeSignedOrder(), makePermit());
    assert.equal(dup.outcome, "DUPLICATE");
  });

  it("never blindly re-submits an order whose outcome was unknown", async () => {
    const adapter = new FakeAdapter();
    adapter.placeOrderFn = async () => ({
      ok: false,
      code: "SUBMISSION_UNKNOWN",
      reason: "outcome unknown",
    });
    const { deps } = makeDeps(adapter);
    const ex = new Executor(deps);
    const res = await ex.submit(makeSignedOrder(), makePermit());
    assert.equal(res.outcome, "NEEDS_RECONCILIATION");
    const state = await ex.reconcile("ord_1");
    // Reconciliation must NOT turn it back into a live submit.
    assert.equal(state, "SUBMISSION_UNKNOWN");
  });

  it("refuses to submit when the permit has already expired (TTL recheck)", async () => {
    const adapter = new FakeAdapter();
    const late = new Date("2026-01-01T00:02:00Z");
    const { deps } = makeDeps(adapter, late);
    const ex = new Executor(deps);
    const res = await ex.submit(makeSignedOrder(), makePermit());
    assert.equal(res.outcome, "PERMIT_INVALID");
    if (res.outcome === "PERMIT_INVALID")
      assert.equal(res.code, "PERMIT_EXPIRED");
  });

  it("refuses to reuse an already-used single-use permit", async () => {
    const adapter = new FakeAdapter();
    const { deps } = makeDeps(adapter);
    const ex = new Executor(deps);
    // Simulate a prior successful use by marking the fresh permit used.
    const permit = makePermit();
    await deps.markPermitUsed(permit.permit_id, "ord_1");
    const res = await ex.submit(makeSignedOrder(), permit);
    assert.equal(res.outcome, "PERMIT_INVALID");
    if (res.outcome === "PERMIT_INVALID") assert.equal(res.code, "PERMIT_USED");
  });

  it("fails closed when the venue is in CANCEL_ONLY (submit blocked, cancel allowed)", async () => {
    const adapter = new FakeAdapter();
    adapter.setMode("CANCEL_ONLY");
    const { deps } = makeDeps(adapter);
    const ex = new Executor(deps);
    const s = await ex.submit(makeSignedOrder(), makePermit());
    assert.equal(s.outcome, "MODE_FORBIDS");
    const c = await ex.cancel("ven_1");
    assert.equal(c.ok, true);
  });

  it("fails closed for cancels when the venue is UNAVAILABLE", async () => {
    const adapter = new FakeAdapter();
    adapter.setMode("UNAVAILABLE");
    const { deps } = makeDeps(adapter);
    const ex = new Executor(deps);
    const c = await ex.cancel("ven_1");
    assert.equal(c.ok, false);
    if (!c.ok) assert.equal(c.code, "MODE_FORBIDS");
  });

  it("orderLifecycleNext: ACK is final, UNKNOWN is terminal for re-submit", () => {
    assert.equal(
      orderLifecycleNext("SUBMITTING", "ACKNOWLEDGED").state,
      "ACKNOWLEDGED",
    );
    assert.equal(
      orderLifecycleNext("SUBMITTING", "SUBMISSION_UNKNOWN").state,
      "SUBMISSION_UNKNOWN",
    );
    // Definitive reject is terminal.
    assert.equal(
      orderLifecycleNext("SUBMITTING", "DEFINITIVE_REJECT").state,
      "DEFINITIVE_REJECT",
    );
  });
});
