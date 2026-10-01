/**
 * @polyroot/venue — Resolution recorder.
 *
 * Closes the learning loop: polls Gamma for decided (closed) markets,
 * converts final `outcomePrices` into per-token win/loss facts, and stores
 * them in `resolved_clusters` (idempotent — cluster_hash dedupes). The
 * calibration trainer then learns real isotonic maps from
 * forecasts ⨝ resolutions instead of fabricated shrinks.
 *
 * Decided-market rule (fail-closed): market.closed === true AND
 * outcomePrices parses AND exactly one side exceeds 0.5 AND both
 * clobTokenIds are present. Anything else is skipped, never guessed.
 * (`active` stays true on closed markets — it is NOT consulted.)
 */

import { createHash } from "node:crypto";

const GAMMA_CLOSED_EVENTS_URL = "https://gamma-api.polymarket.com/events";

export interface ResolvedMarket {
  /** Gamma market id (condition-level). */
  marketId: string;
  /** Gamma event id (cluster key). */
  eventId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  /** Winning CLOB token id. */
  winningTokenId: string;
  /** Final YES price (sanity: near 0 or 1 when decided). */
  finalYesPrice: number;
  resolvedAtMs: number;
}

function toTokenIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((t) => typeof t === "string");
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((t) => typeof t === "string");
      }
    } catch {
      return [];
    }
  }
  return [];
}

function toPrices(raw: unknown): number[] | null {
  const list: unknown = typeof raw === "string" ? tryJson(raw) : raw;
  if (!Array.isArray(list)) return null;
  const out = list.map((v) => Number(v));
  if (out.length < 2 || out.some((n) => !Number.isFinite(n))) return null;
  return out;
}

function tryJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function toMs(raw: unknown, fallback?: number): number | undefined {
  if (typeof raw === "string" && raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
}

/**
 * Pure parser: Gamma /events?closed=true payload -> decided markets.
 * `nowMs` injectable for tests (fallback timestamp only).
 */
export function parseResolvedMarkets(
  data: unknown,
  nowMs = Date.now(),
): ResolvedMarket[] {
  if (!Array.isArray(data)) return [];
  const out: ResolvedMarket[] = [];
  for (const event of data) {
    if (typeof event !== "object" || event === null) continue;
    const eventRec = event as Record<string, unknown>;
    const eventId =
      typeof eventRec["id"] === "string"
        ? (eventRec["id"] as string)
        : typeof eventRec["id"] === "number"
          ? String(eventRec["id"])
          : "";
    if (!eventId) continue;
    const markets = (eventRec as { markets?: unknown }).markets;
    if (!Array.isArray(markets)) continue;
    for (const m of markets) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m as Record<string, unknown>;
      if (rec["closed"] !== true) continue;
      const ids = toTokenIds(rec["clobTokenIds"]);
      const prices = toPrices(rec["outcomePrices"]);
      if (ids.length < 2 || !prices || prices.length < 2) continue;
      // Exactly one side must dominate: split/voided markets are skipped.
      const winners = prices.map((p, i) => ({ p, i })).filter((w) => w.p > 0.5);
      if (winners.length !== 1) continue;
      const winIdx = winners[0]!.i;
      const winningTokenId = ids[winIdx];
      if (!winningTokenId) continue;
      const question =
        typeof rec["question"] === "string" ? rec["question"] : "";
      if (!question) continue;
      const marketId =
        typeof rec["id"] === "string"
          ? (rec["id"] as string)
          : typeof rec["id"] === "number"
            ? String(rec["id"])
            : "";
      if (!marketId) continue;
      out.push({
        marketId,
        eventId,
        question,
        yesTokenId: ids[0] as string,
        noTokenId: ids[1] as string,
        winningTokenId,
        finalYesPrice: prices[0] as number,
        resolvedAtMs:
          toMs(
            rec["closedTime"] ?? rec["endDate"],
            toMs(eventRec["closedTime"] ?? eventRec["endDate"], nowMs),
          ) ?? nowMs,
      });
    }
  }
  return out;
}

export interface ResolvedClusterInsert {
  clusterId: string;
  eventId: string;
  marketIds: string[];
  resolutionOutcome: string;
  resolvedAt: Date;
  isIndependent: boolean;
  clusterHash: string;
}

/**
 * One cluster per decided market: the winning token id is the outcome, so
 * the calibration join (`forecasts.market_id = outcome → 1 else 0`) stays
 * exact for both YES- and NO-quoted forecasts. Hash is sha256 (stable).
 */
export function toResolvedCluster(m: ResolvedMarket): ResolvedClusterInsert {
  const clusterId = `market:${m.marketId}`;
  return {
    clusterId,
    eventId: m.eventId,
    marketIds: [m.yesTokenId, m.noTokenId],
    resolutionOutcome: m.winningTokenId,
    resolvedAt: new Date(m.resolvedAtMs),
    isIndependent: true,
    clusterHash: createHash("sha256")
      .update(`polyroot-resolution-v1|${clusterId}|${m.winningTokenId}`)
      .digest("hex"),
  };
}

/** Minimal pool surface (pg Pool satisfies it; tests stub it). */
export interface InsertablePool {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/**
 * Idempotent insert (cluster_hash dedupes reruns). Returns rows inserted.
 * Throws on DB failure — the scheduler catches, logs, retries next tick.
 */
export async function recordResolvedClusters(
  pool: InsertablePool,
  rows: ResolvedClusterInsert[],
): Promise<number> {
  let inserted = 0;
  for (const row of rows) {
    const res = await pool.query(
      `INSERT INTO resolved_clusters
         (cluster_id, event_id, market_ids, resolution_outcome, resolved_at, is_independent, cluster_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (cluster_hash) DO NOTHING`,
      [
        row.clusterId,
        row.eventId,
        row.marketIds,
        row.resolutionOutcome,
        row.resolvedAt.toISOString(),
        row.isIndependent,
        row.clusterHash,
      ],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

/**
 * Fetch recently closed events from Gamma. Throws plain Error on failure
 * (scheduler treats it as a skipped tick, never a crash).
 *
 * Recency filter (default 30 days): Gamma serves oldest-closed first, so
 * an unfiltered poll keeps returning 2021 markets whose tokens no live
 * forecast will ever join against — the calibration trainer would starve
 * forever while the table fills with archaeology. Only recent resolutions
 * can meet live forecasts. 0 disables the filter.
 */
export async function fetchClosedEvents(
  limit = 100,
  timeoutMs = 15_000,
  maxAgeDays = 30,
): Promise<unknown[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${GAMMA_CLOSED_EVENTS_URL}?closed=true&limit=${Math.max(1, Math.min(limit, 100))}`,
      { signal: ctrl.signal },
    );
    if (!res.ok) {
      throw new Error(`Gamma API HTTP ${res.status}`);
    }
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return [];
    if (!(maxAgeDays > 0)) return data;
    const cutoff = Date.now() - maxAgeDays * 24 * 3_600_000;
    return data.filter((event) => {
      if (typeof event !== "object" || event === null) return false;
      const rec = event as Record<string, unknown>;
      const stamp =
        toMs(rec["closedTime"]) ??
        toMs(rec["endDate"]) ??
        toMs(rec["updatedAt"]);
      return stamp !== undefined && stamp >= cutoff;
    });
  } catch (err) {
    throw new Error(
      `resolution fetch failed: ${(err as Error).message ?? err}`,
    );
  } finally {
    clearTimeout(timer);
  }
}
