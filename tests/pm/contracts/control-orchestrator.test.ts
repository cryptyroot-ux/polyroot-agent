import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orchestrate, type OrchestratorDeps } from "@polyroot/control";
import { Executor, type OrderLifecycleState } from "@polyroot/executor";
import { MoneyKernel, type BalanceStore, type KernelEventSink } from "@polyroot/risk";
import { SignerVault } from "@polyroot/signer";
import type { VenueAdapter, SubmitOutcome } from "@polyroot/venue";
import {
  DEFAULT_RISK_POLICY,
  type ExecutionPermit,
  type Forecast,
  type MarketSnapshot,
  type RiskPolicy,
  type SignedOrder,
  type TradeIntent,
  type VenueMode,
  type WalletIdentity,
} from "@polyroot/domain";
import { ulid } from "ulid";

class FakeBalanceStore implements BalanceStore {
  available: bigint;
  committed = 0n;
  constructor(available: bigint) {
    this.available = available;
  }
  async get(): Promise<{
    account: string;
    asset: string;
    availableBase: bigint;
    committedBase: bigint;
  }> {
    return {
      account: "0xFUNDER",
      asset: "pUSD",
      availableBase: this.available,
      committedBase: this.committed,
    };
  }
  async commit(_a: string, _s: string, delta: bigint): Promise<void> {
    if (delta < 0n) {
      this.available += delta;
      this.committed += -delta;
    } else {
      this.available += delta;
      this.committed -= delta;
    }
  }
}

class FakeSink implements KernelEventSink {
  events: Array<{ topic: string; payload: unknown }> = [];
  async push(topic: string, payload: unknown): Promise<void> {
    this.events.push({ topic, payload });
  }
}

class FakeAdapter implements VenueAdapter {
  mode: VenueMode = "NORMAL";
  placeOrderCalls = 0;
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
    result: {
      success: true,
      submit_status: "ACKNOWLEDGED",
      timestamp: new Date(),
    },
  });
  getOrderStatusFn: (id: string) => Promise<import("@polyroot/domain").OrderResult | null> =
    async () => null;
  setMode(m: VenueMode) {
    this.mode = m;
  }
  async getOrderBook(): Promise<MarketSnapshot> {
    throw new Error("not used in tests");
  }
  async placeOrder(o: SignedOrder) {
    this.placeOrderCalls += 1;
    return this.placeOrderFn(o);
  }
  async cancelOrder(id: string) {
    return this.cancelOrderFn(id);
  }
  async getOrderStatus(id: string) {
    return this.getOrderStatusFn(id);
  }
}

