/**
 * Contract tests for kill switch (PM-RISK-05), reduction path (PM-RISK-06)
 * and key-compromise response planner (PM-SEC-08).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Portfolio, RiskPolicy } from "@polyroot/domain";
import {
  blockNewEntry,
  levelAtLeast,
  planCancelOpen,
  planFlatten,
  recordCancelOutcome,
  checkReduceAllowed,
  sellableShares,
  planCompromiseResponse,
  lossFloor,
  type OpenOrderRef,
  type VerifiedPosition,
} from "@polyroot/risk";

describe("Kill switch (PM-RISK-05)", () => {
  it("level lattice is monotonic (NONE <= PAUSE_ENTRIES <= ... <= FLATTEN)", () => {
    assert.ok(levelAtLeast("NONE", "NONE"));
    assert.ok(!levelAtLeast("NONE", "PAUSE_ENTRIES"));
    assert.ok(levelAtLeast("PAUSE_ENTRIES", "NONE"));
    assert.ok(levelAtLeast("CANCEL_OPEN", "PAUSE_ENTRIES"));
    assert.ok(levelAtLeast("FLATTEN", "CANCEL_OPEN"));
    assert.ok(levelAtLeast("FLATTEN", "NONE"));
  });

  it("PAUSE_ENTRIES blocks queued intents and new workers", () => {
    const r = blockNewEntry("PAUSE_ENTRIES", {
      intentId: "i_1",
      marketId: "m",
    });
    assert.equal(r.block, true);
    assert.equal(r.code, "ENTRIES_PAUSED");
  });

  it("NONE is a passthrough for entries; heavier levels still block", () => {
    const intent = { intentId: "i_2", marketId: "m" };
    assert.equal(blockNewEntry("NONE", intent).block, false);
    assert.equal(blockNewEntry("CANCEL_OPEN", intent).block, true);
    assert.equal(blockNewEntry("FLATTEN", intent).block, true);
  });

  it("CANCEL_OPEN plans every open order, but cancellation requires an observed result", () => {
    const orders: OpenOrderRef[] = [
      { orderId: "o1", venueOrderId: "v1", marketId: "m", qtyBase: 100n },
      { orderId: "o2", venueOrderId: "v2", marketId: "m", qtyBase: 200n },
    ];
    let plan = planCancelOpen("CANCEL_OPEN", orders);
    // No observed result yet -> allCanceled must be false (never assumed).
    assert.equal(plan.allCanceled, false);
    assert.equal(plan.plan.length, 2);
    assert.ok(plan.plan.every((c) => c.status === "CANCEL_UNKNOWN"));

    // One definitive CANCELED, one still unknown -> still not all canceled.
    plan = recordCancelOutcome(plan, {
      status: "CANCELED",
      orderId: "o1",
      venueOrderId: "v1",
    });
    assert.equal(plan.allCanceled, false);

    // Second definitive CANCELED -> allCanceled true.
    plan = recordCancelOutcome(plan, {
      status: "CANCELED",
      orderId: "o2",
      venueOrderId: "v2",
    });
    assert.equal(plan.allCanceled, true);
  });

  it("a failed cancel is surfaced and never reported as success", () => {
    const orders: OpenOrderRef[] = [
      { orderId: "o1", venueOrderId: "v1", marketId: "m", qtyBase: 100n },
    ];
    let plan = planCancelOpen("CANCEL_OPEN", orders);
    plan = recordCancelOutcome(plan, {
      status: "CANCEL_FAILED",
      orderId: "o1",
      reason: "venue 5xx",
    });
    assert.equal(plan.allCanceled, false);
    assert.equal(plan.plan[0]?.status, "CANCEL_FAILED");
  });

  it("FLATTEN is a separate action sized from ACTUAL positions with a price cap", () => {
    const positions: VerifiedPosition[] = [
      { marketId: "m1", side: "YES", qtyBase: 500n, avgPriceBase: 200_000n },
      { marketId: "m2", side: "NO", qtyBase: 300n, avgPriceBase: 900_000n },
      { marketId: "m3", side: "YES", qtyBase: 0n, avgPriceBase: 100_000n }, // empty
    ];
    // Cap of 0.5 -> m2 (avg 0.9) can NOT be exited under the cap and is skipped,
    // never force-sold above cap.
    const plan = planFlatten("FLATTEN", positions, 500_000n);
    assert.equal(plan.reduceOrders.length, 1);
    assert.equal(plan.reduceOrders[0]?.marketId, "m1");
    assert.equal(plan.reduceOrders[0]?.qtyBase, 500n);
    assert.equal(plan.reduceOrders[0]?.limitPriceBase, 500_000n);
    const skipped = plan.skipped.map((s) => s.marketId);
    assert.ok(skipped.includes("m2"));
    assert.ok(!skipped.includes("m3"));
  });

  it("FLATTEN refuses an invalid cap (never mints exit orders at bad prices)", () => {
    const positions: VerifiedPosition[] = [
      { marketId: "m1", side: "YES", qtyBase: 500n, avgPriceBase: 200_000n },
    ];
    assert.equal(planFlatten("FLATTEN", positions, -1n).reduceOrders.length, 0);
    assert.equal(
      planFlatten("FLATTEN", positions, 1_000_001n).reduceOrders.length,
      0,
    );
  });
});

describe("Reduction path (PM-RISK-06)", () => {
  it("SELL uses verified shares plus definitive cancels; uncertain cancels free nothing", () => {
    // Verified 1000, definitive cancel 100, pending cancel 500.
    const free = sellableShares(1_000n, 100n, 500n);
    assert.equal(free, 1_100n);
    // SELL 1100 fits.
    const ok = checkReduceAllowed({
      requestQtyBase: 1_100n,
      verifiedQtyDeltaBase: 1_000n,
      definitivelyCanceledQtyBase: 100n,
      pendingCancelQtyBase: 500n,
    });
    assert.equal(ok.ok, true);
    // SELL 1500 exceeds -> rejected, and the pending 500 is NOT credited.
    const over = checkReduceAllowed({
      requestQtyBase: 1_500n,
      verifiedQtyDeltaBase: 1_000n,
      definitivelyCanceledQtyBase: 100n,
      pendingCancelQtyBase: 500n,
    });
    assert.equal(over.ok, false);
    if (!over.ok) assert.equal(over.code, "REDUCE_OVERDRAWN");
  });

  it("never opens a short when verified delta is negative", () => {
    const over = checkReduceAllowed({
      requestQtyBase: 5n,
      verifiedQtyDeltaBase: -10n, // we are already short-suspected
      definitivelyCanceledQtyBase: 0n,
      pendingCancelQtyBase: 0n,
    });
    assert.equal(over.ok, false);
    if (!over.ok) assert.equal(over.code, "REDUCE_OVERDRAWN");
  });
});

describe("Key-compromise response planner (PM-SEC-08)", () => {
  it("orders kills->freeze->reconcile->cancel->revoke->rescue for L2", () => {
    const p = planCompromiseResponse({
      class: "L2_API",
      freezeEntries: true,
      cancelPossible: true,
      observedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const actions = p.order.map((a) => a.action);
    assert.deepEqual(actions.slice(0, 5), [
      "KILL_SIGNING",
      "FREEZE_ENTRIES",
      "RECONCILE",
      "CANCEL_OPEN",
      "REVOKE_L2",
    ]);
    // Cancel runs before revocation (control may still reach the venue).
    assert.ok(actions.indexOf("CANCEL_OPEN") < actions.indexOf("REVOKE_L2"));
    // Rescue is owner-only.
    assert.ok(p.ownerOnly.length >= 1);
    assert.ok(actions.includes("OWNER_ASSET_RESCUE"));
  });

  it("cancels skip when not still possible", () => {
    const p = planCompromiseResponse({
      class: "L1_SIGNER",
      freezeEntries: true,
      cancelPossible: false,
      observedAt: new Date(),
    });
    assert.ok(!p.order.some((a) => a.action === "CANCEL_OPEN"));
    assert.ok(p.order.some((a) => a.action === "ROTATE_L1"));
  });

  it("owner sessions are revoked, never rotated implicitly", () => {
    const p = planCompromiseResponse({
      class: "OWNER_SESSION",
      freezeEntries: true,
      cancelPossible: true,
      observedAt: new Date(),
    });
    assert.ok(p.order.some((a) => a.action === "REVOKE_OWNER_SESSION"));
  });
});

describe("Loss limits (PM-RISK-03)", () => {
  const policy: RiskPolicy = {
    schema_version: "1.1",
    policy_version: "v-test",
    execution_mode: "PAPER",
    capital_usd_cap: 1000,
    max_order_pct: 0.01,
    max_market_pct: 0.02,
    max_event_group_pct: 0.05,
    max_portfolio_pct: 0.1,
    daily_loss_stop_pct: 0.02,
    drawdown_stop_pct: 0.05,
    max_open_orders: 5,
    min_edge_after_cost: 0.01,
    book_max_age_ms: 1000,
    metadata_max_age_s: 10,
    forecast_max_age_s: 100,
    clock_skew_max_ms: 100,
    max_slippage_abs: 0.01,
    intent_ttl_s: 30,
    risk_permit_ttl_ms: 1000,
    reconcile_interval_s: 15,
  };
  const portfolio = (overrides: Partial<Portfolio>): Portfolio => ({
    total_value: 1000,
    cash: 1000,
    positions_value: 0,
    unrealized_pnl: 0,
    realized_pnl_24h: 0,
    daily_loss: 0,
    drawdown: 0,
    updated_at: new Date(),
    ...overrides,
  });

  it("a stored breach persists across restart until owner resume", () => {
    const blocked = lossFloor({
      policy,
      portfolio: portfolio({}),
      equityBasisUsd: 1000,
      sealedBreach: true,
      realized_pnl_24h: 0,
    });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.sealedBreach, true);
    assert.ok(
      blocked.reasons.some((r) => r.includes("persists until owner resume")),
    );
  });

  it("a breach seals on daily-loss stop and survives a fresh start", () => {
    // -30 on 1000 basis = 3% daily loss -> > 2% stop -> blocked and sealed.
    const breached = lossFloor({
      policy,
      portfolio: portfolio({}),
      equityBasisUsd: 1000,
      sealedBreach: false,
      realized_pnl_24h: -30,
    });
    assert.equal(breached.blocked, true);
    assert.equal(breached.sealedBreach, true);

    // Simulated restart: panel unchanged, loss unchanged, no seal lost.
    const afterRestart = lossFloor({
      policy,
      portfolio: portfolio({ realized_pnl_24h: -30 }),
      equityBasisUsd: 1000,
      sealedBreach: false,
      realized_pnl_24h: -30,
    });
    assert.equal(afterRestart.blocked, true);
    assert.equal(afterRestart.sealedBreach, true);
  });

  it("a deposit inflates equity basis but does NOT erase an accrued loss", () => {
    // Deposit of +500 must not convert the -40 loss into "all clear".
    const before = lossFloor({
      policy,
      portfolio: portfolio({}),
      equityBasisUsd: 1000 + 500,
      sealedBreach: false,
      realized_pnl_24h: -40,
    });
    // 40/1500 = 2.67% is still above the 2% daily stop.
    assert.equal(before.blocked, true);
  });

  it("normal activity under limits stays unblocked and unsealed", () => {
    const ok = lossFloor({
      policy,
      portfolio: portfolio({}),
      equityBasisUsd: 1000,
      sealedBreach: false,
      realized_pnl_24h: -5,
    });
    assert.equal(ok.blocked, false);
    assert.equal(ok.sealedBreach, false);
  });
});