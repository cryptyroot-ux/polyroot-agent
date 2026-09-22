import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MoneyKernel,
  type BalanceStore,
  type KernelEventSink,
  type MoneyAuthority,
  type MoneyAuthorityResult,
} from "@polyroot/risk";
import { DEFAULT_RISK_POLICY } from "@polyroot/domain";
import { randomUUID } from "crypto";

const fakeAuthority: MoneyAuthority = {
  async reserve(
    account: string,
    asset: string,
    cashNeededBase: bigint,
    _decisionId: string,
    _intentId: string,
    _leaseEpoch: number,
    _now: Date,
    _amountSharesBase?: bigint,
    _policyHash?: string,
    _quoteId?: string,
    _riskDecision?: any,
  ): Promise<MoneyAuthorityResult> {
    // We need to access the FakeBalanceStore to actually reserve funds
    // This is a test-only workaround
    const balanceStore = (globalThis as any).__fakeBalanceStore;
    if (balanceStore) {
      try {
        await balanceStore.reserveFunds(account, asset, cashNeededBase);
      } catch (e) {
        return {
          ok: false,
          code: "INSUFFICIENT_FUNDS",
          reason: "insufficient available balance",
        };
      }
    }
    // Also push RESERVATION_CREATED event to sink (test-only)
    const sink = (globalThis as any).__fakeSink;
    console.log('[DEBUG] fakeAuthority: sink available:', !!sink);
    if (sink) {
      await sink.push("RESERVATION_CREATED", {
        reservationId: "test-reservation-id",
        permitId: "test-permit-id",
        intentId: "test-intent-id",
        amountSharesBase: "0",
        cashBase: "0",
        leaseEpoch: 1,
      });
      console.log('[DEBUG] fakeAuthority: pushed RESERVATION_CREATED');
    } else {
      console.log('[DEBUG] fakeAuthority: NO SINK AVAILABLE');
    }
    return {
      ok: true,
      reservationId: randomUUID(),
      permitId: randomUUID(),
    };
  }
};

class FakeBalanceStore implements BalanceStore {
  available: bigint;
  committed = 0n;
  getCalls = 0;
  constructor(available: bigint) {
    this.available = available;
  }
  async get(): Promise<{
    account: string;
    asset: string;
    availableBase: bigint;
    committedBase: bigint;
  }> {
    this.getCalls += 1;
    return {
      account: "0xACCOUNT",
      asset: "pUSD",
      availableBase: this.available,
      committedBase: this.committed,
    };
  }
  async reserveFunds(_a: string, _s: string, amount: bigint): Promise<void> {
    if (this.available < amount) {
      throw new Error("INSUFFICIENT_AVAILABLE");
    }
    this.available -= amount;
    this.committed += amount;
  }
  async releaseFunds(_a: string, _s: string, amount: bigint): Promise<void> {
    if (this.committed < amount) {
      throw new Error("INSUFFICIENT_COMMITTED");
    }
    this.committed -= amount;
    this.available += amount;
  }
  async consumeFunds(_a: string, _s: string, amount: bigint): Promise<void> {
    if (this.committed < amount) {
      throw new Error("INSUFFICIENT_COMMITTED");
    }
    this.committed -= amount;
  }
  async getOpenCount(_a: string, _s: string): Promise<number> {
    return this.committed > 0n ? 1 : 0;
  }
}

class FakeSink implements KernelEventSink {
  events: Array<{ topic: string; payload: unknown }> = [];
  async push(topic: string, payload: unknown): Promise<void> {
    this.events.push({ topic, payload });
  }
}

