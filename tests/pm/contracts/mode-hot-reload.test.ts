import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { G4Pipeline } from "@polyroot/runtime";
import { getDefaultModeConfig } from "@polyroot/runtime";
import type { RuntimeMode } from "@polyroot/runtime";

function fakeWatcher(initial: RuntimeMode) {
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
  bootMode: "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE",
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
  it("valid jump SHADOW -> MICRO_LIVE applies within one sync", () => {
    const f = fakeWatcher("SHADOW");
    const pipe = pipelineWithWatcher("SHADOW", f.watcher);
    assert.equal(pipe.getMode(), "SHADOW");
    f.state.mode = "MICRO_LIVE";
    assert.equal(pipe.syncModeFromWatcher(), true);
    assert.equal(pipe.getMode(), "MICRO_LIVE");
  });

  it("PAPER -> SHADOW applies (first promotion step)", () => {
    const f = fakeWatcher("SHADOW");
    const pipe = pipelineWithWatcher("PAPER", f.watcher);
    assert.equal(pipe.syncModeFromWatcher(), true);
    assert.equal(pipe.getMode(), "SHADOW");
  });

  it("invalid jump SHADOW -> LIVE is refused, loop stays trading", () => {
    const f = fakeWatcher("LIVE");
    const pipe = pipelineWithWatcher("SHADOW", f.watcher);
    assert.equal(pipe.syncModeFromWatcher(), true);
    assert.equal(pipe.getMode(), "SHADOW");
  });

  it("degraded watcher halts entries (fail-closed)", () => {
    const f = fakeWatcher("SHADOW");
    f.state.degraded = true;
    const pipe = pipelineWithWatcher("SHADOW", f.watcher);
    assert.equal(pipe.syncModeFromWatcher(), false);
    assert.equal(pipe.getMode(), "SHADOW");
  });

  it("no watcher keeps the fixed boot mode", () => {
    const pipe = new G4Pipeline(getDefaultModeConfig("SHADOW", {}), {
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
    assert.equal(pipe.getMode(), "SHADOW");
  });

  it("runContinuous starts the watcher; stop() stops it", async () => {
    const f = fakeWatcher("SHADOW");
    // No marketSource + SHADOW: buildLoopInputs throws every pass, the
    // loop sleeps and retries — processMarket is never reached, so no
    // kernel/signer/executor fakes are exercised.
    const pipe = pipelineWithWatcher("SHADOW", f.watcher);
    const run = pipe.runContinuous();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(f.state.started, true);
    pipe.stop();
    assert.equal(f.state.stopped, true);
    await Promise.race([
      run,
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("loop did not exit")), 8000),
      ),
    ]);
  });
});
