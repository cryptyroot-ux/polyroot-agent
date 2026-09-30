import { Pool } from "pg";
import type { ForecastComponent } from "./index.js";

export type EnsembleOutcome =
  | { ok: true; p_yes: number; version: string; effectiveFamilyCount: number }
  | { ok: false; code: "NO_VALID_COMPONENT"; version: string };

export class PgCalibrationService {
  constructor(private pool: Pool) {}

  async train(input: {
    model: string;
    category: string;
    horizon_sec: number;
    predictions: number[];
    outcomes: number[];
  }): Promise<void> {
    const map = { mapping: "dummy_isotonic" };
    await this.pool.query(
      `INSERT INTO calibration_models (model_provider, model_name, category, horizon_sec, regime, isotonic_map, sample_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (model_provider, model_name, category, horizon_sec, regime)
         DO UPDATE SET isotonic_map = EXCLUDED.isotonic_map, sample_count = EXCLUDED.sample_count`,
      [
        "openai",
        input.model,
        input.category,
        input.horizon_sec,
        "default",
        JSON.stringify(map),
        input.predictions.length,
      ],
    );
  }

  async calibrate(input: {
    p_raw: number;
    model: string;
    category: string;
    horizon_sec: number;
  }): Promise<{ p_calibrated: number }> {
    const res = await this.pool.query(
      `SELECT isotonic_map FROM calibration_models WHERE model_name = $1 AND category = $2 AND horizon_sec = $3 AND regime = $4`,
      [input.model, input.category, input.horizon_sec, "default"],
    );
    if (res.rows.length === 0) return { p_calibrated: input.p_raw };

    return { p_calibrated: input.p_raw * 0.9 };
  }
}

export class PgEnsembleStore {
  constructor(private pool: Pool) {}

  async saveEnsemble(
    version: string,
    eventClass: string,
    components: ForecastComponent[],
    weightBook: Map<string, number>,
    p_yes: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO ensemble_versions (version, event_class, weight_book, components, p_yes)
         VALUES ($1, $2, $3, $4, $5)`,
      [
        version,
        eventClass,
        JSON.stringify(Object.fromEntries(weightBook)),
        JSON.stringify(components),
        p_yes,
      ],
    );
  }

  async getEnsemble(version: string): Promise<EnsembleOutcome | null> {
    const res = await this.pool.query(
      `SELECT p_yes, version FROM ensemble_versions WHERE version = $1`,
      [version],
    );
    if (res.rows.length === 0) return null;
    return {
      ok: true,
      p_yes: Number(res.rows[0].p_yes),
      version,
      effectiveFamilyCount: 1,
    };
  }
}
