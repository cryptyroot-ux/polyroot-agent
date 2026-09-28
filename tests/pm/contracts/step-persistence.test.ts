import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  persistStep,
  createStepPersistence,
  flushStepPersistence,
} from "@polyroot/runtime";

function capturePool(opts: { failTables?: string[] } = []) {
  const statements: Array<{ table: string; params: unknown[] }> = [];
  const errors: Array<{ table: string; message: string }> = [];
  const pool = {
    statements,
    query: async (text: string, params?: unknown[]) => {
      if (/FROM markets WHERE/.test(text)) return { rows: [{ found: 1 }] };
      const m = /INSERT INTO (\w+)/.exec(text);
      const table = m?.[1] ?? "unknown";
      statements.push({ table, params: params ?? [] });
      if ((opts.failTables ?? []).includes(table)) {
        throw new Error(`FK violation on ${table}`);
      }
      return { rows: [] };
    },
  };
  return { pool, statements, errors };
}

const INPUT = { market_id: "mkt-1", bid: 0.45, ask: 0.55 };

describe("pipeline step persistence", () => {
  it("PAPER NO_TRADE writes snapshot + paper_log, skips forecast when p is null", async () => {
    const { pool, statements } = capturePool();
    const out = await persistStep(
      { pool, mode: "PAPER", model: "test-model" },
      INPUT,
      {
        market_id: "mkt-1",
        decision: "NO_TRADE",
        reason: "uncertain",
        p: null,
      },
    );
    assert.deepEqual(out, {
      snapshot: true,
      forecast: false,
      decisionLog: true,
    });
    const tables = statements.map((s) => s.table);
    assert.ok(tables.includes("market_snapshots"));
    assert.ok(tables.includes("paper_log"));
    assert.ok(
      !tables.includes("forecasts"),
      "null p must not fabricate a forecast",
    );
    const paper = statements.find((s) => s.table === "paper_log");
    assert.equal(paper?.params[1], "NO_TRADE");
    assert.equal(paper?.params[4], "CANCELLED");
  });

  it("SHADOW BUY writes snapshot + forecast + shadow_log with NONE fill", async () => {
    const { pool, statements } = capturePool();
    const out = await persistStep({ pool, mode: "SHADOW", model: "m" }, INPUT, {
      market_id: "mkt-1",
      decision: "BUY",
      reason: undefined,
      p: 0.65,
      size: 100,
      fill: {
        status: "FILLED",
        filledSize: 100,
        fillPrice: 0.55,
        makerFee: 0,
        takerFee: 1,
        latencyMs: 50,
      },
    });
    assert.deepEqual(out, {
      snapshot: true,
      forecast: true,
      decisionLog: true,
    });
    const tables = statements.map((s) => s.table);
    assert.ok(tables.includes("forecasts"));
    assert.ok(tables.includes("shadow_log"));
    assert.ok(!tables.includes("paper_log"));
    const fc = statements.find((s) => s.table === "forecasts");
    assert.equal(fc?.params[1], 0.65);
    assert.equal(fc?.params[3], "m");
  });

  it("never throws: FK failure on snapshots still records the decision log", async () => {
    const errs: Array<{ table: string; message: string }> = [];
    const { pool, statements } = capturePool({
      failTables: ["market_snapshots"],
    });
    const out = await persistStep(
      {
        pool,
        mode: "PAPER",
        onError: (table, err) => {
          errs.push({ table, message: err.message });
        },
      },
      INPUT,
      {
        market_id: "mock_market_1",
        decision: "NO_TRADE",
        reason: "x",
        p: 0.48,
      },
    );
    assert.equal(out.snapshot, false);
    assert.equal(out.decisionLog, true);
    assert.equal(errs.length, 1);
    assert.equal(errs[0]?.table, "market_snapshots");
    void statements;
  });

  it("records stated AI reasoning into lineage + assumptions", async () => {
    const { pool, statements } = capturePool();
    await persistStep(
      {
        pool,
        mode: "SHADOW",
        getReasoning: () => ({
          rationale: "Flow favors YES.",
          factors: ["depth"],
          model: "m-test",
        }),
      },
      INPUT,
      {
        market_id: "mkt-1",
        decision: "BUY",
        reason: undefined,
        p: 0.7,
        size: 10,
      },
    );
    const fc = statements.find((s) => s.table === "forecasts");
    assert.ok(fc, "forecast row must exist");
    const assumptions = fc?.params[5] as unknown[];
    assert.deepEqual(assumptions, ["Flow favors YES."]);
    const lineage = JSON.parse(fc?.params[6] as string) as Record<
      string,
      unknown
    >;
    assert.equal(lineage["rationale"], "Flow favors YES.");
    assert.deepEqual(lineage["factors"], ["depth"]);
    assert.equal(fc?.params[3], "m-test");
  });

  it("skips snapshots silently for unregistered markets (no warning spam)", async () => {
    const errs: Array<{ table: string; message: string }> = [];
    const seen: string[] = [];
    const pool = {
      query: async (text: string) => {
        if (/FROM markets WHERE/.test(text)) return { rows: [] };
        const m = /INSERT INTO (\w+)/.exec(text);
        if (m?.[1]) seen.push(m[1]);
        return { rows: [] };
      },
    };
    const out = await persistStep(
      {
        pool,
        mode: "SHADOW",
        onError: (table, err) => {
          errs.push({ table, message: err.message });
        },
      },
      INPUT,
      { market_id: "ghost-token", decision: "NO_TRADE", reason: "x", p: 0.4 },
    );
    assert.equal(out.snapshot, false);
    assert.equal(out.decisionLog, true);
    assert.ok(!seen.includes("market_snapshots"));
    assert.deepEqual(errs, [], "expected silence, not warnings");
  });

  it("flushStepPersistence waits for slow in-flight writes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: string[] = [];
    const slowPool = {
      query: async (text: string) => {
        if (/FROM markets WHERE/.test(text)) return { rows: [{ found: 1 }] };
        const m = /INSERT INTO (\w+)/.exec(text);
        await gate;
        seen.push(m?.[1] ?? "?");
        return { rows: [] };
      },
    };
    const hook = createStepPersistence({ pool: slowPool, mode: "SHADOW" });
    hook.emitStepComplete(
      { ...INPUT } as never,
      {
        market_id: "mkt-1",
        decision: "NO_TRADE",
        reason: "x",
        p: 0.6,
      } as never,
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(seen.length, 0, "write must still be gated");
    release();
    await flushStepPersistence();
    assert.ok(seen.includes("market_snapshots"));
    assert.ok(seen.includes("forecasts"));
    assert.ok(seen.includes("shadow_log"));
  });

  it("createStepPersistence hook is fire-and-forget and never throws", async () => {
    const { pool, statements } = capturePool();
    const hook = createStepPersistence({ pool, mode: "SHADOW" });
    hook.emitStepComplete(
      { ...INPUT, forecastOverride: undefined } as never,
      {
        market_id: "mkt-1",
        decision: "NO_TRADE",
        reason: "x",
        p: null,
      } as never,
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(statements.some((s) => s.table === "shadow_log"));
  });
});
