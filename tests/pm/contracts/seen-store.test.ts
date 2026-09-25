import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PgSeenStore } from "@polyroot/venue";

function fakePool(saved: Map<string, string>) {
  return {
    query: async (text: string, params?: unknown[]) => {
      if (text.includes("SELECT order_id")) {
        return {
          rows: [...saved.entries()].map(([order_id, state]) => ({
            order_id,
            state,
          })),
        };
      }
      if (text.includes("INSERT INTO seen_orders")) {
        saved.set(params?.[0] as string, params?.[1] as string);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe("PgSeenStore", () => {
  it("hydrates from DB and write-through persists new states", async () => {
    const saved = new Map([["ord-1", "ACKNOWLEDGED"]]);
    const store = new PgSeenStore(fakePool(saved) as never);
    await store.hydrate([{ orderId: "ord-2", state: "SUBMITTING" }]);
    assert.equal(store.has("ord-1"), true);
    assert.equal(store.get("ord-2"), "SUBMITTING");
    store.set("ord-3", "ACKNOWLEDGED");
    await store.flush();
    assert.equal(saved.get("ord-3"), "ACKNOWLEDGED");
  });

  it("restart replay: a fresh instance recovers persisted states", async () => {
    const saved = new Map([["ord-9", "SUBMISSION_UNKNOWN"]]);
    const first = new PgSeenStore(fakePool(saved) as never);
    await first.hydrate([]);
    const second = new PgSeenStore(fakePool(saved) as never);
    await second.hydrate([]);
    assert.equal(second.get("ord-9"), "SUBMISSION_UNKNOWN");
  });
});
