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
  type OrderResult,
  type SignedOrder,
  type WalletIdentity,
} from "@polyroot/domain";
import {
  createG4Pipeline,
  deriveLiveFill,
  releaseUnsubmittedReservation,
  sessionPnlFromFill,
  submitExposureUsd,
  type LiveGuardDeps,
} from "@polyroot/runtime";

class FakeBalanceStore implements BalanceStore {
  available: bigint;
  committed = 0n;
  releaseCalls = 0;
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
    this.releaseCalls += 1;
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
  async push(): Promise<void> {
    return undefined;
  }
}

const NOW = new Date("2026-01-01T00:00:30Z");
const STARTING_CASH = 1_000_000_000n;

const wallet = {
  schema_version: "1.1",
  wallet_id: randomUUID(),
  wallet_type: "DEPOSIT_WALLET",
  signer_address: "0xSIGNER",
  account_wallet: "0xACCOUNT",
  funder: "0xFUNDER",
  chain_id: 137,
  verified_at: new Date("2026-01-01T00:00:00Z"),
} as WalletIdentity;

function makePipeline(opts: {
  capUsd?: number;
  lossCapUsd?: number;
  guard?: LiveGuardDeps;
  size?: number;
  ack?: Partial<OrderResult>;
  signerThrows?: boolean;
  wireRelease?: boolean;
}) {
  const balance = new FakeBalanceStore(STARTING_CASH);
  const reserved = new Map<string, bigint>();
  const releasedIds: string[] = [];
  const authority: MoneyAuthority = {
    async reserve(
      _account: string,
      _asset: string,
      cashNeededBase: bigint,
    ): Promise<MoneyAuthorityResult> {
      const reservationId = randomUUID();
      reserved.set(reservationId, cashNeededBase);
      await balance.reserveFunds("0xFUNDER", "pUSD", cashNeededBase);
      return { ok: true, reservationId, permitId: randomUUID() };
    },
  };
  const kernel = new MoneyKernel({
    balance,
    sink: new FakeSink(),
    authority,
    chainId: 137,
    mode: "LIVE",
    permitTtlMs: 60_000,
  });
  const signer = new SignerVault({
    expectedChainId: 137,
    cryptoSigner: async () => {
      if (opts.signerThrows) throw new Error("signer down");
      return "sig_live";
    },
  });
  const seen = new Map<string, OrderLifecycleState>();
  let sessionPnl = 0;
  const adapter = new (class implements VenueAdapter {
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
        source_at: NOW,
        received_at: NOW,
        schema_version: "1.1",
      };
    }
    async placeOrder(_o: SignedOrder): Promise<SubmitOutcome> {
      this.placeOrderCalls += 1;
      return {
        ok: true,
        result: {
          success: true,
          timestamp: NOW,
          ...opts.ack,
        },
      };
    }
    async cancelOrder(): Promise<SubmitOutcome> {
      return { ok: true, result: { success: true, timestamp: NOW } };
    }
    async getOrderStatus(): Promise<null> {
      return null;
    }
    setMode(mode: VenueMode): void {
      this.mode = mode;
    }
  })();
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
  const guard: LiveGuardDeps = opts.guard ?? {
    loadLatch: async () => null,
    saveLatch: async () => undefined,
    realizedLossPusd: () => Math.max(0, -sessionPnl),
  };
  const pipeline = createG4Pipeline({
    config: {
      mode: "LIVE",
      minEdgeAfterCost: 0.01,
      microLiveCapUsd: opts.capUsd ?? 500,
      liveLossCapPusd: opts.lossCapUsd ?? 100,
      liveAdmission: { admitted: true },
    },
    kernel,
    signer,
    executor,
    wallet,
    policy: {
      ...DEFAULT_RISK_POLICY,
      policy_version: "v0-bootstrap",
      capital_usd_cap: 10000,
      max_order_pct: 0.9,
      max_market_pct: 1,
      max_portfolio_pct: 1,
    },
    policyHash: "ph_live",
    venueMode: () => adapter.mode,
    leaseEpoch: () => 1,
    now: () => NOW,
    forecast: async () => 0.65,
    sizeIntent: () => opts.size ?? 10,
    liveGuard: guard,
    observability: {
      emitMetrics: (m) => {
        sessionPnl = m.totalPnl;
      },
    },
    ...(opts.wireRelease === false
      ? {}
      : {
          releaseReservation: async (id: string) => {
            releasedIds.push(id);
            const cash = reserved.get(id);
            if (cash === undefined) return;
            reserved.delete(id);
            await balance.releaseFunds("0xFUNDER", "pUSD", cash);
          },
        }),
  });
  return {
    pipeline,
    adapter,
    balance,
    releasedIds,
    kernel,
    sessionPnlRef: () => sessionPnl,
  };
}

const book = (market_id: string) => ({
  market_id,
  bid: 0.45,
  ask: 0.55,
});

