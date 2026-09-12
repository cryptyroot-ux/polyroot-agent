import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Metrics, Logger, AlertManager, HealthCheck } from "@polyroot/observability";

describe("PR-OPS-05: real observability (no placeholder)", () => {
  it("Metrics: counter/histogram/gauge track values in-memory", () => {
    const m = new Metrics();
    m.increment("orders.submitted", 1);
    m.increment("orders.submitted", 3);
    assert.equal(m.getCounter("orders.submitted"), 4);
    m.gauge("latency.ms", 45);
    assert.equal(m.getGauge("latency.ms"), 45);
    m.histogram("fill.size", 10);
    m.histogram("fill.size", 20);
    const p50 = m.getHistogramPercentile("fill.size", 0.5);
    assert.ok(typeof p50 === "number" && p50 >= 10 && p50 <= 20);
  });

  it("Logger: records messages with level; redacts secret-like fields", () => {
    const logger = new Logger();
    logger.info("order submitted", { orderId: "0xABC123", secret: "sk_live_1234567890123456" }); // gitleaks:allow
    const logs = logger.getLogs("info");
    assert.ok(logs.length === 1);
    const entry = logs[0];
    assert.ok(!entry.meta.secret.includes("12345678"), "secret must be redacted");
    assert.ok(entry.meta.secret.includes("****"));
  });

  it("HealthCheck: returns healthy when no issues; unhealthy when failures logged", () => {
    const h = new HealthCheck();
    const metrics = new Metrics();
    assert.equal(h.check({ metrics }).status, "healthy");
    metrics.increment("errors", 1);
    assert.equal(h.check({ metrics }).status, "unhealthy");
  });

  it("AlertManager: fires alert when threshold exceeded; reset clears", () => {
    const alerts = new AlertManager();
    let fired = false;
    alerts.on("order_errors", () => { fired = true; });
    alerts.check({ metric: "order_errors", value: 5, threshold: 3 });
    assert.equal(fired, true);
    fired = false;
    alerts.reset("order_errors");
    alerts.check({ metric: "order_errors", value: 1, threshold: 3 });
    assert.equal(fired, false);
  });
});
