import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { randomUUID } from "crypto";
import {
  MoneyKernel,
  type BalanceStore,
  type KernelEventSink,
  type MoneyAuthority,
  type MoneyAuthorityResult,
} from "@polyroot/risk";
import { SignerVault } from "@polyroot/signer";
import { Executor, type OrderLifecycleState } from "@polyroot/executor";
import {
  MemPermitStore,
  MemRecoveryLedger,
  MemLeaseStore,
  type VenueAdapter,
  type SubmitOutcome,
  type VenueMode,
} from "@polyroot/venue";
import {
  DEFAULT_RISK_POLICY,
  type MarketSnapshot,
  type SignedOrder,
  type WalletIdentity,
} from "@polyroot/domain";
import {
  createG4Pipeline,
  type LiveGuardDeps,
  type LossGuardState,
} from "@polyroot/runtime";

class FakeBalanceStore implements BalanceStore {
  available: bigint;
  committed = 0n;
  constructor(available: bigint) {
    this.available = available;
  }
  async get() {
    return {
      account: "0xFUNDER",
      asset: "pUSD",
      availableBase: this.available,
      committedBase: this.committed,
    };
  }
  async reserveFunds(_a: string, _s: string, amount: bigint): Promise<void> {
    if (this.available < amount) throw new Error("INSUFFICIENT_AVAILABLE");
    this.available -= amount;
    this.committed += amount;
  }
  async releaseFunds(_a: string, _s: string, amount: bigint): Promise<void> {
    if (this.committed < amount) throw new Error("INSUFFICIENT_COMMITTED");
    this.committed -= amount;
    this.available += amount;
  }
  async consumeFunds(_a: string, _s: string, amount: bigint): Promise<void> {
    if (this.committed < amount) throw new Error("INSUFFICIENT_COMMITTED");
    this.committed -= amount;
  }
  async getOpenCount(): Promise<number> {
    return 0;
  }
}

class FakeSink implements KernelEventSink {
  events: Array<{ topic: string; payload: unknown }> = [];
  async push(topic: string, payload: unknown) {
    this.events.push({ topic, payload });
  }
}

const fakeAuthority: MoneyAuthority = {
  async reserve(): Promise<MoneyAuthorityResult> {
    return { ok: true, reservationId: randomUUID(), permitId: randomUUID() };
  },
};

class SpyVenueAdapter implements VenueAdapter {
  mode: VenueMode = "NORMAL";
  placeOrderCalls = 0;
  async getOrderBook(): Promise<MarketSnapshot> {
    return {
      market_id: "mkt_live_1",
      yes_price: 0.45,
      no_price: 0.55,
      event_id: "",
      question: "",
      chain_id: 137,
      collateral: "",
      rules_hash: "",
      fee_maker_bps: 0,
      fee_taker_bps: 200,
      tick_size: 0.01,
      min_size: 1,
      status: "ACTIVE",
      is_neg_risk: false,
      venue_mode: "NORMAL",
      source_at: new Date(),
      received_at: new Date(),
      schema_version: "1.1",
    };
  }
  async placeOrder(_o: SignedOrder): Promise<SubmitOutcome> {
    this.placeOrderCalls += 1;
    return {
      ok: true,
      result: { success: true, timestamp: new Date() },
    };
  }
  async cancelOrder(_id: string): Promise<SubmitOutcome> {
    return { ok: true, result: { success: true, timestamp: new Date() } };
  }
  async getOrderStatus(): Promise<null> {
    return null;
  }
}

const NOW = new Date("2026-01-01T00:00:30Z");

function openGuard(): LiveGuardDeps & { saved: LossGuardState[] } {
  const saved: LossGuardState[] = [];
  return {
    saved,
    loadLatch: async () => null,
    saveLatch: async (s: LossGuardState) => {
      saved.push(s);
    },
    realizedLossPusd: () => 0,
  };
}

