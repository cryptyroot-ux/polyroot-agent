import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { Client } from "pg";
import { PgCalibrationService } from "../../../src/pm/intelligence/src/calibration";
import {
  fitIsotonic,
  applyIsotonic,
  MIN_CALIBRATION_SAMPLES,
} from "../../../src/pm/intelligence/src/calibration";

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

  it("refuses to train on a handful of samples (no fabricated maps)", async () => {
    await assert.rejects(
      cal.train({
        model: "gpt-4",
        category: "politics",
        horizon_sec: 3600,
        predictions: [0.8, 0.7, 0.6],
        outcomes: [1, 1, 0],
      }),
      /insufficient resolved samples/,
    );
    // Untrained service is identity, never a shrunk fabrication.
    const passthrough = await cal.calibrate({
      p_raw: 0.85,
      model: "gpt-4",
      category: "politics",
      horizon_sec: 3600,
    });
    assert.equal(passthrough.p_calibrated, 0.85);
  });

  it("trains a real isotonic map that shrinks longshots, lifts favorites", async () => {
    const lowP = [
      0.05, 0.08, 0.1, 0.12, 0.15, 0.18, 0.2, 0.22, 0.25, 0.28, 0.3, 0.32,
    ];
    const lowY = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    const highP = [
      0.68, 0.7, 0.72, 0.75, 0.78, 0.8, 0.82, 0.85, 0.88, 0.9, 0.92, 0.95,
    ];
    const highY = [1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    await cal.train({
      model: "gpt-4",
      category: "politics",
      horizon_sec: 3600,
      predictions: [...lowP, ...highP],
      outcomes: [...lowY, ...highY],
    });
    const q = (p: number) =>
      cal.calibrate({
        p_raw: p,
        model: "gpt-4",
        category: "politics",
        horizon_sec: 3600,
      });
    // Favorite-longshot direction: cheap tickets were overpriced, favorites cheap.
    assert.ok((await q(0.1)).p_calibrated < 0.1);
    assert.ok((await q(0.9)).p_calibrated > 0.9);
    // Monotone non-decreasing across the dial.
    let prev = -1;
    for (const p of [0.05, 0.2, 0.4, 0.6, 0.8, 0.95]) {
      const c = (await q(p)).p_calibrated;
      assert.ok(c >= prev, `non-monotone at p=${p}`);
      prev = c;
    }
  });

  it("fitIsotonic merges violations into a non-decreasing map", () => {
    const pts = fitIsotonic([
      { p: 0.2, y: 1 },
      { p: 0.5, y: 0 },
      { p: 0.8, y: 1 },
    ]);
    const cals = pts.map((x) => x.cal);
    for (let i = 1; i < cals.length; i++) {
      assert.ok(cals[i]! >= cals[i - 1]!);
    }
    assert.equal(applyIsotonic(pts, 0.0), pts[0]!.cal);
    assert.equal(applyIsotonic(pts, 1.0), pts[pts.length - 1]!.cal);
    assert.equal(MIN_CALIBRATION_SAMPLES, 20);
  });
});
