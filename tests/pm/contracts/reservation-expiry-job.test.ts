import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReservationManager } from "@polyroot/risk";

function fakePool(rows: Array<{ id: string }>) {
  return {
    query: async (text: string) => {
      if (text.includes("SELECT id FROM reservations"))
        return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 1 };
    },
    connect: async () => ({
      query: async () => ({
        rows: [
          {
            account: "a",
            asset: "pUSD",
            amount: "100",
            consumed_amount: "0",
            released_amount: "0",
            status: "ACTIVE",
          },
        ],
        rowCount: 1,
      }),
      release: () => {},
    }),
  };
}

describe("reservation expiry job", () => {
  it("expires every overdue ACTIVE reservation and reports the count", async () => {
    const mgr = new ReservationManager({
      balanceStore: {} as never,
      permitStore: {} as never,
      pool: fakePool([{ id: "r1" }, { id: "r2" }]) as never,
    });
    const res = await mgr.expireOverdue(new Date());
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.expired, 2);
  });

  it("returns zero when nothing is overdue", async () => {
    const mgr = new ReservationManager({
      balanceStore: {} as never,
      permitStore: {} as never,
      pool: fakePool([]) as never,
    });
    const res = await mgr.expireOverdue(new Date());
    assert.deepEqual(res, { ok: true, expired: 0 });
  });
});

describe("reservation NUMERIC(18,8) decimal strings (real PG format)", () => {
  // PostgreSQL NUMERIC(18,8) arrives as "500000.00000000" — BigInt() throws
  // on decimal strings, which broke every release/consume against a real DB.
  function decimalPool() {
    return {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => ({
        query: async (text: string) => {
          if (text.includes("SELECT account")) {
            return {
              rows: [
                {
                  account: "a",
                  asset: "pUSD",
                  amount: "500000.00000000",
                  consumed_amount: "0.00000000",
                  released_amount: "0.00000000",
                  status: "ACTIVE",
                },
              ],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 1 };
        },
        release: () => {},
      }),
    };
  }

  it("expire() succeeds on decimal-formatted amounts", async () => {
    const mgr = new ReservationManager({
      balanceStore: {} as never,
      permitStore: {} as never,
      pool: decimalPool() as never,
    });
    const res = await mgr.expire("r-decimal");
    assert.equal(res.ok, true);
  });

  it("consume() succeeds on decimal-formatted amounts", async () => {
    const poolWithExpiry = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => ({
        query: async (text: string) => {
          if (text.includes("SELECT account")) {
            return {
              rows: [
                {
                  account: "a",
                  asset: "pUSD",
                  amount: "500000.00000000",
                  status: "ACTIVE",
                  consumed_amount: "0.00000000",
                  expires_at: new Date(Date.now() + 60_000),
                },
              ],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 1 };
        },
        release: () => {},
      }),
    };
    const mgr = new ReservationManager({
      balanceStore: {} as never,
      permitStore: {} as never,
      pool: poolWithExpiry as never,
    });
    const res = await mgr.consume("r-decimal", 100000n);
    assert.equal(res.ok, true);
  });
});
