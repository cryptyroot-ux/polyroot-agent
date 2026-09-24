import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "crypto";
import {
  MoneyKernel,
  type BalanceStore,
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
import { createG4Pipeline, type G4CoreObservability } from "@polyroot/runtime";

describe("Runtime Observability Hooks & Continuous Run (Gaps 8.5, 8.7)", () => {
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

  class ObservableAdapter implements VenueAdapter {
    mode: VenueMode = "NORMAL";
    async getOrderBook(): Promise<MarketSnapshot> {
      return {
        market_id: "mkt_obs",
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

  it("invokes observability hooks during pipeline execution", async () => {
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
      mode: "PAPER",
      permitTtlMs: 60_000,
    });
    const signer = new SignerVault({
      expectedChainId: 137,
      cryptoSigner: async () => "sig_obs",
    });
    const seen = new Map<string, OrderLifecycleState>();
    const adapter = new ObservableAdapter();
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

    const marketIdObs = "mkt_obs_1";
    const observed: Array<{ hook: string; args: unknown[] }> = [];
    const obs: G4CoreObservability = {
      emitStepStart: (input) =>
        observed.push({ hook: "emitStepStart", args: [input] }),
      emitStepComplete: (input, res) =>
        observed.push({ hook: "emitStepComplete", args: [input, res] }),
      emitFinancialGate: (gate, mode, venue) =>
        observed.push({ hook: "emitFinancialGate", args: [gate, mode, venue] }),
    };

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
      policyHash: "ph_obs",
      venueMode: () => adapter.mode,
      leaseEpoch: () => 1,
      now: () => NOW,
      forecast: async () => 0.65,
      sizeIntent: () => 10,
      observability: obs,
    });

    await pipeline.processMarket({
      market_id: marketIdObs,
      bid: 0.45,
      ask: 0.55,
    });

    const hookNames = observed.map((o) => o.hook);
    const calledHooks = new Set(hookNames);
    assert.ok(
      calledHooks.has("emitStepStart"),
      "emitStepStart should be called",
    );
    assert.ok(
      calledHooks.has("emitStepComplete"),
      "emitStepComplete should be called",
    );
    assert.ok(
      calledHooks.has("emitFinancialGate"),
      "emitFinancialGate should be called",
    );
  });

  it("runContinuous executes without throwing for a single iteration", async () => {
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
      mode: "PAPER",
      permitTtlMs: 60_000,
    });
    const signer = new SignerVault({
      expectedChainId: 137,
      cryptoSigner: async () => "sig_loop",
    });
    const seen = new Map<string, OrderLifecycleState>();
    const adapter = new ObservableAdapter();
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
      policyHash: "ph_loop",
      venueMode: () => adapter.mode,
      leaseEpoch: () => 1,
      now: () => NOW,
      forecast: async () => 0.65,
      sizeIntent: () => 10,
    });

    const runPromise = pipeline.runContinuous();
    await new Promise((r) => setTimeout(r, 100));
    pipeline.stop();
    await runPromise;
    const metrics = pipeline.getMetrics();
    assert.ok(metrics.totalOrders >= 1);
  });
});
