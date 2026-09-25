import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PgSeenStore } from "@polyroot/venue";
import { bootstrapAgent } from "@polyroot/runtime";
import type { VenueAdapter } from "@polyroot/venue";

const DUMMY_DB = "postgresql://postgres:postgres@127.0.0.1:1/polyroot_test";

function fakeVenueAdapter(): VenueAdapter {
  return { mode: "NORMAL" } as unknown as VenueAdapter;
}

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

describe("hydrateSeen startup gate", () => {
  it("PAPER resolves without a DB (warn path, zero financial I/O)", async () => {
    const agent = await bootstrapAgent(DUMMY_DB, "PAPER");
    await agent.hydrateSeen();
    await agent.pool.end().catch(() => undefined);
  });

  it("MICRO_LIVE refuses fail-closed when the DB is unreachable", async () => {
    const prevKey = process.env["WALLET_PRIVATE_KEY"];
    const prevAccount = process.env["WALLET_ACCOUNT"];
    const prevFunder = process.env["WALLET_FUNDER"];
    const prevLossCap = process.env["POLYROOT_MICRO_LIVE_LOSS_CAP_USD"];
    const prevUniverse = process.env["POLYROOT_MARKET_IDS"];
    process.env["WALLET_PRIVATE_KEY"] =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    process.env["WALLET_ACCOUNT"] =
      "0x1111111111111111111111111111111111111111";
    process.env["WALLET_FUNDER"] = "0x2222222222222222222222222222222222222222";
    process.env["POLYROOT_MICRO_LIVE_LOSS_CAP_USD"] = "100";
    process.env["POLYROOT_MARKET_IDS"] = "12345";
    try {
      const agent = await bootstrapAgent(DUMMY_DB, "MICRO_LIVE", {
        cryptoSigner: async () => "0x_test_sig",
        venueAdapter: fakeVenueAdapter(),
      });
      await assert.rejects(agent.hydrateSeen(), /SEEN_HYDRATE_FAILED/);
      await agent.pool.end().catch(() => undefined);
    } finally {
      if (prevKey === undefined) delete process.env["WALLET_PRIVATE_KEY"];
      else process.env["WALLET_PRIVATE_KEY"] = prevKey;
      if (prevAccount === undefined) delete process.env["WALLET_ACCOUNT"];
      else process.env["WALLET_ACCOUNT"] = prevAccount;
      if (prevFunder === undefined) delete process.env["WALLET_FUNDER"];
      else process.env["WALLET_FUNDER"] = prevFunder;
      if (prevLossCap === undefined)
        delete process.env["POLYROOT_MICRO_LIVE_LOSS_CAP_USD"];
      else process.env["POLYROOT_MICRO_LIVE_LOSS_CAP_USD"] = prevLossCap;
      if (prevUniverse === undefined) delete process.env["POLYROOT_MARKET_IDS"];
      else process.env["POLYROOT_MARKET_IDS"] = prevUniverse;
    }
  });
});
