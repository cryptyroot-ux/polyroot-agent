import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateKillLevel, levelAtLeast, KillLevel } from "../src/kill-switch.ts";

describe("KillSwitch — KillLevel validation", () => {
  it("validateKillLevel accepts valid levels", () => {
    const levels: KillLevel[] = ["NONE", "PAUSE_ENTRIES", "CANCEL_OPEN", "FLATTEN"];
    for (const lvl of levels) {
      const res = validateKillLevel(lvl);
      assert.equal(res, lvl);
    }
  });

  it("validateKillLevel throws for invalid string", () => {
    assert.throws(() => validateKillLevel("INVALID"), /KillSwitch: invalid kill level/);
    assert.throws(() => validateKillLevel(""), /KillSwitch: invalid kill level/);
    assert.throws(() => validateKillLevel("none"), /KillSwitch: invalid kill level/);
  });

  it("validateKillLevel throws for non-string", () => {
    assert.throws(() => validateKillLevel(null as unknown), /KillSwitch: invalid kill level/);
    assert.throws(() => validateKillLevel(123 as unknown), /KillSwitch: invalid kill level/);
    assert.throws(() => validateKillLevel({} as unknown), /KillSwitch: invalid kill level/);
  });

  it("levelAtLeast validates both arguments", () => {
    assert.throws(() => levelAtLeast("INVALID" as KillLevel, "NONE"), /KillSwitch: invalid kill level/);
    assert.throws(() => levelAtLeast("NONE", "BAD" as KillLevel), /KillSwitch: invalid kill level/);
  });

  it("levelAtLeast still works for valid levels", () => {
    assert.equal(levelAtLeast("FLATTEN", "NONE"), true);
    assert.equal(levelAtLeast("PAUSE_ENTRIES", "NONE"), true);
    assert.equal(levelAtLeast("NONE", "FLATTEN"), false);
  });
});