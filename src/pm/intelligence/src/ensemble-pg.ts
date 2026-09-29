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
      `SELECT p_yes, version, components FROM ensemble_versions WHERE version = $1`,
      [version],
    );
    if (res.rows.length === 0) return null;
    return {
      ok: true,
      p_yes: Number(res.rows[0].p_yes),
      version,
      effectiveFamilyCount: countComponentFamilies(res.rows[0].components),
    };
  }
}

/**
 * Distinct `component` names in a stored ensemble. Unparseable/empty
 * payloads count 1 (the stored verdict itself), never 0 — the read path
 * must not erase evidence of a recorded decision.
 */
export function countComponentFamilies(raw: unknown): number {
  const list =
    typeof raw === "string"
      ? (() => {
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return null;
          }
        })()
      : raw;
  if (!Array.isArray(list)) return 1;
  const families = new Set<string>();
  for (const c of list) {
    const name = (c as { component?: unknown } | null)?.component;
    if (typeof name === "string" && name.length > 0) families.add(name);
  }
  return Math.max(families.size, 1);
}

import { PgCalibrationService } from "./calibration.js";
export { PgCalibrationService };
