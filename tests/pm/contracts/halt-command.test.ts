import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { requestHalt } from "@polyroot/runtime";

interface FakePool {
  queries: string[];
  failOnWrite: boolean;
  orderRows: Record<string, unknown>[];
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

function makePool(orderRows: Record<string, unknown>[] = []): FakePool {
  const pool: FakePool = {
    queries: [],
    failOnWrite: false,
    orderRows,
    query: async (text: string) => {
      pool.queries.push(text);
      if (pool.failOnWrite && /INSERT INTO live_guard_state/.test(text)) {
        throw new Error("db unavailable");
      }
      if (/FROM live_guard_state/.test(text)) return { rows: [] };
      if (/FROM orders/.test(text)) return { rows: pool.orderRows };
      return { rows: [] };
    },
  };
  return pool;
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`EXIT:${code}`);
  }
}

describe("polyroot halt", () => {
  it("engages the latch, cancels open orders, kills agents, then exits 1", async () => {
    const pool = makePool([
      { venue_order_id: "ord-1" },
      { venue_order_id: "ord-2" },
      { venue_order_id: "" },
      { venue_order_id: null },
    ]);
    const canceled: string[] = [];
    let killed = false;
    let reported: { openOrders: number; canceledOrders: number } | null = null;
    await assert.rejects(
      requestHalt(
        {
          pool,
          cancelVenueOrder: async (id) => {
            canceled.push(id);
            return id === "ord-1";
          },
          killLocalAgents: async () => {
            killed = true;
          },
          exit: (code: number): never => {
            throw new ExitSignal(code);
          },
          report: (r) => {
            reported = {
              openOrders: r.openOrders,
              canceledOrders: r.canceledOrders,
            };
          },
        },
        { reason: "operator panic", cancelOrders: true },
      ),
      (err: unknown) => err instanceof ExitSignal && err.code === 1,
    );
    assert.deepEqual(reported, { openOrders: 2, canceledOrders: 1 });
    assert.ok(
      pool.queries.some((q) => /INSERT INTO live_guard_state/.test(q)),
      "latch write must happen",
    );
    assert.deepEqual(canceled, ["ord-1", "ord-2"]);
    assert.equal(killed, true);
  });

  it("fail-closed: latch write failure performs no kills, no cancels, no exit", async () => {
    const pool = makePool([{ venue_order_id: "ord-9" }]);
    pool.failOnWrite = true;
    let killed = false;
    let exited = false;
    let cancelCalled = false;
    await assert.rejects(
      requestHalt(
        {
          pool,
          cancelVenueOrder: async () => {
            cancelCalled = true;
            return true;
          },
          killLocalAgents: async () => {
            killed = true;
          },
          exit: (): never => {
            exited = true;
            throw new Error("must not exit");
          },
        },
        { reason: "x", cancelOrders: true },
      ),
      /db unavailable/,
    );
    assert.equal(killed, false);
    assert.equal(exited, false);
    assert.equal(cancelCalled, false);
  });

  it("skips remote cancels when cancelOrders is false", async () => {
    const pool = makePool([{ venue_order_id: "ord-1" }]);
    let cancelCalled = false;
    await assert.rejects(
      requestHalt(
        {
          pool,
          cancelVenueOrder: async () => {
            cancelCalled = true;
            return true;
          },
          exit: (code: number): never => {
            throw new ExitSignal(code);
          },
        },
        { reason: "x", cancelOrders: false },
      ),
      (err: unknown) => err instanceof ExitSignal,
    );
    assert.equal(cancelCalled, false);
    assert.ok(
      !pool.queries.some((q) => /FROM orders/.test(q)),
      "must not scan orders when cancels disabled",
    );
  });
});
