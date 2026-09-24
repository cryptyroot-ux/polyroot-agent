import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Metrics } from "@polyroot/observability";
import { MetricsExporter } from "@polyroot/runtime";
import { recordG4Metrics } from "@polyroot/runtime";

describe("Metrics lifecycle wiring (bootstrap -> exporter)", () => {
  it("recordG4Metrics maps cumulative snapshot without double counting", () => {
    const metrics = new Metrics();
    const snapshot = {
      totalOrders: 10,
      filledOrders: 7,
      totalPnl: 25.5,
      totalFees: 1.25,
      maxDrawdown: 3.5,
      fillRatio: 0.7,
      currentExposureUsd: 500,
      maxExposureUsd: 1000,
    };
    recordG4Metrics(metrics, snapshot);
    // Recording the same cumulative snapshot twice must not accumulate.
    recordG4Metrics(metrics, snapshot);
    const body = new MetricsExporter(metrics).getMetrics();
    assert.match(body, /g4_total_orders_total 10\n/);
    assert.match(body, /g4_filled_orders_total 7\n/);
    assert.match(body, /g4_fill_ratio 0\.7\n/);
    assert.match(body, /g4_max_exposure_usd 1000\n/);
  });
});
