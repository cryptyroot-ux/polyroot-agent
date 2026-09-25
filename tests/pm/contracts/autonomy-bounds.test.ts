import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUTONOMY_BOUNDS,
  resolveLossCapPusd,
  parseBoundsEnv,
} from "@polyroot/runtime";

describe("autonomy bounds", () => {
  it("defaults encode the approved 5% latch and venue pin", () => {
    assert.equal(AUTONOMY_BOUNDS.DAILY_LOSS_CAP_BPS, 500);
    assert.equal(AUTONOMY_BOUNDS.ALLOWED_VENUE, "POLYMARKET_CLOB_CTF_V2");
  });

  it("resolves an absolute loss cap from capital and bps", () => {
    assert.equal(resolveLossCapPusd(1000, 500), 50);
  });

  it("rejects non-positive or non-finite loss caps", () => {
    assert.equal(parseBoundsEnv({}).lossCapPusd, undefined);
    assert.equal(
      parseBoundsEnv({ POLYROOT_MICRO_LIVE_LOSS_CAP_USD: "-5" }).lossCapPusd,
      undefined,
    );
  });

  it("accepts an explicit owner loss cap", () => {
    assert.equal(
      parseBoundsEnv({ POLYROOT_MICRO_LIVE_LOSS_CAP_USD: "50" }).lossCapPusd,
      50,
    );
  });
});
