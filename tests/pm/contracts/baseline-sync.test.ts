import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SHADOW_BASELINE_ID,
  startResolutionSync,
  syncBaselineRow,
} from "@polyroot/runtime";

function recordingPool(row: Record<string, unknown> | null) {
  const calls: { text: string; params?: unknown[] }[] = [];
  return {
    calls,
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return { rows: row ? [row] : [] };
    },
  };
}

describe("G5 baseline collector", () => {
  it("derives both counters from durable facts, on the canonical row", async () => {
    const pool = recordingPool({
      observed_days: "45.12",
      resolved_clusters: 3,
    });
    const out = await syncBaselineRow(pool as never);
    assert.deepEqual(out, { observedDays: 45.12, resolvedClusters: 3 });
    assert.equal(pool.calls.length, 1);
    assert.deepEqual(pool.calls[0]?.params, [SHADOW_BASELINE_ID]);
    const sql = pool.calls[0]?.text ?? "";
    assert.match(sql, /UPDATE shadow_baseline/);
    assert.match(
      sql,
      /EXTRACT\(EPOCH FROM \(now\(\) - observed_started_at\)\)/,
    );
    assert.match(sql, /count\(\*\)::int FROM resolved_clusters/);
  });

  it("returns null when the baseline row is absent", async () => {
    const out = await syncBaselineRow(recordingPool(null) as never);
    assert.equal(out, null);
  });

  it("resolution-sync tick refreshes the baseline after recording clusters", async () => {
    const pool = {
      query: async (text: string) => {
        if (text.includes("UPDATE shadow_baseline")) {
          return { rows: [{ observed_days: "31", resolved_clusters: 7 }] };
        }
        return { rows: [] };
      },
    };
    const handle = startResolutionSync({
      pool: pool as never,
      calibration: {
        trainFromResolvedClusters: async () => ({
          groupsTrained: 0,
          samplesTotal: 0,
        }),
      } as never,
      fetchClosed: async () => [],
    });
    const s = await handle.tick();
    handle.stop();
    assert.equal(s.observedDays, 31);
    assert.equal(s.resolvedClusters, 7);
  });

  it("a broken baseline update never fails the tick (fail-open)", async () => {
    const pool = {
      query: async (text: string) => {
        if (text.includes("UPDATE shadow_baseline")) {
          throw new Error("baseline table missing");
        }
        return { rows: [] };
      },
    };
    const handle = startResolutionSync({
      pool: pool as never,
      calibration: {
        trainFromResolvedClusters: async () => ({
          groupsTrained: 0,
          samplesTotal: 0,
        }),
      } as never,
      fetchClosed: async () => [],
    });
    const s = await handle.tick();
    handle.stop();
    assert.equal(s.observedDays, 0);
    assert.equal(s.resolvedClusters, 0);
  });
});
