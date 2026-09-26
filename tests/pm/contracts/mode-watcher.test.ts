import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModeWatcher, type QueryablePool } from "@polyroot/runtime";

class FakePool implements QueryablePool {
  mode = "PAPER";
  halted = false;
  shouldFail = false;
  failCount = 0;

  async query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    if (this.shouldFail) {
      this.failCount++;
      throw new Error("DB_CONNECTION_LOST");
    }
    if (text.includes("UPDATE")) {
      const newMode = params?.[1] as string;
      this.mode = newMode;
      return { rows: [{ runtime_mode: this.mode, halted: this.halted }] };
    }
    return { rows: [{ runtime_mode: this.mode, halted: this.halted }] };
  }
}

describe("Runtime — ModeWatcher (Hot-Reload & Fail-Closed)", () => {
  it("initializes with initialMode and reads DB on first poll", async () => {
    const pool = new FakePool();
    pool.mode = "SHADOW";
    const watcher = new ModeWatcher({
      pool,
      initialMode: "PAPER",
      pollIntervalMs: 50,
    });
    assert.equal(watcher.getMode(), "PAPER");

    await watcher.pollOnce();
    assert.equal(watcher.getMode(), "SHADOW");
    assert.equal(watcher.isDegraded(), false);
  });

  it("triggers onModeChange callback when DB mode changes", async () => {
    const pool = new FakePool();
    const changes: Array<{ from: string; to: string }> = [];
    const watcher = new ModeWatcher({
      pool,
      initialMode: "PAPER",
      pollIntervalMs: 50,
      onModeChange: (from, to) => changes.push({ from, to }),
    });

    await watcher.pollOnce(); // initial poll -> PAPER
    pool.mode = "LIVE";
    await watcher.pollOnce(); // mode change -> LIVE

    assert.equal(watcher.getMode(), "LIVE");
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0], { from: "PAPER", to: "LIVE" });
  });

  it("degrades to READ_ONLY after 3 consecutive polling failures (fail-closed)", async () => {
    const pool = new FakePool();
    pool.mode = "LIVE";
    const watcher = new ModeWatcher({
      pool,
      initialMode: "LIVE",
      pollIntervalMs: 50,
      maxFailuresBeforeDegrade: 3,
    });

    await watcher.pollOnce(); // success
    assert.equal(watcher.getMode(), "LIVE");

    pool.shouldFail = true;
    await watcher.pollOnce(); // fail 1
    assert.equal(watcher.getMode(), "LIVE");
    await watcher.pollOnce(); // fail 2
    assert.equal(watcher.getMode(), "LIVE");
    await watcher.pollOnce(); // fail 3 -> DEGRADED to READ_ONLY

    assert.equal(watcher.getMode(), "READ_ONLY");
    assert.equal(watcher.isDegraded(), true);

    // Recover DB
    pool.shouldFail = false;
    await watcher.pollOnce(); // recovery -> restores LIVE
    assert.equal(watcher.getMode(), "LIVE");
    assert.equal(watcher.isDegraded(), false);
  });

  it("refuses mode upgrade to LIVE if loss latch (halted) is engaged", async () => {
    const pool = new FakePool();
    pool.halted = true;
    const watcher = new ModeWatcher({
      pool,
      initialMode: "PAPER",
      pollIntervalMs: 50,
    });

    const res = await watcher.requestModeChange("LIVE", "operator_1");
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, "LOSS_LATCH_ENGAGED");
    }
    assert.equal(watcher.getMode(), "PAPER");
  });
});
