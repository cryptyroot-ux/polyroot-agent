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
  type VenueMode,
} from "@polyroot/venue";
import {
  DEFAULT_RISK_POLICY,
  type MarketSnapshot,
  type SignedOrder,
  type WalletIdentity,
} from "@polyroot/domain";
import { createG4Pipeline } from "@polyroot/runtime";

describe("Runtime Mode Transitions & Metrics Accumulation (Gaps 8.4, 8.6)", () => {
  class FakeBalanceStore implements BalanceStore {
    available = 1_000_000_000n;
    committed = 0n;
    async get() {
      return {
        account: "0xFUNDER",
        asset: "pUSD",
        availableBase: this.available,
        committedBase: this.committed,
      };
    }
    async reserveFunds(_a: string, _s: string, amount: bigint) {
      this.available -= amount;
      this.committed += amount;
    }
    async releaseFunds(_a: string, _s: string, amount: bigint) {
      this.committed -= amount;
      this.available += amount;
    }
    async consumeFunds(_a: string, _s: string, amount: bigint) {
      this.committed -= amount;
    }
    async getOpenCount() {
      return 0;
    }
  }

  class SimpleAdapter implements VenueAdapter {
    mode: VenueMode = "NORMAL";
    async getOrderBook(): Promise<MarketSnapshot> {
      return {
        market_id: "mkt_trans",
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

  function makeTestPipeline(
    initialMode: "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE",
  ) {
    const balance = new FakeBalanceStore();
    const kernel = new MoneyKernel({
      balance,
      sink: { push: async () => {} },
      authority: {
        async reserve(): Promise<MoneyAuthorityResult> {
          return {
            ok: true,
            reservationId: randomUUID(),
            permitId: randomUUID(),
          };
        },
      },
      chainId: 137,
      mode: initialMode === "LIVE" ? "LIVE" : "MICRO_LIVE",
      permitTtlMs: 60_000,
    });
    const signer = new SignerVault({
      expectedChainId: 137,
      cryptoSigner: async () => "sig_test",
    });
    const seen = new Map<string, OrderLifecycleState>();
    const adapter = new SimpleAdapter();
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
        mode: initialMode,
        minEdgeAfterCost: 0.01,
        // Deterministic fills: the paper simulator is probabilistic by
        // default, which flakes the filledOrders assertion.
        paperFillConfig: {
          cancelProbability: 0,
          partialFraction: 1,
          latencyMs: 0,
        },
      },
      kernel,
      signer,
      executor,
      wallet: makeWallet(),
      policy: {
        ...DEFAULT_RISK_POLICY,
        policy_version: "v0-bootstrap",
        capital_usd_cap: 10_000,
      },
      policyHash: "ph_trans",
      venueMode: () => adapter.mode,
      leaseEpoch: () => 1,
      now: () => NOW,
      forecast: async () => 0.65,
      sizeIntent: () => 10,
    });
    return pipeline;
  }

  it("supports valid mode transitions (PAPER -> SHADOW -> MICRO_LIVE)", () => {
    const pipeline = makeTestPipeline("PAPER");
    assert.equal(pipeline.getMode(), "PAPER");

    pipeline.setMode("SHADOW");
    assert.equal(pipeline.getMode(), "SHADOW");

    pipeline.setMode("MICRO_LIVE");
    assert.equal(pipeline.getMode(), "MICRO_LIVE");
  });

  it("rejects invalid mode transitions (PAPER -> LIVE directly without intermediary)", () => {
    const pipeline = makeTestPipeline("PAPER");
    assert.equal(pipeline.getMode(), "PAPER");

    assert.throws(() => {
      pipeline.setMode("LIVE");
    }, /Invalid mode transition/);
  });

  it("accumulates metrics correctly across multiple market processing steps", async () => {
    const pipeline = makeTestPipeline("PAPER");

    const initialMetrics = pipeline.getMetrics();
    assert.equal(initialMetrics.totalOrders, 0);
    assert.equal(initialMetrics.filledOrders, 0);
    assert.equal(initialMetrics.totalPnl, 0);

    await pipeline.processMarket({ market_id: "mkt_1", bid: 0.45, ask: 0.55 });
    await pipeline.processMarket({ market_id: "mkt_2", bid: 0.45, ask: 0.55 });

    const updatedMetrics = pipeline.getMetrics();
    assert.equal(updatedMetrics.totalOrders, 2);
    assert.equal(updatedMetrics.filledOrders, 2);
    assert.ok(updatedMetrics.totalPnl !== undefined);
  });
});
