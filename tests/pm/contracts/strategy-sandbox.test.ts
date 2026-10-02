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

    // Verify isolation FOR REAL: enumerate the actual vm global names.
    // (The old assertion passed by construction — the worker hardcoded a
    // fake answer. This one fails if process/fetch ever leak back in.)
    const names = (await client.evalInWorker(
      "return Object.keys(globalThis)",
    )) as string[];
    for (const forbidden of ["process", "fetch", "require", "Worker"]) {
      assert.ok(
        !names.includes(forbidden),
        `${forbidden} must not exist in the strategy sandbox`,
      );
    }
    // Secrets must be unreachable even by name lookup.
    const envSeen = await client.evalInWorker("return typeof process");
    assert.equal(envSeen, "undefined");

    await worker.terminate();
  });

  it("worker inherits zero host env (no DATABASE_URL, keys, passphrases)", async () => {
    const { client, worker } = await spawnStrategyWorker({
      strategyCode: `return { ok: true };`,
    });
    try {
      const probe = (await client.evalInWorker(
        "return (typeof process === 'undefined') ? 'no-process' : Object.keys(process.env).length",
      )) as string | number;
      assert.equal(probe, "no-process");
    } finally {
      await worker.terminate();
    }
  });
});