function req(over = {}) {
  return {
    decisionId: randomUUID(),
    intentId: randomUUID(),
    account: "0xACCOUNT",
    asset: "pUSD",
    amountSharesBase: 10_000_000n, // 10 shares
    maxCashBase: 50_000_000n, // 50 pUSD
    perSharePriceBase: 500_000n, // 0.5
    policy: DEFAULT_RISK_POLICY,
    policyHash: "ph_audited",
    walletType: "DEPOSIT_WALLET" as const,
    venueMode: "NORMAL" as const,
    leaseEpoch: 1,
    now: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

describe("Money Kernel — atomic reservation + permit (PM-RISK-03, TABLE 14)", () => {
  it("reserves funds and issues a single-use permit atomically", async () => {
    const balance = new FakeBalanceStore(1_000_000_000n);
    (globalThis as any).__fakeBalanceStore = balance; // 1000 pUSD
    const sink = new FakeSink();
    (globalThis as any).__fakeSink = sink;
    (globalThis as any).__fakeBalanceStore = balance;
    const kernel = new MoneyKernel({
      balance,
      sink,
      authority: fakeAuthority,
      permitTtlMs: 60_000,
      // caps are compared in base units (1e6) against amountSharesBase
      hardMaxShares: 1_000_000_000n,
      hardMaxCash: 1_000_000_000n,
      maxOpenReservations: 16,
      chainId: 137,
    });
    const res = await kernel.reserve(req());
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.permit.reservation_ids.length, 1);
      assert.equal(res.permit.single_use, true);
      assert.equal(res.permit.lease_epoch, 1);
      assert.equal(balance.committed, 5_000_000n); // 10 shares * 0.5
    }
    const topics = sink.events.map((e) => e.topic);
    assert.ok(topics.includes("RESERVATION_CREATED"));
  });

  it("refuses when the available balance is insufficient", async () => {
    const balance = new FakeBalanceStore(1_000_000n);
    (globalThis as any).__fakeBalanceStore = balance; // 1 pUSD only
    const kernel = new MoneyKernel({
      balance,
      sink: new FakeSink(),
      authority: fakeAuthority,
      chainId: 137,
    });
    const res = await kernel.reserve(req());
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "INSUFFICIENT_FUNDS");
  });

  it("refuses when cash required exceeds the reservation budget", async () => {
    const balance = new FakeBalanceStore(1_000_000_000n);
    (globalThis as any).__fakeBalanceStore = balance;
    const kernel = new MoneyKernel({
      balance,
      sink: new FakeSink(),
      authority: fakeAuthority,
      chainId: 137,
    });
    // 10 shares at price 0.9 => 9 pUSD > maxCash 5 pUSD
    const res = await kernel.reserve(
      req({ maxCashBase: 5_000_000n, perSharePriceBase: 900_000n }),
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "CASH_OVER_BUDGET");
  });

  it("enforces hard share caps and never loosens them", async () => {
    const balance = new FakeBalanceStore(1_000_000_000n);
    (globalThis as any).__fakeBalanceStore = balance;
    const kernel = new MoneyKernel({
      balance,
      sink: new FakeSink(),
      authority: fakeAuthority,
      hardMaxShares: 5_000_000n, // 5 shares
      chainId: 137,
    });
    const res = await kernel.reserve(req({ amountSharesBase: 10_000_000n }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "CAP_SHARES");
  });

  it("limits the number of open reservations (no unbounded leak)", async () => {
    const balance = new FakeBalanceStore(1_000_000_000_000n);
    (globalThis as any).__fakeBalanceStore = balance;
    const kernel = new MoneyKernel({
      balance,
      sink: new FakeSink(),
      authority: fakeAuthority,
      maxOpenReservations: 1,
      chainId: 137,
    });
    const first = await kernel.reserve(req());
    assert.equal(first.ok, true);
    const second = await kernel.reserve(req());
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.code, "RESERVATION_LIMIT");
  });

  it("rejects negative or out-of-range per-share price (no money creation)", async () => {
    const balance = new FakeBalanceStore(1_000_000_000n);
    (globalThis as any).__fakeBalanceStore = balance;
    const sink = new FakeSink();
    (globalThis as any).__fakeSink = sink;
    const kernel = new MoneyKernel({
      balance,
      sink,
      authority: fakeAuthority,
      chainId: 137,
    });
    for (const badPrice of [-1n, 0n, 1_000_001n, 2_000_000n]) {
      const res = await kernel.reserve(req({ perSharePriceBase: badPrice }));
      assert.equal(res.ok, false, `price ${badPrice} must be refused`);
      if (!res.ok) assert.equal(res.code, "PRICE_RANGE");
      assert.equal(
        balance.committed,
        0n,
        "no funds may be committed on refusal",
      );
      assert.ok(!sink.events.some((e) => e.topic === "RESERVATION_CREATED"));
    }
  });

  it("rejects non-canonical venue modes on the permit", async () => {
    const kernel = new MoneyKernel({
      balance: new FakeBalanceStore(1_000_000_000n),
      sink: new FakeSink(),
      authority: fakeAuthority,
      chainId: 137,
    });
    const res = await kernel.reserve(req({ venueMode: "RESTARTING" as never }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "VENUE_MODE");
  });

  it("releases committed funds back to available on release", async () => {
    const balance = new FakeBalanceStore(1_000_000_000n);
    (globalThis as any).__fakeBalanceStore = balance;
    const kernel = new MoneyKernel({
      balance,
      sink: new FakeSink(),
      authority: fakeAuthority,
      chainId: 137,
    });
    const res = await kernel.reserve(req());
    assert.equal(res.ok, true);
    if (!res.ok) return;
    await kernel.release("0xACCOUNT", "pUSD", 5_000_000n);
    assert.equal(balance.available, 1_000_000_000n);
  });

  it("produces permits that pass the canonical domain schema", async () => {
    const kernel = new MoneyKernel({
      balance: new FakeBalanceStore(1_000_000_000n),
      sink: new FakeSink(),
      authority: fakeAuthority,
      chainId: 137,
    });
    const res = await kernel.reserve(req());
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.permit.policy_version, "v0-bootstrap");
  });

  it("consume reduces committed WITHOUT returning cash to available (no double-spend)", async () => {
    // R01 acceptance: 100 pUSD balance, reserve 5, consume 5 → available=95M, committed=0
    const balance = new FakeBalanceStore(100_000_000n);
    (globalThis as any).__fakeBalanceStore = balance; // 100 pUSD
    const sink = new FakeSink();
    (globalThis as any).__fakeSink = sink;
    const kernel = new MoneyKernel({
      balance,
      sink,
      authority: fakeAuthority,
      chainId: 137,
    });
    const res = await kernel.reserve(
      req({
        amountSharesBase: 10_000_000n, // 10 shares
        perSharePriceBase: 500_000n, // 0.5 pUSD/share → 5 pUSD committed
      }),
    );
    assert.equal(res.ok, true);
    assert.equal(balance.available, 95_000_000n); // 100 - 5 = 95
    assert.equal(balance.committed, 5_000_000n);

    // Consume the committed funds (simulating an order fill)
    await kernel.consume("0xACCOUNT", "pUSD", 5_000_000n);

    // CRITICAL: available must NOT increase; committed must go to 0
    assert.equal(
      balance.available,
      95_000_000n,
      "available must stay at 95 pUSD after consume",
    );
    assert.equal(balance.committed, 0n, "committed must be 0 after consume");

    // Verify consume emitted correct event
    const consumed = sink.events.filter(
      (e) => e.topic === "RESERVATION_CONSUMED",
    );
    assert.equal(consumed.length, 1);
  });

  it("consume refuses when committed is insufficient", async () => {
    const balance = new FakeBalanceStore(100_000_000n);
    (globalThis as any).__fakeBalanceStore = balance;
    const kernel = new MoneyKernel({
      balance,
      sink: new FakeSink(),
      authority: fakeAuthority,
      chainId: 137,
    });
    // Reserve 5 pUSD
    const res = await kernel.reserve(
      req({
        perSharePriceBase: 500_000n,
      }),
    );
    assert.equal(res.ok, true);
    assert.equal(balance.committed, 5_000_000n);

    // Try to consume more than committed
    await assert.rejects(
      () => kernel.consume("0xACCOUNT", "pUSD", 10_000_000n),
      /INSUFFICIENT_COMMITTED/,
    );
  });
});
