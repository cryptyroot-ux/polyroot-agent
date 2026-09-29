/**
 * @polyroot/runtime — Resolution sync (closes the learning loop).
 *
 * Periodically: Gamma closed markets → `resolved_clusters` (idempotent) →
 * isotonic retraining from forecasts ⨝ resolutions. Every stage is
 * fail-open: a failed tick logs one line and retries next interval —
 * trading never blocks on learning.
 *
 * Disabled with POLYROOT_RESOLUTION_SYNC=0. Interval via
 * POLYROOT_RESOLUTION_SYNC_MS (default 1h). The fetch function is
 * injectable so tests run without network.
 */
import {
  fetchClosedEvents,
  parseResolvedMarkets,
  toResolvedCluster,
  recordResolvedClusters,
  type InsertablePool,
} from "@polyroot/venue";
import { PgCalibrationService } from "@polyroot/intelligence";

export interface ResolutionSyncDeps {
  pool: InsertablePool;
  calibration: PgCalibrationService;
  fetchClosed?: () => Promise<unknown>;
  intervalMs?: number;
  eventLimit?: number;
  onTick?: (summary: ResolutionSyncSummary) => void;
  onError?: (err: Error) => void;
}

export interface ResolutionSyncSummary {
  decidedMarkets: number;
  recordedNew: number;
  calibrationGroups: number;
  calibrationSamples: number;
}

export interface ResolutionSyncHandle {
  stop: () => void;
  /** Single pass, for tests and manual `polyroot sync-resolutions` runs. */
  tick: () => Promise<ResolutionSyncSummary>;
}

export function startResolutionSync(deps: ResolutionSyncDeps): ResolutionSyncHandle {
  const intervalMs = deps.intervalMs ?? 3_600_000;
  const limit = deps.eventLimit ?? 50;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async (): Promise<ResolutionSyncSummary> => {
    const empty: ResolutionSyncSummary = {
      decidedMarkets: 0,
      recordedNew: 0,
      calibrationGroups: 0,
      calibrationSamples: 0,
    };
    try {
      const raw = deps.fetchClosed
        ? await deps.fetchClosed()
        : await fetchClosedEvents(limit);
      const decided = parseResolvedMarkets(raw);
      empty.decidedMarkets = decided.length;
      if (decided.length > 0) {
        empty.recordedNew = await recordResolvedClusters(
          deps.pool,
          decided.map(toResolvedCluster),
        );
      }
      try {
        const trained = await deps.calibration.trainFromResolvedClusters();
        empty.calibrationGroups = trained.groupsTrained;
        empty.calibrationSamples = trained.samplesTotal;
      } catch {
        // Training failure must never fail the tick (recording succeeded).
      }
      deps.onTick?.(empty);
      return empty;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      deps.onError?.(e);
      return empty;
    }
  };

  // First pass runs soon after boot (5s) so a fresh box learns fast;
  // the steady interval carries it from there.
  const first = setTimeout(() => {
    if (stopped) return;
    void tick();
    timer = setInterval(() => {
      void tick();
    }, Math.max(intervalMs, 30_000));
  }, 5_000);

  return {
    stop: () => {
      stopped = true;
      clearTimeout(first);
      if (timer) clearInterval(timer);
    },
    tick,
  };
}
