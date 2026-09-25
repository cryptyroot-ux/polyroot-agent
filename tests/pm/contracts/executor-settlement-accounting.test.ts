import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Executor, type OrderLifecycleState } from "@polyroot/executor";
import type { VenueAdapter, SubmitOutcome } from "@polyroot/venue";
import type {
  ExecutionPermit,
  SignedOrder,
  MarketSnapshot,
  OrderResult,
  VenueMode,
} from "@polyroot/domain";
import { cashNeededFor } from "@polyroot/risk";
import { decimalToBase } from "@polyroot/signer";
import { randomUUID } from "crypto";
import {
  MemPermitStore,
  MemRecoveryLedger,
  MemLeaseStore,
  type PermitStore,
} from "@polyroot/venue";

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
  async placeOrder(o: SignedOrder) {
    return this.placeOrderFn(o);
  }
  async cancelOrder() {
    return {
      ok: true,
      result: { success: true, timestamp: new Date() },
    } as SubmitOutcome;
  }
  async getOrderStatus(): Promise<OrderResult | null> {
    return null;
  }
  setMode(m: VenueMode) {
    this.mode = m;
  }
  async getOrderBook(): Promise<MarketSnapshot> {
    throw new Error("not used in tests");
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

interface ConsumeCall {
  reservationId: string;
  amount: bigint;
}

/** PermitStore spy: records the claim payload_hash the executor passes. */
class RecordingPermitStore extends MemPermitStore {
  public claimHashes: Array<string | undefined> = [];
  override async claimPermitAndRecordSubmission(
    permitId: string,
    orderId: string,
    venueOrderId?: string,
    payload_hash?: string,
  ) {
    this.claimHashes.push(payload_hash);
    return super.claimPermitAndRecordSubmission(
      permitId,
      orderId,
      venueOrderId,
      payload_hash,
    );
  }
}

function makeDeps(
  adapter: FakeAdapter,
  consumed: ConsumeCall[],
  permitStore?: PermitStore,
  now: Date = new Date("2026-01-01T00:00:30Z"),
) {
  const seen = new Map<string, OrderLifecycleState>();
  const store = permitStore ?? new MemPermitStore({ clock: () => now });
  const deps = {
    adapter,
    now: () => now,
    seen: {
      has: (id: string) => seen.has(id),
      add: (id: string, state: OrderLifecycleState) => void seen.set(id, state),
      get: (id: string) => seen.get(id),
    },
    permitStore: store,
    recoveryLedger: new MemRecoveryLedger(),
    leaseEpoch: 1,
    walletId: "0xWALLET",
    holder: "0xHOLDER",
    leaseStore: new MemLeaseStore({ clock: () => now }),
    reservationManager: {
      consume: async (reservationId: string, amount: bigint) => {
        consumed.push({ reservationId, amount });
        return { ok: true as const };
      },
      release: async () => ({ ok: true as const }),
    } as never,
  };
  return { deps, store };
}

describe("Executor settlement accounting (cash units, claim receipt)", () => {
  it("consumes filled cash (shares x price), not raw share units", async () => {
    const adapter = new FakeAdapter();
    adapter.placeOrderFn = async () => ({
      ok: true,
      result: {
        success: true,
        submit_status: "ACKNOWLEDGED",
        order_status: "PARTIAL",
        filled_size: 10,
        average_price: 0.5,
        timestamp: new Date(),
      },
    });
    const consumed: ConsumeCall[] = [];
    const { deps } = makeDeps(adapter, consumed);
    const ex = new Executor(deps);
    const res = await ex.submit(makeSignedOrder(), makePermit());
    assert.equal(res.outcome, "SUBMITTED");
    assert.equal(consumed.length, 1);
    // 10 shares @ 0.5 = 5.0 cash base units (5_000_000n), NOT 10_000_000n.
    const expected = cashNeededFor(decimalToBase(10), decimalToBase(0.5));
    assert.equal(expected, 5_000_000n);
    assert.equal(consumed[0]?.amount, expected);
  });

  it("falls back to the order limit price when no average price is reported", async () => {
    const adapter = new FakeAdapter();
    adapter.placeOrderFn = async () => ({
      ok: true,
      result: {
        success: true,
        submit_status: "ACKNOWLEDGED",
        order_status: "PARTIAL",
        filled_size: 4,
        timestamp: new Date(),
      },
    });
    const consumed: ConsumeCall[] = [];
    const { deps } = makeDeps(adapter, consumed);
    const ex = new Executor(deps);
    const res = await ex.submit(makeSignedOrder(), makePermit());
    assert.equal(res.outcome, "SUBMITTED");
    assert.equal(consumed.length, 1);
    // 4 shares @ order limit 0.5 = 2.0 cash base units.
    assert.equal(
      consumed[0]?.amount,
      cashNeededFor(decimalToBase(4), decimalToBase(0.5)),
    );
  });

  it("records a claim-binding payload hash at permit claim time", async () => {
    const adapter = new FakeAdapter();
    const consumed: ConsumeCall[] = [];
    const recording = new RecordingPermitStore({
      clock: () => new Date("2026-01-01T00:00:30Z"),
    });
    const { deps } = makeDeps(adapter, consumed, recording);
    const ex = new Executor(deps);
    const permit = makePermit();
    const res = await ex.submit(
      makeSignedOrder("ord_9", permit.permit_id),
      permit,
    );
    assert.equal(res.outcome, "SUBMITTED");
    assert.equal(recording.claimHashes.length, 1);
    assert.match(recording.claimHashes[0] ?? "", /^[0-9a-f]{64}$/);
  });
});
