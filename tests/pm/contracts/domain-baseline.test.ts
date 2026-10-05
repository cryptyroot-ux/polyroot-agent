import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OperationModeSchema,
  VenueModeSchema,
  WalletTypeSchema,
  RuntimeStateSchema,
  SCHEMA_VERSION,
} from "@polyroot/domain";

describe("Domain baseline — canonical enums vs spec pack 124 PM-*", () => {
  it("PM-GOV-02: operation modes exclude PAPER/MICRO_LIVE (simulation modes removed)", () => {
    const modes = OperationModeSchema.options;
    // Assert PAPER/MICRO_LIVE are gone without hardcoding the exact surviving set.
    assert.equal(
      modes.includes("PAPER" as never),
      false,
      "PAPER must be removed",
    );
    assert.equal(
      modes.includes("MICRO_LIVE" as never),
      false,
      "MICRO_LIVE must be removed",
    );
    assert.equal(
      OperationModeSchema.safeParse("PAPER").success,
      false,
      "PAPER must not parse",
    );
    assert.equal(
      OperationModeSchema.safeParse("MICRO_LIVE").success,
      false,
      "MICRO_LIVE must not parse",
    );
  });

  it("PM-VENUE-01: venue modes are NORMAL/POST_ONLY/CANCEL_ONLY/READ_ONLY/UNAVAILABLE/UNKNOWN, free of RESTARTING", () => {
    assert.deepEqual([...VenueModeSchema.options].sort(), [
      "CANCEL_ONLY",
      "NORMAL",
      "POST_ONLY",
      "READ_ONLY",
      "UNAVAILABLE",
      "UNKNOWN",
    ]);
    assert.equal(VenueModeSchema.safeParse("READ_ONLY").success, true);
    assert.equal(VenueModeSchema.safeParse("RESTARTING").success, false);
  });

  it("PM-WALLET-01: wallet taxonomy exposes POLY_1271/GNOSIS_SAFE/POLY_PROXY alongside legacy aliases", () => {
    for (const w of [
      "DEPOSIT_WALLET",
      "EOA",
      "POLY_PROXY",
      "GNOSIS_SAFE",
      "POLY_1271",
      "LEGACY_PROXY",
      "SAFE",
      "UNKNOWN",
    ]) {
      assert.equal(WalletTypeSchema.safeParse(w).success, true, `wallet ${w}`);
    }
  });

  it("PM-GOV-01: schema_version is pinned in domain constants", () => {
    assert.equal(SCHEMA_VERSION.length > 0, true);
  });

  it("Runtime states are fail-closed superset (no self-bypass of hard blockers)", () => {
    const rt = RuntimeStateSchema.options;
    assert.equal(rt.includes("EMERGENCY_HALT"), true);
    assert.equal(rt.includes("ACCESS_BLOCKED"), true);
    assert.equal(rt.includes("PROTECTIVE_PAUSE"), true);
  });
});
