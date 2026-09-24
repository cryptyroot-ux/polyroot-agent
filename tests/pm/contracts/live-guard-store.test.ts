import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PgLiveGuardStore,
  checkShadowBaselineRow,
  decideGuardReset,
} from "@polyroot/runtime";

interface FakePool {
  queries: Array<{ text: string; params: unknown[] }>;
  rows: Record<string, unknown>[];
}

function makePool(rows: Record<string, unknown>[] = []): FakePool & {
  query: (
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
} {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  return {
    queries: calls,
    rows,
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      return { rows };
    },
  };
}

describe("PgLiveGuardStore (durable loss latch)", () => {
  it("load returns null when no row exists", async () => {
    const pool = makePool([]);
    const store = new PgLiveGuardStore(pool as never);
    assert.equal(await store.load(), null);
    assert.match(pool.queries[0]?.text ?? "", /FROM live_guard_state/);
  });

  it("save upserts the halted state", async () => {
    const pool = makePool([]);
    const store = new PgLiveGuardStore(pool as never);
    await store.save({
      halted: true,
      haltedAt: "2026-09-24T00:00:00.000Z",
      realizedLossPusd: 120,
    });
    const q = pool.queries[0];
    assert.match(q?.text ?? "", /ON CONFLICT \(key\) DO UPDATE/);
    assert.deepEqual(q?.params, [
      "micro-live",
      true,
      "2026-09-24T00:00:00.000Z",
      120,
    ]);
  });

  it("startup gate refuses without baseline evidence", () => {
    const missing = checkShadowBaselineRow(null);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, "MICRO_LIVE_NOT_READY");

    const growing = checkShadowBaselineRow({
      observed_days: "12.5",
      resolved_clusters: 40,
    });
    assert.equal(growing.ok, false);
    if (!growing.ok) assert.equal(growing.code, "MICRO_LIVE_NOT_READY");

    assert.deepEqual(
      checkShadowBaselineRow({ observed_days: 30, resolved_clusters: 100 }),
      { ok: true },
    );
  });

  it("owner reset clears only when loss is back under cap", () => {
    const clear = decideGuardReset(null, 0, 100);
    assert.equal(clear.ok, true);

    const refused = decideGuardReset(
      { halted: true, haltedAt: "t", realizedLossPusd: 150 },
      150,
      100,
    );
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, "GUARD_RESET_REFUSED");

    const allowed = decideGuardReset(
      { halted: true, haltedAt: "t", realizedLossPusd: 150 },
      50,
      100,
    );
    assert.equal(allowed.ok, true);
  });

  it("round-trips halted state through load", async () => {
    const pool = makePool([
      {
        halted: true,
        halted_at: "2026-09-24T00:00:00.000Z",
        realized_loss_pusd: "120",
      },
    ]);
    const store = new PgLiveGuardStore(pool as never);
    const state = await store.load();
    assert.deepEqual(state, {
      halted: true,
      haltedAt: "2026-09-24T00:00:00.000Z",
      realizedLossPusd: 120,
    });
  });
});
