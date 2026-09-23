import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  spawnStrategyWorker,
  DEFAULT_WORKER_RESOURCE_LIMITS,
} from "@polyroot/strategy/sandbox-rpc";
import {
  checkDecodeBudget,
  EgressGuard,
} from "@polyroot/security";

describe("Phase 13 FT-16: worker resource quota is applied (PM-SEC-03)", () => {
  it("spawned workers carry the conservative V8 heap caps", async () => {
    const { worker } = await spawnStrategyWorker({
      strategyCode: "return 1",
    });
    try {
      const limits: any = (worker as any).resourceLimits;
      assert.ok(limits, "worker exposes resourceLimits");
      assert.equal(
        limits.maxOldGenerationSizeMb,
        DEFAULT_WORKER_RESOURCE_LIMITS.maxOldGenerationSizeMb,
      );
      assert.equal(
        limits.maxYoungGenerationSizeMb,
        DEFAULT_WORKER_RESOURCE_LIMITS.maxYoungGenerationSizeMb,
      );
    } finally {
      await worker.terminate();
    }
  });

  it("a normal strategy still runs fine under the caps", async () => {
    const { client, worker } = await spawnStrategyWorker({
      strategyCode: `return { intent: { side: "BUY", size: 10 } };`,
    });
    try {
      const result = await client.run(null);
      assert.equal(result.intent.side, "BUY");
    } finally {
      await worker.terminate();
    }
  });
});

describe("Phase 13 FT-19: content-bomb decode budgets (PM-SEC-05)", () => {
  it("oversized compressed bodies abort before allocation", () => {
    const res = checkDecodeBudget({
      compressedBytes: 6_000_000,
      decompressedBytes: 6_000_000,
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "CONTENT_BOMB_COMPRESSED");
  });

  it("oversized decompressed output aborts before parsing", () => {
    const res = checkDecodeBudget({
      compressedBytes: 1_000_000,
      decompressedBytes: 30_000_000,
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "CONTENT_BOMB_DECOMPRESSED");
  });

  it("zip-bomb expansion ratio aborts even under absolute caps", () => {
    const res = checkDecodeBudget({
      compressedBytes: 100_000,
      decompressedBytes: 5_000_000,
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "CONTENT_BOMB_RATIO");
  });

  it("healthy payloads pass all three budgets", () => {
    assert.equal(
      checkDecodeBudget({ compressedBytes: 100_000, decompressedBytes: 500_000 })
        .ok,
      true,
    );
  });

  it("non-finite measurements fail closed, never pass", () => {
    assert.equal(
      checkDecodeBudget({
        compressedBytes: Number.NaN,
        decompressedBytes: 10,
      }).ok,
      false,
    );
  });
});

describe("Phase 13 FT-17/18: redirect chain landing on IPv6 ULA (PM-SEC-04)", () => {
  it("a redirect chain ending at fc00::/7 is blocked as redirect-private", async () => {
    const guard = new EgressGuard({
      allowedDomains: ["api.polymarket.com"],
      maxRedirects: 5,
    });
    const res = await guard.check({
      url: "http://evil.com/redirect",
      redirectChain: ["http://evil.com/redirect", "http://[fc00::1]/"],
    });
    assert.equal(res.ok, false);
    assert.match(res.code, /REDIRECT/);
  });
});
