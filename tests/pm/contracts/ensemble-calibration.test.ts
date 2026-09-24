import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { Client } from "pg";
import { PgCalibrationService } from "../../../src/pm/intelligence/src/calibration";

const pgConfig = {
  user: "postgres",
  host: "localhost",
  database: "postgres",
  password: "postgres",
  port: 5432,
};

describe("PM-INTEL-09/10: Forecast Ensemble — Persistent Calibration Service", () => {
  let testClient: Client;
  let cal: PgCalibrationService;

  beforeEach(async () => {
    testClient = new Client(pgConfig);
    await testClient.connect();
    await testClient.query("DROP TABLE IF EXISTS calibration_models");
    await testClient.query(`
      CREATE TABLE calibration_models (
        model_provider TEXT NOT NULL,
        model_name TEXT NOT NULL,
        category TEXT NOT NULL,
        horizon_sec INTEGER NOT NULL,
        regime TEXT,
        isotonic_map JSONB NOT NULL,
        sample_count INTEGER NOT NULL,
        last_trained TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (model_provider, model_name, category, horizon_sec, regime)
      )
    `);

    cal = new PgCalibrationService(testClient as any);
  });

  afterEach(async () => {
    if (testClient) {
      await testClient.query("DROP TABLE IF EXISTS calibration_models");
      await testClient.end();
    }
  });

  it("calibrates by model/category/horizon; recalibrates aggregates", async () => {
    await cal.train({
      model: "gpt-4",
      category: "politics",
      horizon_sec: 3600,
      predictions: [0.8, 0.7, 0.6],
      outcomes: [1, 1, 0],
    });

    const calibrated = await cal.calibrate({
      p_raw: 0.85,
      model: "gpt-4",
      category: "politics",
      horizon_sec: 3600,
    });
    assert.ok(calibrated.p_calibrated < 0.85);
  });
});
