import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemRecoveryLedger } from "@polyroot/venue";
import type { OrderResult } from "@polyroot/domain";

function venueResult(
  order_status: OrderResult["order_status"],
  extra?: Partial<OrderResult>,
): OrderResult {
  return {
    success: true,
    submit_status: "ACKNOWLEDGED",
    order_status,
    timestamp: new Date(),
    ...extra,
  };
}

describe("P0: recovery ledger must not resolve non-terminal venue states", () => {
  it("PARTIAL fill stays unresolved (more fills or cancel to come)", async () => {
    const rl = new MemRecoveryLedger();
    await rl.addSubmittedUnknown("ord_partial", undefined, "permit_1");
    await rl.resolve(
      "ord_partial",
      true,
      venueResult("PARTIAL", { filled_size: 40 }),
    );
    const o = await rl.get("ord_partial");
    assert.ok(o, "order must exist");
    assert.equal(
      o.resolved,
      false,
      "PARTIAL is not terminal: resolved must stay false",
    );
    assert.equal(o.state, "ACKNOWLEDGED");
    const pending = await rl.getUnresolved();
    assert.ok(
      pending.some((p) => p.orderId === "ord_partial"),
      "PARTIAL order must remain visible to the reconciler",
    );
  });

  it("LIVE resting order stays unresolved", async () => {
    const rl = new MemRecoveryLedger();
    await rl.addSubmittedUnknown("ord_live", undefined, "permit_2");
    await rl.resolve("ord_live", true, venueResult("LIVE"));
    const o = await rl.get("ord_live");
    assert.ok(o, "order must exist");
    assert.equal(
      o.resolved,
      false,
      "LIVE resting order is not terminal: resolved must stay false",
    );
  });

  it("MATCHED (fully filled) still resolves as ACKNOWLEDGED", async () => {
    const rl = new MemRecoveryLedger();
    await rl.addSubmittedUnknown("ord_matched", undefined, "permit_3");
    await rl.resolve(
      "ord_matched",
      true,
      venueResult("MATCHED", { filled_size: 100 }),
    );
    const o = await rl.get("ord_matched");
    assert.ok(o, "order must exist");
    assert.equal(o.resolved, true);
    assert.equal(o.resolvedState, "ACKNOWLEDGED");
  });

  it("CANCELED still resolves as DEFINITIVE_REJECT", async () => {
    const rl = new MemRecoveryLedger();
    await rl.addSubmittedUnknown("ord_canceled", undefined, "permit_4");
    await rl.resolve("ord_canceled", true, venueResult("CANCELED"));
    const o = await rl.get("ord_canceled");
    assert.ok(o, "order must exist");
    assert.equal(o.resolved, true);
    assert.equal(o.resolvedState, "DEFINITIVE_REJECT");
  });

  it("PARTIAL followed by CANCELED resolves (terminal state wins)", async () => {
    const rl = new MemRecoveryLedger();
    await rl.addSubmittedUnknown("ord_pc", undefined, "permit_5");
    await rl.resolve(
      "ord_pc",
      true,
      venueResult("PARTIAL", { filled_size: 40 }),
    );
    assert.equal((await rl.get("ord_pc"))?.resolved, false);
    await rl.resolve("ord_pc", true, venueResult("CANCELED"));
    const o = await rl.get("ord_pc");
    assert.equal(o?.resolved, true);
    assert.equal(o?.resolvedState, "DEFINITIVE_REJECT");
  });
});