function makeWallet(over: Partial<WalletIdentity> = {}): WalletIdentity {
  return {
    schema_version: "1.1",
    wallet_id: ulid(),
    wallet_type: "DEPOSIT_WALLET",
    signer_address: "0xSIGNER",
    account_wallet: "0xACCOUNT",
    funder: "0xFUNDER",
    chain_id: 137,
    verified_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function makeIntent(over: Partial<TradeIntent> = {}): TradeIntent {
  return {
    schema_version: "1.1",
    intent_id: ulid(),
    dedupe_key: "dk_1",
    purpose: "ENTRY",
    market_id: "mkt_1",
    side: "BUY",
    desired_qty: 10,
    limit_price: 0.5,
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function makeForecast(over: Partial<Forecast> = {}): Forecast {
  return {
    schema_version: "1.1",
    forecast_id: ulid(),
    market_id: "mkt_1",
    p_calibrated: 0.7,
    confidence: 0.8,
    horizon_sec: 3600,
    valid_until: new Date("2026-01-01T01:00:00Z"),
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function makeBook(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    schema_version: "1.1",
    event_id: "evt_1",
    market_id: "mkt_1",
    question: "Will X happen?",
    chain_id: 137,
    collateral: "0xCOLLAT",
    rules_hash: "rh_1",
    fee_maker_bps: 0,
    fee_taker_bps: 0,
    tick_size: 0.01,
    min_size: 1,
    status: "ACTIVE",
    is_neg_risk: false,
    venue_mode: "NORMAL",
    yes_price: 0.5,
    no_price: 0.5,
    source_at: new Date("2026-01-01T00:00:00Z"),
    received_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function makePolicy(over: Partial<RiskPolicy> = {}): RiskPolicy {
  return {
    ...DEFAULT_RISK_POLICY,
    policy_version: "v0-bootstrap",
    capital_usd_cap: 10_000,
    max_order_pct: 0.005,
    min_edge_after_cost: 0.05,
    ...over,
  };
}

const NOW = new Date("2026-01-01T00:00:30Z");

function makeDeps(adapter: FakeAdapter, over: Partial<OrchestratorDeps> = {}): {
  deps: OrchestratorDeps;
  used: Set<string>;
  balance: FakeBalanceStore;
} {
  const used = new Set<string>();
  const seen = new Map<string, OrderLifecycleState>();
  const executor = new Executor({
    adapter,
    now: () => NOW,
    seen: {
      has: (id: string) => seen.has(id),
      add: (id: string, state: OrderLifecycleState) => seen.set(id, state),
      get: (id: string) => seen.get(id),
    },
    markPermitUsed: async (permitId: string, orderId: string) => {
      used.add(permitId);
    },
    isPermitUsed: async (permitId: string) => used.has(permitId),
  });
  const balance = new FakeBalanceStore(1_000_000_000n);
  const kernel = new MoneyKernel({
    balance,
    sink: new FakeSink(),
    chainId: 137,
    permitTtlMs: 60_000,
  });
  const deps: OrchestratorDeps = {
    kernel,
    signer: new SignerVault({ cryptoSigner: async () => "sig_orch" }),
    executor,
    wallet: makeWallet(),
    policy: makePolicy(),
    policyHash: "ph_audited",
    venueMode: () => "NORMAL",
    leaseEpoch: () => 1,
    now: () => NOW,
    ...over,
  };
  return { deps, used, balance };
}

describe("Control — orchestrator (signal → risk → build → submit)", () => {
  it("executes the full pipeline and submits", async () => {
    const adapter = new FakeAdapter();
    const { deps, used, balance } = makeDeps(adapter);
    const res = await orchestrate(deps, {
      forecast: makeForecast(),
      book: makeBook(),
      intent: makeIntent(),
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.outcome, "SUBMITTED");
      assert.equal(res.state, "ACKNOWLEDGED");
      assert.equal(res.order.side, "BUY");
      assert.equal(res.order.signature, "sig_orch");
      assert.equal(res.order.side, "BUY");
      assert.ok(res.order.permit_id && res.order.permit_id.length > 0);
      assert.equal(adapter.placeOrderCalls, 1);
      assert.equal(used.size, 1);
      assert.equal(balance.committed, 5_000_000n);
    }
  });

  it("stops at the edge stage when there is no tradeable edge", async () => {
    const adapter = new FakeAdapter();
    const { deps, balance } = makeDeps(adapter);
    const res = await orchestrate(deps, {
      forecast: makeForecast({ p_calibrated: 0.51 }),
      book: makeBook(),
      intent: makeIntent(),
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.stage, "EDGE");
      assert.equal(res.code, "MIN_EDGE_UNMET");
    }
    assert.equal(adapter.placeOrderCalls, 0);
    assert.equal(balance.committed, 0n);
  });

  it("stops at the risk stage when the order violates the policy", async () => {
    const adapter = new FakeAdapter();
    const { deps, balance } = makeDeps(adapter, {
      policy: makePolicy({ max_order_pct: 0.001 }), // 10 USD order budget
    });
    const res = await orchestrate(deps, {
      forecast: makeForecast(),
      book: makeBook(),
      intent: makeIntent({ desired_qty: 30, limit_price: 0.5 }), // 15 USD > 10
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.stage, "RISK");
    assert.equal(adapter.placeOrderCalls, 0);
    assert.equal(balance.committed, 0n);
  });

  it("stops at the submit stage when the venue mode forbids it", async () => {
    const adapter = new FakeAdapter();
    adapter.setMode("CANCEL_ONLY");
    const { deps } = makeDeps(adapter, {
      venueMode: () => "CANCEL_ONLY",
    });
    const res = await orchestrate(deps, {
      forecast: makeForecast(),
      book: makeBook(),
      intent: makeIntent(),
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.stage, "SUBMIT");
      assert.equal(res.code, "MODE_FORBIDS");
    }
    assert.equal(adapter.placeOrderCalls, 0);
  });

  it("reports an in-flight unknown submission for reconciliation", async () => {
    const adapter = new FakeAdapter();
    adapter.placeOrderFn = async () => ({
      ok: false,
      code: "SUBMISSION_UNKNOWN",
      reason: "timeout",
    });
    const { deps } = makeDeps(adapter);
    const res = await orchestrate(deps, {
      forecast: makeForecast(),
      book: makeBook(),
      intent: makeIntent(),
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.outcome, "NEEDS_RECONCILIATION");
      assert.equal(res.state, "SUBMISSION_UNKNOWN");
    }
  });
});