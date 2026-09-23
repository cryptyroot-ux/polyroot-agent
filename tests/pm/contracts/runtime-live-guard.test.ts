import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bootstrapAgent, parseArgs } from "@polyroot/runtime";
import type { VenueAdapter } from "@polyroot/venue";

const DUMMY_DB = "postgresql://postgres:postgres@127.0.0.1:1/polyroot_test";

function fakeVenueAdapter(): VenueAdapter {
  return {
    mode: "NORMAL",
    getOrderBook: async (marketId: string) => ({
      schema_version: "1.1",
      market_id: marketId,
      event_id: "evt_test",
      question: "test?",
      chain_id: 137,
      collateral: "pUSD",
      rules_hash: "rh",
      fee_maker_bps: 0,
      fee_taker_bps: 200,
      tick_size: 0.01,
      min_size: 1,
      status: "ACTIVE",
      is_neg_risk: false,
      venue_mode: "NORMAL",
      source_at: new Date(),
      received_at: new Date(),
    }),
    placeOrder: async () => ({ outcome: "REJECTED", reason: "fake" }),
    cancelOrder: async () => ({ outcome: "REJECTED", reason: "fake" }),
    getOrderStatus: async () => null,
    setMode: () => undefined,
  } as unknown as VenueAdapter;
}

describe("Take-over audit: runtime LIVE guards (commit 6829b5d follow-up)", () => {
  it("parseArgs rejects an invalid --mode with a clear error", () => {
    assert.throws(
      () => parseArgs(["--mode", "YOLO", "--db", "x", "--kms-key", "y"]),
      /Invalid mode/,
    );
  });

  it("parseArgs rejects an invalid RUNTIME_MODE", () => {
    const prev = process.env["RUNTIME_MODE"];
    process.env["RUNTIME_MODE"] = "PROD";
    try {
      assert.throws(
        () => parseArgs(["--db", "x", "--kms-key", "y"]),
        /Invalid mode/,
      );
    } finally {
      if (prev === undefined) delete process.env["RUNTIME_MODE"];
      else process.env["RUNTIME_MODE"] = prev;
    }
  });

  it("bootstrapAgent PAPER succeeds on placeholders without touching the network", async () => {
    const agent = await bootstrapAgent(DUMMY_DB, "PAPER");
    assert.ok(agent.pool);
    assert.ok(agent.kernel);
    assert.ok(agent.pipeline);
    await agent.pool.end().catch(() => undefined);
  });

  it("bootstrapAgent MICRO_LIVE without injected deps refuses with REFUSE_LIVE_WITH_STUBS", async () => {
    await assert.rejects(
      bootstrapAgent(DUMMY_DB, "MICRO_LIVE"),
      /REFUSE_LIVE_WITH_STUBS/,
    );
  });

  it("bootstrapAgent LIVE without injected deps refuses with REFUSE_LIVE_WITH_STUBS", async () => {
    await assert.rejects(
      bootstrapAgent(DUMMY_DB, "LIVE"),
      /REFUSE_LIVE_WITH_STUBS/,
    );
  });

  it("bootstrapAgent MICRO_LIVE with injected signer+venue proceeds past the guard", async () => {
    const agent = await bootstrapAgent(DUMMY_DB, "MICRO_LIVE", {
      cryptoSigner: async () => "0x_test_sig",
      venueAdapter: fakeVenueAdapter(),
    });
    assert.ok(agent.pool);
    assert.ok(agent.pipeline);
    await agent.pool.end().catch(() => undefined);
  });
});
