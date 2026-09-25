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
