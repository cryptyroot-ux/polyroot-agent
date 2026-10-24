import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PositionTracker } from "@polyroot/strategy";
import {
  G4Pipeline,
  applyDurableExposure,
  collapseDurableOrders,
  incrementalFillPnl,
  orderExposureUsd,
  type DurableOpenOrder,
  type ExposureBook,
  type G4PipelineDeps,
  type StepMetricsSnapshot,
} from "@polyroot/runtime";

function metrics(): StepMetricsSnapshot {
  return {
    totalOrders: 0,
    filledOrders: 0,
    totalPnl: 0,
    totalFees: 0,
    maxDrawdown: 0,
    fillRatio: 0,
    currentExposureUsd: 0,
    maxExposureUsd: 0,
  };
}

function book(): ExposureBook {
  return { bookedFillShares: new Map(), baselined: false, sawStep: false };
}

describe("durable exposure snapshot", () => {
  it("books remaining reservation plus filled notional, and drops a released cancel", () => {
    const [open] = collapseDurableOrders([
      {
        market_id: "mkt_a",
        order_id: "ord_1",
        quoted_side: "YES",
        limit_price: "0.5500",
        order_size: "10",
        resolved: false,
        consumed_fill_shares_base: "0",
        consumed_fill_cash_base: "0",
        reservation_status: "ACTIVE",
        reserved_amount: "5500000",
        consumed_amount: "0",
        released_amount: "0",
        probability_yes: "0.6500",
      },
    ]);
    assert.ok(open);
    assert.equal(orderExposureUsd(open), 5.5);

    const [filled] = collapseDurableOrders([
      {
        market_id: "mkt_a",
        order_id: "ord_1",
        quoted_side: "YES",
        limit_price: "0.5500",
        order_size: "10",
        resolved: true,
        resolved_state: "ACKNOWLEDGED",
        consumed_fill_shares_base: "5000000",
        consumed_fill_cash_base: "2750000",
        reservation_status: "CONSUMED",
        reserved_amount: "5500000",
        consumed_amount: "2750000",
        released_amount: "2750000",
        probability_yes: "0.6500",
      },
    ]);
    assert.ok(filled);
    assert.equal(filled.terminal, true);
    assert.equal(orderExposureUsd(filled), 2.75);

    const [cancelled] = collapseDurableOrders([
      {
        market_id: "mkt_a",
        order_id: "ord_1",
        limit_price: "0.5500",
        order_size: "10",
        resolved: true,
        resolved_state: "DEFINITIVE_REJECT",
        consumed_fill_shares_base: "0",
        consumed_fill_cash_base: "0",
        reservation_status: "RELEASED",
        reserved_amount: "5500000",
        consumed_amount: "0",
        released_amount: "5500000",
      },
    ]);
    assert.ok(cancelled);
    assert.equal(orderExposureUsd(cancelled), 0);
  });

  it("does not invent PnL when p is unknown, and does not replay history on a cold start", () => {
    const order: DurableOpenOrder = {
      marketId: "mkt_a",
      orderId: "ord_1",
      limitPrice: 0.55,
      orderSize: 10,
      filledShares: 10,
      filledCashUsd: 5.5,
      remainingReservedUsd: 0,
      reservationKnown: true,
      terminal: true,
      quotedSide: "YES",
    };
    assert.equal(incrementalFillPnl({ previousFilledShares: 0, order }), 0);

    const withP: DurableOpenOrder = { ...order, p: 0.65 };
    const tracker = new PositionTracker();
    const snap = metrics();
    const state = book();
    const first = applyDurableExposure(state, tracker, snap, [withP]);
    assert.equal(first.pnlDelta, 0);
    assert.equal(snap.totalPnl, 0);
    assert.equal(tracker.total(), 5.5);

    const more: DurableOpenOrder = {
      ...withP,
      filledShares: 12,
      filledCashUsd: 6.6,
    };
    const second = applyDurableExposure(state, tracker, snap, [more]);
    assert.ok(second.pnlDelta > 0);
    assert.equal(snap.totalPnl, second.pnlDelta);
    assert.ok(Math.abs(tracker.total() - 6.6) < 1e-9);
  });

  it("replaces pipeline exposure from a snapshot and keeps it when the load fails", async () => {
    let rows: DurableOpenOrder[] | null = [
      {
        marketId: "mkt_open",
        orderId: "ord_restored",
        limitPrice: 0.55,
        orderSize: 10,
        filledShares: 4,
        filledCashUsd: 2.2,
        remainingReservedUsd: 3.3,
        reservationKnown: true,
        terminal: false,
        p: 0.65,
        quotedSide: "YES",
      },
    ];
    let reconciles = 0;
    const pipeline = new G4Pipeline(
      {
        mode: "LIVE",
        microLiveCapUsd: 1000,
        minEdgeAfterCost: 0.01,
        liveLossCapPusd: 100,
      },
      {
        reconcileOpenOrders: async () => {
          reconciles += 1;
        },
        loadDurableOrders: async () => rows,
      } as G4PipelineDeps,
    );
    await pipeline.syncOpenExposure();
    assert.equal(reconciles, 1);
    assert.ok(Math.abs(pipeline.openExposureUsd() - 5.5) < 1e-9);
    assert.equal(pipeline.getMetrics().totalPnl, 0);

    rows = [
      {
        marketId: "mkt_open",
        orderId: "ord_restored",
        limitPrice: 0.55,
        orderSize: 10,
        filledShares: 0,
        filledCashUsd: 0,
        remainingReservedUsd: 0,
        reservationKnown: true,
        terminal: true,
      },
    ];
    await pipeline.syncOpenExposure();
    assert.equal(pipeline.openExposureUsd(), 0);

    rows = [
      {
        marketId: "mkt_open",
        orderId: "ord_2",
        limitPrice: 0.4,
        orderSize: 5,
        filledShares: 0,
        filledCashUsd: 0,
        remainingReservedUsd: 2,
        reservationKnown: true,
        terminal: false,
      },
    ];
    await pipeline.syncOpenExposure();
    assert.equal(pipeline.openExposureUsd(), 2);
    rows = [
      {
        marketId: "mkt_open",
        orderId: "ord_2",
        limitPrice: 0.4,
        orderSize: 5,
        filledShares: 5,
        filledCashUsd: 2,
        remainingReservedUsd: 0,
        reservationKnown: true,
        terminal: true,
        p: 0.7,
        quotedSide: "YES",
      },
    ];
    await pipeline.syncOpenExposure();
    assert.ok(pipeline.getMetrics().totalPnl !== 0);
    assert.equal(pipeline.openExposureUsd(), 2);
    rows = null;
    await pipeline.syncOpenExposure();
    assert.equal(pipeline.openExposureUsd(), 2);
    assert.ok(pipeline.getMetrics().totalPnl !== 0);
  });
});
