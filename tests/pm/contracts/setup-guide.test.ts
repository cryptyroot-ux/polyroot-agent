import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSetupEnvUpdate,
  formatNextSteps,
  upsertEnvLines,
} from "@polyroot/runtime";

describe("setup guide (lay-friendly)", () => {
  it("writes cap, derived loss cap, mode and universe", () => {
    const lines = buildSetupEnvUpdate({
      capitalUsd: 1000,
      lossBps: 500,
      mode: "LIVE",
      universe: ["12345"],
    });
    assert.ok(lines.includes("POLYROOT_MICRO_LIVE_CAP_USD=1000"));
    // 5% of 1000 = 50 loss cap.
    assert.ok(lines.includes("POLYROOT_MICRO_LIVE_LOSS_CAP_USD=50"));
    assert.ok(lines.includes("RUNTIME_MODE=LIVE"));
    assert.ok(lines.includes("POLYROOT_MARKET_IDS=12345"));
  });

  it("falls back to safe defaults on invalid numbers", () => {
    const lines = buildSetupEnvUpdate({
      capitalUsd: NaN,
      lossBps: -10,
      mode: "PAPER",
      universe: [],
    });
    assert.ok(lines.includes("POLYROOT_MICRO_LIVE_CAP_USD=1000"));
    assert.ok(lines.includes("POLYROOT_MICRO_LIVE_LOSS_CAP_USD=50"));
    assert.ok(lines.includes("RUNTIME_MODE=PAPER"));
  });

  it("replaces existing keys instead of duplicating them", () => {
    const out = upsertEnvLines("A=1\nPOLYROOT_MICRO_LIVE_CAP_USD=500\nB=2\n", [
      "POLYROOT_MICRO_LIVE_CAP_USD=1000",
    ]);
    const hits = out
      .split("\n")
      .filter((l) => l.startsWith("POLYROOT_MICRO_LIVE_CAP_USD="));
    assert.equal(hits.length, 1);
    assert.ok(out.includes("A=1"));
    assert.ok(out.includes("B=2"));
  });

  it("next steps guide names the exact commands in order", () => {
    const guide = formatNextSteps("LIVE");
    for (const cmd of [
      "polyroot status",
      "polyroot doctor --live",
      "polyroot",
    ]) {
      assert.ok(guide.includes(cmd), `guide must mention: ${cmd}`);
    }
    const paper = formatNextSteps("PAPER");
    assert.ok(paper.includes("polyroot"));
  });
});
