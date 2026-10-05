import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeFinancialGate } from "@polyroot/runtime";

const venueNormal = () => "NORMAL" as const;
const venueReadOnly = () => "READ_ONLY" as const;

describe("P0: LIVE admission is explicit, never unconditional", () => {
  it("LIVE without admission stays FINANCIAL_BLOCKED (fail-closed default)", () => {
    assert.equal(
      computeFinancialGate("LIVE", venueNormal),
      "FINANCIAL_BLOCKED",
    );
    assert.equal(
      computeFinancialGate("LIVE", venueNormal, undefined, { admitted: false }),
      "FINANCIAL_BLOCKED",
    );
  });

  it("LIVE with admission flows through venue checks like MICRO_LIVE", () => {
    assert.equal(
      computeFinancialGate("LIVE", venueNormal, undefined, {
        admitted: true,
      }),
      "ALLOW",
    );
    assert.equal(
      computeFinancialGate("LIVE", venueReadOnly, undefined, {
        admitted: true,
      }),
      "ENTRY_BLOCKED",
    );
  });

  it("admission never relaxes other modes", () => {
    assert.equal(
      computeFinancialGate("MICRO_LIVE", venueReadOnly, undefined, {
        admitted: true,
      }),
      "ENTRY_BLOCKED",
    );
    assert.equal(
      computeFinancialGate("MICRO_LIVE", venueNormal, undefined, {
        admitted: true,
      }),
      "ALLOW",
    );
    // MICRO_LIVE removed from the mode ladder; MICRO_LIVE replaces it.
    // assert.equal(
    //   computeFinancialGate("MICRO_LIVE", venueNormal, undefined, {
    //     admitted: true,
    //   }),
    //   "ALLOW",
    // );
  });
});
