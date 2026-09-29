import { Pool } from "pg";
import type { ForecastComponent } from "./index.js";

export type EnsembleOutcome =
  | { ok: true; p_yes: number; version: string; effectiveFamilyCount: number }
  | { ok: false; code: "NO_VALID_COMPONENT"; version: string };

export const MIN_CALIBRATION_SAMPLES = 20;

export interface IsotonicPoint {
  p: number;
  cal: number;
}

/**
 * Pool-adjacent-violators isotonic regression: the non-decreasing stepwise
 * fit of outcomes on predictions. Pure. Returns breakpoints sorted by p.
 */
export function fitIsotonic(pairs: Array<{ p: number; y: number }>): IsotonicPoint[] {
  const sorted = [...pairs].sort((a, b) => a.p - b.p);
  // Blocks of (weight, sum); merge backwards while monotonicity is violated.
  const blocks: Array<{ ps: number[]; sum: number; n: number }> = [];
  for (const q of sorted) {
    blocks.push({ ps: [q.p], sum: q.y, n: 1 });
    while (blocks.length >= 2) {
      const b = blocks[blocks.length - 1]!;
      const a = blocks[blocks.length - 2]!;
      if (a.sum / a.n <= b.sum / b.n) break;
      a.ps.push(...b.ps);
      a.sum += b.sum;
      a.n += b.n;
      blocks.pop();
    }
  }
  return blocks.map((b) => ({
    p: b.ps[b.ps.length - 1] as number,
    cal: Math.min(Math.max(b.sum / b.n, 0), 1),
  }));
}

/**
 * Evaluate an isotonic map at p: stepwise-constant between breakpoints
 * (the PAV fit is constant per block), clamped to the fitted range.
 * No extrapolation inventions: outside = nearest endpoint value.
 */
export function applyIsotonic(points: IsotonicPoint[], p: number): number {
  if (points.length === 0) return p;
  const sorted = [...points].sort((a, b) => a.p - b.p);
  if (p <= sorted[0]!.p) return sorted[0]!.cal;
  const last = sorted[sorted.length - 1]!;
  if (p >= last.p) return last.cal;
  let lo = sorted[0]!.cal;
  for (const q of sorted) {
    if (q.p <= p) lo = q.cal;
    else break;
  }
  return lo;
}

export class PgCalibrationService {
  constructor(private pool: Pool) {}

  /**
   * Train a real isotonic map (pool-adjacent-violators) from resolved
   * (prediction, outcome) pairs and persist it per
   * (provider, model, category, horizon, regime).
   *
   * Refuses to train under MIN_CALIBRATION_SAMPLES: an isotonic fit on a
   * handful of resolutions is noise dressed as math — the caller keeps the
   * previous map (or identity when none exists) instead of a fabricated one.
   */
  async train(input: {
    model: string;
    category: string;
    horizon_sec: number;
    predictions: number[];
    outcomes: number[];
    regime?: string;
  }): Promise<void> {
    const pairs = input.predictions.map((p, i) => ({
      p,
      y: input.outcomes[i] ?? NaN,
    }));
    const clean = pairs.filter(
      (q) =>
        Number.isFinite(q.p) &&
        q.p >= 0 &&
        q.p <= 1 &&
        Number.isFinite(q.y) &&
        q.y >= 0 &&
        q.y <= 1,
    );
    if (clean.length < MIN_CALIBRATION_SAMPLES) {
      throw new Error(
        `insufficient resolved samples for calibration: ${clean.length} < ${MIN_CALIBRATION_SAMPLES} (not trained)`,
      );
    }
    const points = fitIsotonic(clean);
    const regime = input.regime ?? "default";
    const map = {
      mapping: "isotonic-pav-v1",
      points,
      trained_at: new Date().toISOString(),
    };
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
        regime,
        JSON.stringify(map),
        clean.length,
      ],
    );
  }

  /**
   * Calibrate a raw probability through the stored isotonic map.
   * No map (or a corrupt one) = identity: an untrained calibrator must
   * pass the forecast through untouched, never invent a correction.
   * (This replaces the old constant `p*0.9` shrink, which encoded a
   * permanent bias as calibration.)
   */
  async calibrate(input: {
    p_raw: number;
    model: string;
    category: string;
    horizon_sec: number;
    regime?: string;
  }): Promise<{ p_calibrated: number }> {
    const p = input.p_raw;
    if (!Number.isFinite(p) || p < 0 || p > 1) return { p_calibrated: p };
    const res = await this.pool.query(
      `SELECT isotonic_map FROM calibration_models WHERE model_name = $1 AND category = $2 AND horizon_sec = $3 AND regime = $4`,
      [input.model, input.category, input.horizon_sec, input.regime ?? "default"],
    );
    const map = res.rows[0]?.isotonic_map as
      | { mapping?: unknown; points?: unknown }
      | null
      | undefined;
    if (
      !map ||
      map.mapping !== "isotonic-pav-v1" ||
      !Array.isArray(map.points)
    ) {
      return { p_calibrated: p };
    }
    const points = (
      map.points as Array<{ p?: unknown; cal?: unknown }>
    )
      .filter(
        (q): q is { p: number; cal: number } =>
          typeof q?.p === "number" &&
          typeof q?.cal === "number" &&
          Number.isFinite(q.p) &&
          Number.isFinite(q.cal),
      )
      .sort((a, b) => a.p - b.p);
    if (points.length === 0) return { p_calibrated: p };
    return { p_calibrated: applyIsotonic(points, p) };
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
      `SELECT p_yes, version, components FROM ensemble_versions WHERE version = $1`,
      [version],
    );
    if (res.rows.length === 0) return null;
    return {
      ok: true,
      p_yes: Number(res.rows[0].p_yes),
      version,
      effectiveFamilyCount: countEnsembleFamilies(res.rows[0].components),
    };
  }
}

/**
 * Distinct `component` names in a stored ensemble (mirrors
 * ensemble-pg.countComponentFamilies — kept local so the calibration
 * service has no cross-module read coupling). Garbage/empty counts 1:
 * the stored verdict itself, never 0.
 */
export function countEnsembleFamilies(raw: unknown): number {
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
