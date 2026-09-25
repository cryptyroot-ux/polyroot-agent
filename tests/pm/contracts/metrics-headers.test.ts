import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MetricsServer } from "@polyroot/runtime";

describe("metrics security headers", () => {
  it("serves security headers on public and gated routes", async () => {
    const server = new MetricsServer({
      exporter: { getMetrics: () => "# ok\n" },
      port: 0,
    });
    const { port } = await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      const denied = await fetch(`http://127.0.0.1:${port}/metrics`);
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get("cache-control"), "no-store");
    } finally {
      await server.stop();
    }
  });
});
