import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "crypto";
import {
  validatePermit,
  ReservationManager,
  PgMoneyAuthority,
} from "@polyroot/risk";

describe("Phase 7.6 gap fix: risk error-code taxonomy (fail-closed)", () => {
  it("validatePermit rejects expired permits with PERMIT_EXPIRED", () => {
    const res = validatePermit(
      {
        expires_at: new Date("2026-01-01T00:00:00Z"),
        policy_hash: "ph_expected",
        lease_epoch: 1,
      },
      {
        policyHash: "ph_expected",
        leaseEpoch: 1,
        now: new Date("2026-09-23T00:00:00Z"),
      },
    );
    assert.equal(res.ok, false);
    if (res.ok) throw new Error("expected failure");
    assert.equal(res.code, "PERMIT_EXPIRED");
  });

  it("validatePermit rejects policy hash mismatch with POLICY_HASH_MISMATCH", () => {
    const res = validatePermit(
      {
        expires_at: new Date("2026-09-23T01:00:00Z"),
        policy_hash: "ph_other",
        lease_epoch: 1,
      },
      {
        policyHash: "ph_expected",
        leaseEpoch: 1,
        now: new Date("2026-09-23T00:00:00Z"),
      },
    );
    assert.equal(res.ok, false);
    if (res.ok) throw new Error("expected failure");
    assert.equal(res.code, "POLICY_HASH_MISMATCH");
  });

  it("validatePermit rejects lease epoch mismatch with LEASE_EPOCH_MISMATCH", () => {
    const res = validatePermit(
      {
        expires_at: new Date("2026-09-23T01:00:00Z"),
        policy_hash: "ph_expected",
        lease_epoch: 2,
      },
      {
        policyHash: "ph_expected",
        leaseEpoch: 1,
        now: new Date("2026-09-23T00:00:00Z"),
      },
    );
    assert.equal(res.ok, false);
    if (res.ok) throw new Error("expected failure");
    assert.equal(res.code, "LEASE_EPOCH_MISMATCH");
  });

  it("validatePermit accepts a matching permit", () => {
    const res = validatePermit(
      {
        expires_at: new Date("2026-09-23T01:00:00Z"),
        policy_hash: "ph_expected",
        lease_epoch: 1,
      },
      {
        policyHash: "ph_expected",
        leaseEpoch: 1,
        now: new Date("2026-09-23T00:00:00Z"),
      },
    );
    assert.equal(res.ok, true);
  });

  it("PgMoneyAuthority.reserve rejects non-positive lease epoch without touching the DB", async () => {
    // No real Pool is created: the lease check runs before connect().
    // If the implementation ever moves the check after connect, this test
    // fails because fakePool.connect throws.
    const fakePool = {
      connect: async () => {
        throw new Error("DB_TOUCHED");
      },
    };
    const auth = new PgMoneyAuthority({ pool: fakePool } as any);
    for (const badEpoch of [0, -1, 1.5, Number.NaN]) {
      const res = await auth.reserve(
        "acct",
        "pUSD",
        100n,
        randomUUID(),
        randomUUID(),
        badEpoch,
        new Date(),
        100n,
        "ph_expected",
        `quote_${randomUUID()}`,
      );
      assert.equal(res.ok, false);
      if (res.ok) throw new Error("expected failure");
      assert.equal(res.code, "LEASE_EPOCH_MISMATCH");
    }
  });

  it("PgMoneyAuthority.reserve returns BALANCE_ROW_MISSING (not INSUFFICIENT) when the balance row is absent", async () => {
    const calls: string[] = [];
    const fakeClient = {
      query: async (sql: string) => {
        calls.push(sql);
        if (sql.includes("BEGIN")) return { rowCount: 0, rows: [] };
        if (sql.includes("SET TRANSACTION")) return { rowCount: 0, rows: [] };
        if (sql.includes("FROM reservations WHERE intent_id"))
          return { rowCount: 0, rows: [] };
        if (sql.includes("FROM balance_entries WHERE account"))
          return { rowCount: 0, rows: [] };
        if (sql.includes("ROLLBACK")) return { rowCount: 0, rows: [] };
        return { rowCount: 0, rows: [] };
      },
      release: () => {},
    };
    const fakePool = {
      connect: async () => fakeClient,
    };
    const auth = new PgMoneyAuthority({ pool: fakePool } as any);
    const res = await auth.reserve(
      "never_funded_acct",
      "pUSD",
      100n,
      randomUUID(),
      randomUUID(),
      1,
      new Date(),
      100n,
      "ph_expected",
      `quote_${randomUUID()}`,
    );
    assert.equal(res.ok, false);
    if (res.ok) throw new Error("expected failure");
    assert.equal(res.code, "BALANCE_ROW_MISSING");
  });

  it("ReservationManager.consume blocks settlement of an expired reservation (PERMIT_EXPIRED)", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const fakeClient = {
      query: async (sql: string) => {
        if (sql.includes("BEGIN")) return { rowCount: 0, rows: [] };
        if (sql.includes("FROM reservations WHERE id"))
          return {
            rowCount: 1,
            rows: [
              {
                account: "acct",
                asset: "pUSD",
                amount: "1000000",
                status: "ACTIVE",
                consumed_amount: "0",
                expires_at: past,
              },
            ],
          };
        if (sql.includes("ROLLBACK")) return { rowCount: 0, rows: [] };
        throw new Error(`UNEXPECTED_QUERY: ${sql}`);
      },
      release: () => {},
    };
    const fakePool = {
      connect: async () => fakeClient,
    };
    const mgr = new ReservationManager({
      balanceStore: {} as any,
      permitStore: {} as any,
      pool: fakePool as any,
    });
    const res = await mgr.consume(randomUUID(), 100n);
    assert.equal(res.ok, false);
    if (res.ok) throw new Error("expected failure");
    assert.equal(res.code, "PERMIT_EXPIRED");
  });
});
