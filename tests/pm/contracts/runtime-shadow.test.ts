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
} from "@polyroot/venue";
import type { VenueMode } from "@polyroot/domain";
import {
  DEFAULT_RISK_POLICY,
  type MarketSnapshot,
  type SignedOrder,
  type WalletIdentity,
} from "@polyroot/domain";
import { createG4Pipeline } from "@polyroot/runtime";

describe("Runtime MICRO_LIVE — G4 pipeline live path through executor", () => {
  class FakeBalanceStore implements BalanceStore {
    available: bigint;
    committed = 0n;
    reserveCalled = false;
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
      this.reserveCalled = true;
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
          return {
            ok: true,
            reservationId: randomUUID(),
            permitId: randomUUID(),
          };
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

  class ShadowVenueAdapter implements VenueAdapter {
    mode: VenueMode = "NORMAL";
    placeOrderCalls = 0;
    setMode(mode: VenueMode): void {
      this.mode = mode;
    }
    async getOrderBook(): Promise<MarketSnapshot> {
      return {
        market_id: "shadow_mkt",
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

  function makeShadowPipeline(
    forecastP: number | null,
    customAdapter?: VenueAdapter,
    capitalUsd = 10_000,
  ) {
    const balance = new FakeBalanceStore(1_000_000_000n);
    const kernel = new MoneyKernel({
      balance,
      sink: new FakeSink(),
      authority: fakeAuthority,
      chainId: 137,
      mode: "MICRO_LIVE",
      permitTtlMs: 60_000,
    });
    const signer = new SignerVault({
      expectedChainId: 137,
      cryptoSigner: async () => "sig_shadow",
    });
    const seen = new Map<string, OrderLifecycleState>();
    const adapter = customAdapter ?? new ShadowVenueAdapter();
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
        microLiveCapUsd: capitalUsd,
        liveLossCapPusd: 100,
      },
      kernel,
      signer,
      executor,
      wallet: makeWallet(),
      policy: {
        ...DEFAULT_RISK_POLICY,
        policy_version: "v0-bootstrap",
        capital_usd_cap: capitalUsd,
      },
      policyHash: "ph_shadow",
      venueMode: () => adapter.mode,
      leaseEpoch: () => 1,
      now: () => NOW,
      forecast: async () => forecastP,
      sizeIntent: () => 100,
      liveGuard: {
        loadLatch: async () => null,
        saveLatch: async () => undefined,
        realizedLossPusd: () => 0,
      },
    });
    return { pipeline, balance, venueAdapter: adapter as ShadowVenueAdapter };
  }

  beforeEach(() => {
    delete (globalThis as any).__fakeBalanceStore;
  });

  afterEach(() => {
    delete (globalThis as any).__fakeBalanceStore;
  });

  it("tradable market in MICRO_LIVE submits through the executor (live path)", async () => {
    // Capital sized so the honest ask-based limit ($55) clears max_order_pct.
    const { pipeline, venueAdapter } = makeShadowPipeline(
      0.65,
      undefined,
      100_000,
    );
    const result = await pipeline.processMarket({
      market_id: "mkt_shadow_1",
      bid: 0.45,
      ask: 0.55,
    });

    assert.equal(result.decision, "BUY");
    assert.equal(result.outcome, "SUBMITTED");
    assert.ok(result.orderId);
    assert.equal(pipeline.getFinancialGate(), "ALLOW");

    // Live path: the order reaches the venue adapter exactly once.
    assert.equal(
      venueAdapter.placeOrderCalls,
      1,
      "MICRO_LIVE mode must submit through executor.submit → placeOrder",
    );
  });

  it("uncertain forecast in MICRO_LIVE abstains with NO_TRADE (no venue financial I/O)", async () => {
    const { pipeline, venueAdapter } = makeShadowPipeline(0.5);
    const result = await pipeline.processMarket({
      market_id: "mkt_shadow_2",
      bid: 0.45,
      ask: 0.55,
    });

    assert.equal(result.decision, "NO_TRADE");
    assert.equal(result.reason, "forecast uncertain or unavailable");

    assert.equal(venueAdapter.placeOrderCalls, 0);
  });

  it("MICRO_LIVE respects ENTRY_BLOCKED when venue is UNAVAILABLE", async () => {
    const unavailableAdapter = new ShadowVenueAdapter();
    unavailableAdapter.mode = "UNAVAILABLE";

    const { pipeline, venueAdapter } = makeShadowPipeline(
      0.65,
      unavailableAdapter,
    );
    const result = await pipeline.processMarket({
      market_id: "mkt_shadow_3",
      bid: 0.45,
      ask: 0.55,
    });

    assert.equal(result.decision, "NO_TRADE");
    assert.equal(result.reason, "Financial gate: ENTRY_BLOCKED");
    assert.equal(pipeline.getFinancialGate(), "ENTRY_BLOCKED");

    assert.equal(venueAdapter.placeOrderCalls, 0);
  });
});
