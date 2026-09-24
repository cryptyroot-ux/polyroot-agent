import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnStrategyWorker } from "@polyroot/strategy/sandbox-rpc";

describe("Strategy Sandbox — Process Isolation", () => {
  it("strategy runs in isolated worker; no network/DB/shell access", async () => {
    const { client, worker } = await spawnStrategyWorker({
      strategyCode: `return { intent: { side: "BUY", size: 10 } };`,
    });

    const result = await client.run({
      forecast: { p_conservative: 0.6 },
      market: { market_id: "mkt_1" },
    });
    assert.ok(result.intent.side === "BUY");

    // Verify isolation
    const globals = await client.evalInWorker("return globalThis");
    assert.ok(!globals.fetch);
    assert.ok(!globals.require);
    assert.ok(!globals.process);

    await worker.terminate();
  });
});
