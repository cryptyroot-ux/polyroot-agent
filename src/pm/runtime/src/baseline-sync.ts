import { SHADOW_BASELINE_ID, type QueryablePool } from "./live-guard-store.js";

/** Refreshes both G5 counters from durable facts: elapsed calendar days since
 *  the baseline started, and how many resolved clusters actually exist.
 *  `observed_days` is derived (never hand-set); `resolved_clusters` is counted
 *  from `resolved_clusters`, so the gate reflects collected evidence only. */
export const BASELINE_REFRESH_SQL = `UPDATE shadow_baseline
   SET observed_days = EXTRACT(EPOCH FROM (now() - observed_started_at)) / 86400.0,
       resolved_clusters = (SELECT count(*)::int FROM resolved_clusters),
       updated_at = now()
 WHERE id = $1
RETURNING observed_days, resolved_clusters`;

export interface BaselineSummary {
  observedDays: number;
  resolvedClusters: number;
}

/** Returns null when the canonical baseline row is absent (migrations not run). */
export async function syncBaselineRow(
  pool: QueryablePool,
): Promise<BaselineSummary | null> {
  const r = await pool.query(BASELINE_REFRESH_SQL, [SHADOW_BASELINE_ID]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    observedDays: Number(row["observed_days"] ?? 0),
    resolvedClusters: Number(row["resolved_clusters"] ?? 0),
  };
}
