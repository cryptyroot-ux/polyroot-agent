import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commissionCharter, charterAllows } from "@polyroot/control";

describe("PR-GOV-03/05: Autonomy Charter is immutable and binds hard authority", () => {
  const base = {
    walletId: "w1",
    capitalUsdCap: 1000,
    dailyLossStopPct: 0.02,
    qualifiedStrategyIds: ["evidence_directional_v2@1.0.0"],
    marketClassAllowlist: ["BINARY"],
    expiresAt: new Date("2099-01-01"),
    releaseRef: "manifest@1",
  };

  it("commission creates a charter that allows eligible routine intents (zero per-trade approval)", () => {
    const c = commissionCharter(base);
    const res = charterAllows(c, { action: "SUBMIT", strategyId: "evidence_directional_v2@1.0.0", exposureUsd: 50 });
    assert.equal(res.ok, true);
  });

  it("rejects an unqualified strategy (hard policy cannot self-weaken)", () => {
    const c = commissionCharter(base);
    const res = charterAllows(c, { action: "SUBMIT", strategyId: "unqualified@9", exposureUsd: 10 });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "STRATEGY_NOT_QUALIFIED");
  });

  it("rejects promotion / capital-increase / extend actions (owner governance only)", () => {
    const c = commissionCharter(base);
    assert.equal(charterAllows(c, { action: "PROMOTE_STRATEGY", strategyId: "x@1", exposureUsd: 0 }).ok, false);
    assert.equal(charterAllows(c, { action: "INCREASE_CAPITAL", exposureUsd: 5000 }).ok, false);
    assert.equal(charterAllows(c, { action: "EXTEND_CHARTER", exposureUsd: 0 }).ok, false);
    assert.equal(charterAllows(c, { action: "CHANGE_SIGNER", exposureUsd: 0 }).ok, false);
  });

  it("rejects exposure above the capital cap", () => {
    const c = commissionCharter(base);
    const res = charterAllows(c, { action: "SUBMIT", strategyId: "evidence_directional_v2@1.0.0", exposureUsd: 2000 });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "CAPITAL_CAP_EXCEEDED");
  });
});