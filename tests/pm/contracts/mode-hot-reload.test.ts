import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { G4Pipeline } from "@polyroot/runtime";
import { getDefaultModeConfig } from "@polyroot/runtime";
import type { G4PipelineMode } from "@polyroot/runtime";

function fakeWatcher(initial: G4PipelineMode) {
  const state = {
    mode: initial,
    degraded: false,
    started: false,
    stopped: false,
  };
  return {
    state,
    watcher: {
      getMode: () => (state.degraded ? "READ_ONLY" : state.mode),
      isDegraded: () => state.degraded,
      start: () => {
        state.started = true;
      },
      stop: () => {
        state.stopped = true;
      },
    },
  };
}

function pipelineWithWatcher(
  bootMode: G4PipelineMode,
  w: ReturnType<typeof fakeWatcher>["watcher"],
): G4Pipeline {
  return new G4Pipeline(getDefaultModeConfig(bootMode, {}), {
    forecast: async () => 0.65,
    sizeIntent: () => 10,
    venueMode: () => "NORMAL",
    leaseEpoch: () => 1,
    now: () => new Date(),
    kernel: {},
    signer: {},
    executor: {},
    wallet: {},
    policy: {},
    policyHash: "test",
    modeWatcher: w,
  } as never);
}

describe("live mode hot-reload (no restart)", () => {
  it("valid jump MICRO_LIVE -> LIVE applies within one sync", () => {
    const f = fakeWatcher("MICRO_LIVE");
    const pipe = pipelineWithWatcher("MICRO_LIVE", f.watcher);
    assert.equal(pipe.getMode(), "MICRO_LIVE");
    f.state.mode = "LIVE";
    assert.equal(pipe.syncModeFromWatcher(), true);
    assert.equal(pipe.getMode(), "LIVE");
  });

  it("invalid jump LIVE -> MICRO_LIVE is refused (forward-only)", () => {
    const f = fakeWatcher("MICRO_LIVE");
    const pipe = pipelineWithWatcher("LIVE", f.watcher);
    assert.equal(pipe.syncModeFromWatcher(), true);
    assert.equal(pipe.getMode(), "LIVE");
  });

  it("degraded watcher halts entries (fail-closed)", () => {
    const f = fakeWatcher("MICRO_LIVE");
    f.state.degraded = true;
    const pipe = pipelineWithWatcher("MICRO_LIVE", f.watcher);
    assert.equal(pipe.syncModeFromWatcher(), false);
    assert.equal(pipe.getMode(), "MICRO_LIVE");
  });

  it("no watcher keeps the fixed boot mode", () => {
    const pipe = new G4Pipeline(getDefaultModeConfig("MICRO_LIVE", {}), {
      forecast: async () => 0.65,
      sizeIntent: () => 10,
      venueMode: () => "NORMAL",
      leaseEpoch: () => 1,
      now: () => new Date(),
      kernel: {},
      signer: {},
      executor: {},
      wallet: {},
      policy: {},
      policyHash: "test",
    } as never);
    assert.equal(pipe.syncModeFromWatcher(), true);
    assert.equal(pipe.getMode(), "MICRO_LIVE");
  });
});
