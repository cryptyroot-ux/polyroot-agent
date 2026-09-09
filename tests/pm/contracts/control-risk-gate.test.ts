import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  validateAndReserve,
  type RiskGateInput,
} from "@polyroot/control";
import { MoneyKernel, type BalanceStore, type KernelEventSink } from "@polyroot/risk";
import {
  DEFAULT_RISK_POLICY,
  type RiskPolicy,
  type TradeIntent,
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

function makeKernel(balance?: FakeBalanceStore) {
  const balanceStore = balance ?? new FakeBalanceStore(100_000_000_000n);
  const sink = new FakeSink();
  const kernel = new MoneyKernel({
    balance: balanceStore,
    sink,
    chainId: 137,
    permitTtlMs: 60_000,
  });
  return { balance: balanceStore, sink, kernel };
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

function makePolicy(over: Partial<RiskPolicy> = {}): RiskPolicy {
  return {
    ...DEFAULT_RISK_POLICY,
    policy_version: "v0-bootstrap",
    capital_usd_cap: 10_000,
    max_order_pct: 0.005, // 50 USD
    max_market_pct: 0.02, // 200 USD
    max_portfolio_pct: 0.1, // 1000 USD
    ...over,
  };
}

function gateInput(over: Partial<RiskGateInput> = {}): RiskGateInput {
  return {
    intent: makeIntent(),
    policy: makePolicy(),
    wallet: makeWallet(),
    venueMode: "NORMAL",
    leaseEpoch: 1,
    now: new Date("2026-01-01T00:00:30Z"),
    policyHash: "ph_audited",
    ...over,
  };
}

describe("Control — risk gate (validateAndReserve)", () => {
  it("reserves funds and issues an execution permit within policy", async () => {
    const { balance, kernel } = makeKernel();
    const input = gateInput();
    const res = await validateAndReserve(input, kernel);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.permit.intent_id, input.intent.intent_id);
      assert.equal(res.permit.venue_mode, "NORMAL");
      assert.equal(res.decision.status, "ACCEPTED");
      assert.equal(res.decision.intent_id, input.intent.intent_id);
      assert.equal(balance.committed, 5_000_000n); // 10 shares * 0.5
    }
  });

  it("rejects when the order exceeds max_order_pct (without reserving)", async () => {
    const { balance, kernel } = makeKernel();
    const res = await validateAndReserve(
      gateInput({ intent: makeIntent({ desired_qty: 200, limit_price: 0.5 }) }),
      kernel,
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "ORDER_PCT_EXCEEDED");
    assert.equal(balance.committed, 0n);
  });

  it("rejects when cumulative market exposure exceeds max_market_pct", async () => {
    const { kernel } = makeKernel();
    const res = await validateAndReserve(
      gateInput({
        intent: makeIntent({ desired_qty: 40, limit_price: 0.5 }), // 20 USD
        currentMarketExposureUsd: 185, // 185 + 20 = 205 > 200
      }),
      kernel,
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "MARKET_PCT_EXCEEDED");
  });

  it("rejects when cumulative portfolio exposure exceeds max_portfolio_pct", async () => {
    const { kernel } = makeKernel();
    const res = await validateAndReserve(
      gateInput({
        intent: makeIntent({ desired_qty: 40, limit_price: 0.5 }), // 20 USD
        currentPortfolioExposureUsd: 990, // 990 + 20 = 1010 > 1000
      }),
      kernel,
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "PORTFOLIO_PCT_EXCEEDED");
  });

  it("surfaces kernel rejections such as insufficient funds", async () => {
    const { kernel } = makeKernel(new FakeBalanceStore(1_000_000n)); // 1 pUSD
    const res = await validateAndReserve(gateInput(), kernel);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "INSUFFICIENT_FUNDS");
  });

  it("blocks a trade without a commissioned capital cap", async () => {
    const { kernel } = makeKernel();
    const res = await validateAndReserve(
      gateInput({
        policy: makePolicy({ capital_usd_cap: null }),
      }),
      kernel,
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "NO_CAPITAL_BASIS");
  });

  it("requires a size or notional in the intent", async () => {
    const { kernel } = makeKernel();
    const res = await validateAndReserve(
      gateInput({
        intent: makeIntent({ desired_qty: undefined, desired_notional: undefined }),
      }),
      kernel,
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "SIZE_REQUIRED");
  });

  it("requires a price in the intent", async () => {
    const { kernel } = makeKernel();
    const res = await validateAndReserve(
      gateInput({
        intent: makeIntent({ limit_price: undefined, price: undefined }),
      }),
      kernel,
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "PRICE_REQUIRED");
  });

  it("sizes from desired_notional when desired_qty is absent", async () => {
    const { balance, kernel } = makeKernel();
    const res = await validateAndReserve(
      gateInput({
        intent: makeIntent({ desired_qty: undefined, desired_notional: 25, limit_price: 0.5 }),
      }),
      kernel,
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(balance.committed, 25_000_000n); // 50 shares * 0.5
  });
});