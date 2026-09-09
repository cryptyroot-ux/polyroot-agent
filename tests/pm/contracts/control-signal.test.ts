import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateEdge } from "@polyroot/control";
import type { Forecast, MarketSnapshot } from "@polyroot/domain";
import { ulid } from "ulid";

function close(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

function makeForecast(over: Partial<Forecast> = {}): Forecast {
  return {
    schema_version: "1.1",
    forecast_id: ulid(),
    market_id: "mkt_1",
    p_calibrated: 0.7,
    confidence: 0.8,
    horizon_sec: 3600,
    valid_until: new Date("2026-01-01T01:00:00Z"),
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function makeBook(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    schema_version: "1.1",
    event_id: "evt_1",
    market_id: "mkt_1",
    question: "Will X happen?",
    chain_id: 137,
    collateral: "0xCOLLAT",
    rules_hash: "rh_1",
    fee_maker_bps: 0,
    fee_taker_bps: 0,
    tick_size: 0.01,
    min_size: 1,
    status: "ACTIVE",
    is_neg_risk: false,
    venue_mode: "NORMAL",
    yes_price: 0.4,
    no_price: 0.6,
    source_at: new Date("2026-01-01T00:00:00Z"),
    received_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

describe("Control — signal edge evaluation (evaluateEdge)", () => {
  it("trades YES when the calibrated forecast beats the YES book", () => {
    const res = evaluateEdge(
      { forecast: makeForecast(), book: makeBook() },
      { minEdge: 0.05 },
    );
    assert.equal(res.action, "TRADE");
    assert.equal(res.side, "YES");
    assert.ok(close(res.edge, 0.3));
    assert.ok(close(res.edge_after_fees, 0.3));
    assert.ok(close(res.probability, 0.7));
    assert.ok(close(res.reference_price, 0.4));
    assert.equal(res.code, "OK");
  });

  it("trades NO when the forecast is below the market", () => {
    const res = evaluateEdge(
      {
        forecast: makeForecast({ p_calibrated: 0.3 }),
        book: makeBook({ yes_price: 0.6, no_price: 0.4 }),
      },
      { minEdge: 0.05 },
    );
    assert.equal(res.action, "TRADE");
    assert.equal(res.side, "NO");
    assert.ok(close(res.edge, 0.3));
  });

  it("picks the side with the greater edge", () => {
    const res = evaluateEdge(
      {
        forecast: makeForecast({ p_calibrated: 0.6 }),
        book: makeBook({ yes_price: 0.55, no_price: 0.3 }),
      },
      { minEdge: 0.05 },
    );
    // YES gross = 0.6 - 0.55 = 0.05 ; NO gross = 0.40 - 0.3 = 0.10
    assert.equal(res.side, "NO");
    assert.ok(close(res.edge, 0.1));
    assert.equal(res.action, "TRADE");
  });

  it("abstains when the best edge is below minEdge", () => {
    const res = evaluateEdge(
      {
        forecast: makeForecast({ p_calibrated: 0.7 }),
        book: makeBook({ yes_price: 0.55, no_price: 0.45 }),
      },
      { minEdge: 0.2 },
    );
    assert.equal(res.action, "NO_TRADE");
    assert.equal(res.side, "YES");
    assert.equal(res.code, "MIN_EDGE_UNMET");
    assert.ok(close(res.edge, 0.15));
  });

  it("nets the venue taker fee out of the edge", () => {
    const res = evaluateEdge(
      {
        forecast: makeForecast({ p_calibrated: 0.7 }),
        book: makeBook({ yes_price: 0.55, no_price: 0.45, fee_taker_bps: 20 }),
      },
      { minEdge: 0.15 },
    );
    // gross 0.15, taker fee 20bps = 0.002 => net 0.148 < 0.15
    assert.equal(res.action, "NO_TRADE");
    assert.equal(res.code, "MIN_EDGE_UNMET");
    assert.ok(close(res.edge_after_fees, 0.148));
  });

  it("refuses when the edge is not positive after fees", () => {
    const res = evaluateEdge(
      {
        forecast: makeForecast({ p_calibrated: 0.5 }),
        book: makeBook({ yes_price: 0.55, no_price: 0.52 }),
      },
      { minEdge: 0 },
    );
    // YES gross = 0.5 - 0.55 = -0.05 ; NO gross = 0.5 - 0.52 = -0.02
    assert.equal(res.action, "NO_TRADE");
    assert.equal(res.code, "NEGATIVE_EDGE");
    assert.ok(close(res.edge, -0.02));
  });

  it("rejects a forecast with no probability fields", () => {
    const res = evaluateEdge(
      { forecast: makeForecast({ p_calibrated: undefined, p_raw: undefined, probability_yes: undefined }), book: makeBook() },
      { minEdge: 0.05 },
    );
    assert.equal(res.action, "NO_TRADE");
    assert.equal(res.code, "NO_PROBABILITY");
  });

  it("rejects a book with no YES or NO prices", () => {
    const res = evaluateEdge(
      { forecast: makeForecast(), book: makeBook({ yes_price: undefined, no_price: undefined }) },
      { minEdge: 0.05 },
    );
    assert.equal(res.action, "NO_TRADE");
    assert.equal(res.code, "NO_BOOK");
  });
});