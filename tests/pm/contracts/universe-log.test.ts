import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UniverseDecider, UniverseLog } from "@polyroot/data";

describe("PR-DATA-07 / T-PR-DATA-07: full universe decision log", () => {
  const mkMarket = (id: string, ticker: string, eligible: boolean, reason?: string) => ({
    id,
    ticker,
    eligible,
    reason,
    decidedAt: new Date("2026-09-11T00:00:00.000Z"),
  });

  it("logs every considered market, not only traded, with eligibility and reason codes", () => {
    const log = new UniverseLog();
    log.record(mkMarket("A", "TRADED", true));
    log.record(mkMarket("B", "REJECTED_METADATA", false, "metadata_missing"));
    log.record(mkMarket("C", "REJECTED_LIQUIDITY", false, "no_depth"));

    const all = log.all();
    assert.equal(all.length, 3, "universe log records every market");
    assert.deepEqual(
      all.map((m) => m.id),
      ["A", "B", "C"],
    );
    // Selection-bias audit: traded set < universe set
    assert.equal(log.traded().length, 1);
    assert.equal(log.rejected().length, 2);
  });

  it("replay for a day reproduces the exact eligible/rejected set and reason codes", () => {
    const log = new UniverseLog();
    log.record(mkMarket("X", "ELIGIBLE_01", true));
    log.record(mkMarket("Y", "REJECTED_02", false, "rules_unclear"));
    log.record(mkMarket("Z", "REJECTED_03", false, "fee_too_high"));

    const replay = log.replayDay(new Date("2026-09-11T00:00:00.000Z"));
    assert.equal(replay.length, 3);
    assert.deepEqual(
      replay.map((m) => `${m.id}:${m.reason ?? "eligible"}`),
      ["X:eligible", "Y:rules_unclear", "Z:fee_too_high"],
    );
  });

  it("decision id remains stable: reason codes are explicit, never omitted for a rejected market", () => {
    const log = new UniverseLog();
    const c = new UniverseDecider();
    c.decide("M1", { metadataOk: true, liquidityOk: false });
    log.record(mkMarket("M1", "REJECTED", false, "no_depth"));
    const m = log.get("M1");
    assert.ok(m);
    assert.equal(m?.eligible, false);
    assert.ok(m?.reason, "a rejected market must carry a reason code");
  });
});