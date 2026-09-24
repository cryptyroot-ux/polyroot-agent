import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Metrics } from "@polyroot/observability";
import { MetricsExporter, MetricsServer } from "@polyroot/runtime";

const OWNER_KEY = "test-owner-key-12345";

async function startServer(): Promise<{ server: MetricsServer; base: string }> {
  const metrics = new Metrics();
  metrics.increment("totalOrders", 3);
  const server = new MetricsServer({
    metrics,
    exporter: new MetricsExporter(metrics),
    ownerKey: OWNER_KEY,
    host: "127.0.0.1",
    port: 0,
  });
  const { port } = await server.start();
  return { server, base: `http://127.0.0.1:${port}` };
}

describe("MetricsServer HTTP contract", () => {
  it("GET /metrics without key returns 401", async () => {
    const { server, base } = await startServer();
    try {
      const res = await fetch(`${base}/metrics`);
      assert.equal(res.status, 401);
    } finally {
      await server.stop();
    }
  });

  it("GET /metrics with valid key returns 200 + Prometheus body", async () => {
    const { server, base } = await startServer();
    try {
      const res = await fetch(`${base}/metrics`, {
        headers: { authorization: `Bearer ${OWNER_KEY}` },
      });
      assert.equal(res.status, 200);
      assert.match(
        res.headers.get("content-type") ?? "",
        /text\/plain/,
      );
      const body = await res.text();
      assert.match(body, /g4_total_orders_total 3/);
    } finally {
      await server.stop();
    }
  });

  it("GET /healthz is public and reports ok", async () => {
    const { server, base } = await startServer();
    try {
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status: string };
      assert.equal(body.status, "ok");
    } finally {
      await server.stop();
    }
  });

  it("non-GET method returns 405", async () => {
    const { server, base } = await startServer();
    try {
      const res = await fetch(`${base}/metrics`, {
        method: "POST",
        headers: { authorization: `Bearer ${OWNER_KEY}` },
      });
      assert.equal(res.status, 405);
    } finally {
      await server.stop();
    }
  });

  it("stop releases the port and further requests fail", async () => {
    const { server, base } = await startServer();
    await server.stop();
    await assert.rejects(fetch(`${base}/healthz`));
  });
});