function makePipeline(opts: {
  forecastP?: number | null;
  capUsd?: number;
  lossCapUsd?: number;
  guard?: LiveGuardDeps;
  omitGuard?: boolean;
  exposureUsd?: number;
  sizeIntentVal?: number;
}) {
  const {
    forecastP = 0.65,
    capUsd = 500,
    lossCapUsd = 100,
    omitGuard = false,
    exposureUsd = 0,
    sizeIntentVal = 10,
  } = opts;
  const guard = omitGuard ? undefined : (opts.guard ?? openGuard());
  const kernel = new MoneyKernel({
    balance: new FakeBalanceStore(1_000_000_000n),
    sink: new FakeSink(),
    authority: fakeAuthority,
    chainId: 137,
    mode: "MICRO_LIVE",
    permitTtlMs: 60_000,
  });
  const signer = new SignerVault({
    expectedChainId: 137,
    cryptoSigner: async () => "sig_live",
  });
  const seen = new Map<string, OrderLifecycleState>();
  const adapter = new SpyVenueAdapter();
  const executor = new Executor({
    adapter,
    now: () => NOW,
    seen: {
      has: (id: string) => seen.has(id),
      add: (id: string, state: OrderLifecycleState) => seen.set(id, state),
      get: (id: string) => seen.get(id),
    },
    permitStore: new MemPermitStore({ clock: () => NOW }),
    walletId: "0xWALLET",
    holder: "0xHOLDER",
    leaseStore: new MemLeaseStore({ clock: () => NOW }),
    recoveryLedger: new MemRecoveryLedger(),
    leaseEpoch: 1,
  });
  const pipeline = createG4Pipeline({
    config: {
      mode: "MICRO_LIVE",
      minEdgeAfterCost: 0.01,
      microLiveCapUsd: capUsd,
      liveLossCapPusd: lossCapUsd,
    },
    kernel,
    signer,
    executor,
    wallet: {
      schema_version: "1.1",
      wallet_id: randomUUID(),
      wallet_type: "DEPOSIT_WALLET",
      signer_address: "0xSIGNER",
      account_wallet: "0xACCOUNT",
      funder: "0xFUNDER",
      chain_id: 137,
      verified_at: new Date("2026-01-01T00:00:00Z"),
    } as WalletIdentity,
    policy: {
      ...DEFAULT_RISK_POLICY,
      policy_version: "v0-bootstrap",
      capital_usd_cap: 10000,
      max_order_pct: 0.9,
      max_market_pct: 1.0,
      max_portfolio_pct: 1.0,
    },
    policyHash: "ph_live",
    venueMode: () => adapter.mode,
    leaseEpoch: () => 1,
    now: () => NOW,
    forecast: async () => forecastP,
    sizeIntent: () => sizeIntentVal,
    liveGuard: guard,
  });
  return { pipeline, adapter };
}

const INPUT = (exposureUsd = 0) => ({
  market_id: "mkt_live_1",
  bid: 0.45,
  ask: 0.55,
  currentPortfolioExposureUsd: exposureUsd,
});

describe("live enforcement (cap + loss latch wired into the order path)", () => {
  beforeEach(() => {});
  afterEach(() => {});

  it("refuses when the exposure cap is unconfigured", async () => {
    const { pipeline, adapter } = makePipeline({ capUsd: 0 });
    const res = await pipeline.processMarket(INPUT());
    assert.equal(res.decision, "NO_TRADE");
    assert.match(res.reason ?? "", /MICRO_LIVE_CAP_UNCONFIGURED/);
    assert.equal(adapter.placeOrderCalls, 0);
  });

  it("refuses when exposure plus notional exceeds the cap", async () => {
    const { pipeline, adapter } = makePipeline({ exposureUsd: 498 });
    const res = await pipeline.processMarket(INPUT(498));
    assert.equal(res.decision, "NO_TRADE");
    assert.match(res.reason ?? "", /EXPOSURE_CAP_EXCEEDED/);
    assert.equal(adapter.placeOrderCalls, 0);
  });

  it("refuses when the loss cap is unconfigured", async () => {
    const { pipeline, adapter } = makePipeline({ lossCapUsd: 0 });
    const res = await pipeline.processMarket(INPUT());
    assert.equal(res.decision, "NO_TRADE");
    assert.match(res.reason ?? "", /LOSS_CAP_UNCONFIGURED/);
    assert.equal(adapter.placeOrderCalls, 0);
  });

  it("refuses when no live guard is wired", async () => {
    const { pipeline, adapter } = makePipeline({ omitGuard: true });
    const res = await pipeline.processMarket(INPUT());
    assert.equal(res.decision, "NO_TRADE");
    assert.match(res.reason ?? "", /LIVE_GUARD_UNWIRED/);
    assert.equal(adapter.placeOrderCalls, 0);
  });

  it("refuses on a latched breach without touching the venue", async () => {
    const saved: LossGuardState[] = [];
    const guard: LiveGuardDeps = {
      loadLatch: async () => ({
        halted: true,
        haltedAt: "2026-01-01T00:00:00.000Z",
        realizedLossPusd: 150,
      }),
      saveLatch: async (s: LossGuardState) => {
        saved.push(s);
      },
      realizedLossPusd: () => 150,
    };
    const { pipeline, adapter } = makePipeline({ guard, lossCapUsd: 100 });
    const res = await pipeline.processMarket(INPUT());
    assert.equal(res.decision, "NO_TRADE");
    assert.match(res.reason ?? "", /LOSS_CAP_LATCHED/);
    assert.equal(adapter.placeOrderCalls, 0);
    assert.equal(saved.length, 1);
  });

  it("submits when cap, loss, and latch are clear", async () => {
    const { pipeline, adapter } = makePipeline({});
    const res = await pipeline.processMarket(INPUT());
    assert.equal(res.decision, "BUY");
    assert.equal(adapter.placeOrderCalls, 1);
  });
});
