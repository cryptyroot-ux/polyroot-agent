import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  systemStatus,
  StatusBoardAlerts,
  unconfirmedActions,
} from "@polyroot/observability";

describe("Phase 27: three-stream status stays split (PRD 5.3)", () => {
  it("READY/NORMAL/NORMAL is OK with all streams visible", () => {
    const s = systemStatus({
      systemHealth: "READY",
      venueMode: "NORMAL",
      accountMode: "NORMAL",
    });
    assert.equal(s.overall, "OK");
    assert.equal(s.systemHealth, "READY");
    assert.equal(s.venueMode, "NORMAL");
    assert.equal(s.accountMode, "NORMAL");
  });
  it("any HALTED signal halts without hiding the other two", () => {
    for (const input of [
      { systemHealth: "BLOCKED", venueMode: "NORMAL", accountMode: "NORMAL" },
      { systemHealth: "READY", venueMode: "UNAVAILABLE", accountMode: "NORMAL" },
      { systemHealth: "READY", venueMode: "NORMAL", accountMode: "BANNED" },
    ] as const) {
      const s = systemStatus(input);
      assert.equal(s.overall, "HALTED");
    }
  });
  it("degraded modes attend instead of halting", () => {
    assert.equal(
      systemStatus({
        systemHealth: "READY",
        venueMode: "POST_ONLY",
        accountMode: "NORMAL",
      }).overall,
      "ATTENTION",
    );
    assert.equal(
      systemStatus({
        systemHealth: "RECOVERING",
        venueMode: "NORMAL",
        accountMode: "NORMAL",
      }).overall,
      "ATTENTION",
    );
  });
});

describe("Phase 27: alerts carry owner/severity/dedupe/incident", () => {
  it("breaches fire once per key; owner is mandatory", () => {
    const board = new StatusBoardAlerts();
    const first = board.raise({
      metric: "drawdown",
      value: 6,
      threshold: 5,
      owner: "risk-owner",
      severity: "CRITICAL",
      incidentId: "inc_1",
    });
    assert.equal(first.fired, true);
    const dup = board.raise({
      metric: "drawdown",
      value: 7,
      threshold: 5,
      owner: "risk-owner",
      severity: "CRITICAL",
      incidentId: "inc_1",
    });
    assert.equal(dup.fired, false);
    assert.equal(board.listOpen().length, 1);
    assert.throws(
      () =>
        board.raise({
          metric: "x",
          value: 2,
          threshold: 1,
          owner: "",
          severity: "WARN",
        }),
      /owner/,
    );
  });
  it("resolve + re-breach fires anew", () => {
    const board = new StatusBoardAlerts();
    const spec = {
      metric: "lag",
      value: 9,
      threshold: 5,
      owner: "ops",
      severity: "WARN" as const,
    };
    board.raise(spec);
    const key = board.listOpen()[0]?.dedupeKey ?? "";
    assert.equal(board.resolve(key), true);
    assert.equal(board.raise(spec).fired, true);
  });
});

describe("Phase 27: unconfirmed actions surface without safe-claims", () => {
  it("every entry is marked NOT-CONFIRMED with age; empty reports zero", () => {
    const now = new Date("2026-01-01T00:01:00Z");
    const r = unconfirmedActions(
      [{ id: "o1", kind: "SUBMIT", since: new Date("2026-01-01T00:00:00Z") }],
      now,
    );
    assert.equal(r.count, 1);
    assert.match(r.lines[0] ?? "", /NOT-CONFIRMED SUBMIT o1 \(open 60000ms\)/);
    assert.equal(unconfirmedActions([], now).count, 0);
  });
});