describe("live submit accounting", () => {
  it("books reserved notional and does not call the submit a failure", async () => {
    const { pipeline, adapter, balance, releasedIds } = makePipeline({});
    const res = await pipeline.processMarket(book("mkt_a"));
    assert.equal(res.decision, "BUY");
    assert.equal(res.outcome, "SUBMITTED");
    assert.equal(res.reason, undefined);
    assert.equal(res.fill, undefined);
    assert.equal(res.pnl, 0);
    assert.equal(adapter.placeOrderCalls, 1);
    assert.ok((res.reservedExposureUsd ?? 0) > 0);
    assert.equal(pipeline.openExposureUsd(), res.reservedExposureUsd);
    assert.equal(releasedIds.length, 0);
    assert.ok(balance.committed > 0n);
    const metrics = pipeline.getMetrics();
    assert.equal(metrics.currentExposureUsd, pipeline.openExposureUsd());
    assert.equal(metrics.totalPnl, 0);
  });

  it("feeds tracker exposure into the next cap check", async () => {
    const { pipeline, adapter, releasedIds, balance } = makePipeline({
      capUsd: 8,
    });
    const first = await pipeline.processMarket(book("mkt_a"));
    assert.equal(first.decision, "BUY");
    const booked = pipeline.openExposureUsd();
    assert.ok(booked > 0 && booked <= 8);
    const second = await pipeline.processMarket(book("mkt_b"));
    assert.equal(second.decision, "NO_TRADE");
    assert.match(second.reason ?? "", /EXPOSURE_CAP_EXCEEDED/);
    assert.equal(adapter.placeOrderCalls, 1);
    assert.equal(pipeline.openExposureUsd(), booked);
    assert.equal(releasedIds.length, 1);
    assert.equal(balance.committed > 0n, true);
  });

  it("books venue fill PnL into metrics the loss latch reads", async () => {
    const { pipeline, adapter } = makePipeline({
      lossCapUsd: 1,
      ack: { filled_size: 10, average_price: 0.9, fee_paid: 0 },
    });
    const first = await pipeline.processMarket(book("mkt_a"));
    assert.equal(first.decision, "BUY");
    assert.equal(first.fill?.status, "FILLED");
    assert.equal(first.fill?.feeModel, "venue");
    assert.ok((first.pnl ?? 0) < -1);
    assert.equal(first.reason, undefined);
    assert.equal(pipeline.getMetrics().filledOrders, 1);
    assert.ok(pipeline.getMetrics().totalPnl < -1);
    assert.ok(pipeline.openExposureUsd() > 0);
    const second = await pipeline.processMarket(book("mkt_b"));
    assert.equal(second.decision, "NO_TRADE");
    assert.match(second.reason ?? "", /LOSS_CAP_LATCHED|LOSS_CAP_BREACHED/);
    assert.equal(adapter.placeOrderCalls, 1);
  });

  it("releases the reservation when the loss latch refuses after reserve", async () => {
    const { pipeline, adapter, balance, releasedIds } = makePipeline({
      lossCapUsd: 1,
      guard: {
        loadLatch: async () => ({
          halted: true,
          haltedAt: "2026-01-01T00:00:00.000Z",
          realizedLossPusd: 5,
        }),
        saveLatch: async () => undefined,
        realizedLossPusd: () => 5,
      },
    });
    const res = await pipeline.processMarket(book("mkt_a"));
    assert.equal(res.decision, "NO_TRADE");
    assert.match(res.reason ?? "", /LOSS_CAP_LATCHED/);
    assert.equal(adapter.placeOrderCalls, 0);
    assert.equal(releasedIds.length, 1);
    assert.equal(balance.committed, 0n);
    assert.equal(balance.available, STARTING_CASH);
  });

  it("releases when signing fails, and a second release does not credit twice", async () => {
    const { pipeline, adapter, balance, kernel } = makePipeline({
      signerThrows: true,
      wireRelease: false,
    });
    const before = balance.available;
    const res = await pipeline.processMarket(book("mkt_a"));
    assert.equal(res.decision, "NO_TRADE");
    assert.match(res.reason ?? "", /SIGN_ENGINE_ERROR|signer down/);
    assert.equal(adapter.placeOrderCalls, 0);
    assert.equal(balance.committed, 0n);
    assert.equal(balance.available, before);
    const releaseCalls = balance.releaseCalls;
    await releaseUnsubmittedReservation(
      { kernel, wallet: { funder: "0xFUNDER" } },
      { max_cash_base: 5_500_000n, reservation_ids: [] },
    );
    assert.equal(balance.available, STARTING_CASH);
    assert.equal(balance.committed, 0n);
    assert.equal(balance.releaseCalls, releaseCalls);
  });

  it("derives a partial fill and the theta fee when the ACK omits fee_paid", () => {
    const fill = deriveLiveFill(
      { size: 10, price: 0.5 },
      { filled_size: 4, average_price: 0.4 },
    );
    assert.ok(fill);
    assert.equal(fill.status, "PARTIAL");
    assert.equal(fill.feeModel, "theta");
    assert.ok(Math.abs(fill.takerFee - 4 * 0.05 * 0.4 * 0.6) < 1e-12);
    const exposure = submitExposureUsd({
      orderSize: 10,
      limitPrice: 0.5,
      fill,
    });
    assert.ok(Math.abs(exposure - (0.4 * 4 + 0.5 * 6)) < 1e-12);
    const pnl = sessionPnlFromFill({
      p: 0.65,
      quotedSide: "YES",
      fill,
    });
    assert.ok(pnl < 4 * (0.65 - 0.4));
  });
});
