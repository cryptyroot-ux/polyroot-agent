import { Pool } from "pg";
import type { EnsembleOutcome } from "./calibration.js";

export type ForecastComponent = {
  p_yes: number;
  familyId: string;
  weight?: number;
};

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

import { PgCalibrationService } from "./calibration.js";
export { PgCalibrationService };
