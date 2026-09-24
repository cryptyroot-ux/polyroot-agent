import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
} from "@polyroot/venue";
import {
  DEFAULT_RISK_POLICY,
  type MarketSnapshot,
  type SignedOrder,
  type VenueMode,
  type WalletIdentity,
} from "@polyroot/domain";
import { createG4Pipeline } from "@polyroot/runtime";

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
  async push(topic: string, payload: unknown): Promise<void> {
    this.events.push({ topic, payload });
  }
}

const fakeAuthority: MoneyAuthority = {
  async reserve(
    account: string,
    asset: string,
    cashNeededBase: bigint,
  ): Promise<MoneyAuthorityResult> {
    const balanceStore = (
      globalThis as unknown as { __fakeBalanceStore?: FakeBalanceStore }
    ).__fakeBalanceStore;
    if (balanceStore) {
      try {
        await balanceStore.reserveFunds(account, asset, cashNeededBase);
      } catch {
        return {
          ok: false,
          code: "INSUFFICIENT_FUNDS",
          reason: "insufficient available balance",
        };
      }
    }
    return { ok: true, reservationId: randomUUID(), permitId: randomUUID() };
  },
};

class FakeAdapter implements VenueAdapter {
  mode: VenueMode = "NORMAL";
  placeOrderCalls = 0;
  async getOrderBook(): Promise<MarketSnapshot> {
    throw new Error("not used in PAPER e2e");
  }
  async placeOrder(_o: SignedOrder): Promise<SubmitOutcome> {
    this.placeOrderCalls += 1;
    return {
      ok: true,
      result: {
        success: true,
        submit_status: "ACKNOWLEDGED",
        timestamp: new Date(),
      },
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

function makeWallet(): WalletIdentity {
  return {
    schema_version: "1.1",
    wallet_id: randomUUID(),
    wallet_type: "DEPOSIT_WALLET",
    signer_address: "0xSIGNER",
    account_wallet: "0xACCOUNT",
    funder: "0xFUNDER",
    chain_id: 137,
    verified_at: new Date("2026-01-01T00:00:00Z"),
  };
}

function makePipeline(forecastP: number | null) {
  const balance = new FakeBalanceStore(1_000_000_000n);
  (
    globalThis as unknown as { __fakeBalanceStore?: FakeBalanceStore }
  ).__fakeBalanceStore = balance;
  const kernel = new MoneyKernel({
    balance,
    sink: new FakeSink(),
    authority: fakeAuthority,
    chainId: 137,
    mode: "PAPER",
    permitTtlMs: 60_000,
  });
  const signer = new SignerVault({
    expectedChainId: 137,
    cryptoSigner: async () => "sig_e2e",
  });
  const seen = new Map<string, OrderLifecycleState>();
  const executor = new Executor({
    adapter: new FakeAdapter(),
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
    config: { mode: "PAPER", minEdgeAfterCost: 0.01 },
    kernel,
    signer,
    executor,
    wallet: makeWallet(),
    policy: {
      ...DEFAULT_RISK_POLICY,
      policy_version: "v0-bootstrap",
      capital_usd_cap: 10_000,
    },
    policyHash: "ph_e2e",
    venueMode: () => "NORMAL" as VenueMode,
    leaseEpoch: () => 1,
    now: () => NOW,
    forecast: async () => forecastP,
    sizeIntent: () => 100,
  });
  return { pipeline, balance };
}

describe("Runtime E2E — G4 PAPER pipeline with in-memory fakes (P0-5)", () => {
  it("tradable market produces a decision with simulated fill and metrics", async () => {
    const { pipeline } = makePipeline(0.65);
    const result = await pipeline.processMarket({
      market_id: "mkt_e2e_1",
      bid: 0.45,
      ask: 0.55,
    });
    assert.equal(result.decision, "BUY");
    assert.ok(result.fill !== undefined);
    assert.equal(pipeline.getMetrics().totalOrders, 1);
  });

  it("uncertain forecast abstains with NO_TRADE", async () => {
    const { pipeline } = makePipeline(0.5);
    const result = await pipeline.processMarket({
      market_id: "mkt_e2e_2",
      bid: 0.45,
      ask: 0.55,
    });
    assert.equal(result.decision, "NO_TRADE");
  });

  it("exposure above capital cap is refused", async () => {
    const { pipeline } = makePipeline(0.65);
    const result = await pipeline.processMarket({
      market_id: "mkt_e2e_3",
      bid: 0.45,
      ask: 0.55,
      currentPortfolioExposureUsd: 1_000_000_000,
    });
    assert.equal(result.decision, "NO_TRADE");
  });
});
