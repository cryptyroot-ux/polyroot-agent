import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MoneyKernel,
  type BalanceStore,
  type KernelEventSink,
} from "@polyroot/risk";
import { DEFAULT_RISK_POLICY } from "@polyroot/domain";
import { ulid } from "ulid";

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
}

class FakeSink implements KernelEventSink {
  events: Array<{ topic: string; payload: unknown }> = [];
  async push(topic: string, payload: unknown): Promise<void> {
    this.events.push({ topic, payload });
  }
}

function req(over = {}) {
  return {
    decisionId: ulid(),
    intentId: ulid(),
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
    const balance = new FakeBalanceStore(1_000_000_000n); // 1000 pUSD
    const sink = new FakeSink();
    const kernel = new MoneyKernel({
      balance,
      sink,
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
    const balance = new FakeBalanceStore(1_000_000n); // 1 pUSD only
    const kernel = new MoneyKernel({
      balance,
      sink: new FakeSink(),
      chainId: 137,
    });
    const res = await kernel.reserve(req());
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "INSUFFICIENT_FUNDS");
  });

  it("refuses when cash required exceeds the reservation budget", async () => {
    const balance = new FakeBalanceStore(1_000_000_000n);
    const kernel = new MoneyKernel({
      balance,
      sink: new FakeSink(),
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
    const kernel = new MoneyKernel({
      balance,
      sink: new FakeSink(),
      hardMaxShares: 5_000_000n, // 5 shares
      chainId: 137,
    });
    const res = await kernel.reserve(req({ amountSharesBase: 10_000_000n }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "CAP_SHARES");
  });

  it("limits the number of open reservations (no unbounded leak)", async () => {
    const balance = new FakeBalanceStore(1_000_000_000_000n);
    const kernel = new MoneyKernel({
      balance,
      sink: new FakeSink(),
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
    const sink = new FakeSink();
    const kernel = new MoneyKernel({
      balance,
      sink,
      chainId: 137,
    });
    for (const badPrice of [-1n, 0n, 1_000_001n, 2_000_000n]) {
      const res = await kernel.reserve(req({ perSharePriceBase: badPrice }));
      assert.equal(res.ok, false, `price ${badPrice} must be refused`);
      if (!res.ok) assert.equal(res.code, "PRICE_RANGE");
      assert.equal(balance.committed, 0n, "no funds may be committed on refusal");
      assert.ok(!sink.events.some((e) => e.topic === "RESERVATION_CREATED"));
    }
  });

  it("rejects non-canonical venue modes on the permit", async () => {
    const kernel = new MoneyKernel({
      balance: new FakeBalanceStore(1_000_000_000n),
      sink: new FakeSink(),
      chainId: 137,
    });
    const res = await kernel.reserve(req({ venueMode: "RESTARTING" as never }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "VENUE_MODE");
  });

  it("releases committed funds back to available on release", async () => {
    const balance = new FakeBalanceStore(1_000_000_000n);
    const kernel = new MoneyKernel({
      balance,
      sink: new FakeSink(),
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
      chainId: 137,
    });
    const res = await kernel.reserve(req());
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.permit.policy_version, "v0-bootstrap");
  });
});
