/**
 * @polyroot/strategy — Exit/Reallocation Engine & Experiment Registry Tests
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExitEngine, ExperimentRegistry } from "@polyroot/strategy";
import type { ParameterEnvelope } from "@polyroot/strategy";

describe("Task 8 — ExitEngine and ExperimentRegistry", () => {
  it("exits position when hold EV < 0 considering bid/depth/time-to-resolution", async () => {
    const engine = new ExitEngine({ minHoldEV: 0 });

    const result = await engine.evaluate({
      position: { market_id: "mkt_1", side: "YES", size: 100, avg_price: 0.6, updated_at: new Date() },
      book: {
        schema_version: "1.0.0",
        market_id: "mkt_1",
        bids: [[0.45, 100]],
        asks: [[0.55, 100]],
        received_at: new Date(),
        source_at: new Date(),
      },
      forecast: {
        schema_version: "1.0.0",
        forecast_id: "f_1",
        market_id: "mkt_1",
        p_conservative: 0.42,
        evidence_ids: [],
        counterevidence_ids: [],
        assumptions: [],
        invalidators: [],
        horizon_sec: 3600,
        valid_until: new Date(Date.now() + 3600000),
        created_at: new Date(),
      },
      time_to_resolution_sec: 3600,
      fees: {
        schema_version: "1.0.0",
        market_id: "mkt_1",
        fee_maker_bps: 0,
        fee_taker_bps: 200,
        fee_currency: "pUSD",
        tick_size: 0.01,
        min_size: 1,
        trade_mode: "BINARY",
        fee_settings_hash: "hash",
        observed_at: new Date(),
      },
    });

    assert.ok(result.intent);
    assert.equal(result.intent.purpose, "EXIT");
    assert.equal(result.intent.side, "SELL");
  });

  it("holds position when hold EV >= minHoldEV", async () => {
    const engine = new ExitEngine({ minHoldEV: 0 });

    const result = await engine.evaluate({
      position: { market_id: "mkt_1", side: "YES", size: 100, avg_price: 0.4, updated_at: new Date() },
      book: {
        schema_version: "1.0.0",
        market_id: "mkt_1",
        bids: [[0.65, 100]],
        asks: [[0.70, 100]],
        received_at: new Date(),
        source_at: new Date(),
      },
      forecast: {
        schema_version: "1.0.0",
        forecast_id: "f_1",
        market_id: "mkt_1",
        p_conservative: 0.75,
        evidence_ids: [],
        counterevidence_ids: [],
        assumptions: [],
        invalidators: [],
        horizon_sec: 3600,
        valid_until: new Date(Date.now() + 3600000),
        created_at: new Date(),
      },
      time_to_resolution_sec: 3600,
      fees: {
        schema_version: "1.0.0",
        market_id: "mkt_1",
        fee_maker_bps: 0,
        fee_taker_bps: 200,
        fee_currency: "pUSD",
        tick_size: 0.01,
        min_size: 1,
        trade_mode: "BINARY",
        fee_settings_hash: "hash",
        observed_at: new Date(),
      },
    });

    assert.equal(result.intent, null);
  });

  it("handles NO position exit calculation", async () => {
    const engine = new ExitEngine({ minHoldEV: 0 });

    const result = await engine.evaluate({
      position: { market_id: "mkt_2", side: "NO", size: 100, avg_price: 0.6, updated_at: new Date() },
      book: {
        schema_version: "1.0.0",
        market_id: "mkt_2",
        bids: [[0.2, 100]], // YES bid = 0.2
        asks: [[0.3, 100]], // YES ask = 0.3 => NO bid = 0.7
        received_at: new Date(),
        source_at: new Date(),
      },
      forecast: {
        schema_version: "1.0.0",
        forecast_id: "f_2",
        market_id: "mkt_2",
        p_conservative: 0.95, // p(YES) = 0.95 => p(NO) = 0.05 (very bearish for NO)
        evidence_ids: [],
        counterevidence_ids: [],
        assumptions: [],
        invalidators: [],
        horizon_sec: 3600,
        valid_until: new Date(Date.now() + 3600000),
        created_at: new Date(),
      },
      time_to_resolution_sec: 3600,
      fees: {
        schema_version: "1.0.0",
        market_id: "mkt_2",
        fee_maker_bps: 0,
        fee_taker_bps: 200,
        fee_currency: "pUSD",
        tick_size: 0.01,
        min_size: 1,
        trade_mode: "BINARY",
        fee_settings_hash: "hash",
        observed_at: new Date(),
      },
    });

    assert.ok(result.intent);
    assert.equal(result.intent.purpose, "EXIT");
    assert.equal(result.intent.side, "SELL");
  });

  it("ExperimentRegistry registers and promotes experiments based on gates", async () => {
    // Mock DB Pool
    const records: Map<string, any> = new Map();
    const mockPool: any = {
      async query(text: string, params?: any[]) {
        if (text.includes("INSERT INTO experiments")) {
          const [id, spec_hash, strategy, version, params_json, envelope_json, status, gate_report_json, created_at, updated_at] = params!;
          records.set(id, { id, spec_hash, strategy, version, params_json, envelope_json, status, gate_report_json, created_at, updated_at });
          return { rows: [{ id }] };
        }
        if (text.includes("UPDATE experiments")) {
          const [status, gate_report, updated_at, id] = params!;
          const rec = records.get(id);
          if (rec) {
            rec.status = status;
            rec.gate_report_json = gate_report;
            rec.updated_at = updated_at;
          }
          return { rowCount: rec ? 1 : 0 };
        }
        if (text.includes("SELECT") && text.includes("FROM experiments")) {
          const id = params![0];
          const rec = records.get(id);
          if (rec) {
            if (params!.length > 1 && rec.status !== params![1]) {
              return { rows: [], rowCount: 0 };
            }
            return { rows: [rec], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    const registry = new ExperimentRegistry(mockPool);
    const envelope: ParameterEnvelope = {
      envelope_id: "env_1",
      envelope_version: "1.0.0",
      created_at: new Date(),
      allowed_ranges: { min_hold_ev: { min: -10, max: 10 } },
      max_step_pct: 0.1,
      pinned_params: [],
      min_data_points: 10,
    };

    const expId = await registry.register({
      strategy: "evidence-directional-v2",
      version: "1.0.0",
      params: { min_edge: 0.05 },
      envelope,
    });

    assert.ok(expId);

    // Promote with passing gates
    await registry.promote(expId, {
      all_passed: true,
      gates: [
        { gate_name: "backtest_sharpe", passed: true, score: 1.8, threshold: 1.0 },
        { gate_name: "max_drawdown", passed: true, score: 0.04, threshold: 0.1 },
      ],
    });

    const expAfterPass = await registry.get(expId);
    assert.equal(expAfterPass?.status, "LIVE_QUALIFIED");

    // Fail promotion for failing gate
    const expId2 = await registry.register({
      strategy: "evidence-directional-v2",
      version: "1.0.0",
      params: { min_edge: 0.01 },
      envelope,
    });

    await registry.promote(expId2, {
      all_passed: false,
      gates: [
        { gate_name: "backtest_sharpe", passed: false, score: 0.5, threshold: 1.0 },
      ],
    });

    const expAfterFail = await registry.get(expId2);
    assert.equal(expAfterFail?.status, "REJECTED");
  });
});