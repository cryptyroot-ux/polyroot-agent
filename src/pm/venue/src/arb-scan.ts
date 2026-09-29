/**
 * @polyroot/venue — Multi-outcome arb scanner (observation only).
 *
 * Periodically groups active Gamma events into per-event YES-token sets,
 * reads each token's touch from the CLOB book, runs the pure
 * evaluateMultiOutcomeArb detector, and persists VALID verdicts to
 * `arb_observations` as research evidence. It never places fills: leg risk
 * across non-atomic orders is real money risk, so entries stay unwired
 * until shadow validation says otherwise.
 *
 * Every stage is fail-open (skipped event/token/tick, never a crash).
 */

import { evaluateMultiOutcomeArb } from "@polyroot/strategy";
import type { InsertablePool } from "./resolution-recorder.js";

const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";
const CLOB_BOOK_URL = "https://clob.polymarket.com/book";

export interface ArbEventTokens {
  eventId: string;
  /** YES token id per outcome market, in event order. */
  yesTokens: string[];
  endDateMs?: number;
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

function toMs(raw: unknown): number | undefined {
  if (typeof raw === "string" && raw) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

/**
 * Pure grouping: Gamma /events payload -> per-event YES-token sets.
 * Only multi-outcome events (2+ outcome markets with YES tokens) qualify;
 * single binary markets are the live loop's job, not the basket scanner's.
 */
export function groupArbEvents(data: unknown): ArbEventTokens[] {
  if (!Array.isArray(data)) return [];
  const out: ArbEventTokens[] = [];
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
    const yesTokens: string[] = [];
    let endDateMs: number | undefined;
    for (const m of markets) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m as Record<string, unknown>;
      if (rec["closed"] === true) continue;
      const ids = toTokenIds(rec["clobTokenIds"]);
      if (ids.length < 2 || !ids[0]) continue;
      yesTokens.push(ids[0] as string);
      endDateMs = toMs(rec["endDate"]) ?? endDateMs;
    }
    if (yesTokens.length < 2) continue;
    const entry: ArbEventTokens = { eventId, yesTokens };
    if (endDateMs !== undefined) entry.endDateMs = endDateMs;
    out.push(entry);
  }
  return out;
}

export interface ArbScanDeps {
  pool: InsertablePool;
  /** Max events per scan (default 20). */
  eventLimit?: number;
  /** Max tokens read per scan — bounds CLOB traffic (default 30). */
  maxTokens?: number;
  /** Minimum basket edge to record (default 0.03). */
  minEdge?: number;
  intervalMs?: number;
  fetchEvents?: () => Promise<unknown>;
  readTouch?: (tokenId: string) => Promise<{ yesPrice: number } | null>;
  onTick?: (summary: ArbScanSummary) => void;
  onError?: (err: Error) => void;
}

export interface ArbScanSummary {
  eventsScanned: number;
  tokensRead: number;
  observations: number;
}

export interface ArbScanHandle {
  stop: () => void;
  tick: () => Promise<ArbScanSummary>;
}

async function defaultReadTouch(
  tokenId: string,
): Promise<{ yesPrice: number } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(
      `${CLOB_BOOK_URL}?token_id=${encodeURIComponent(tokenId)}`,
      { signal: ctrl.signal },
    );
    if (!res.ok) return null;
    const book = (await res.json()) as {
      asks?: Array<{ price?: string }>;
    };
    const asks = (book.asks ?? [])
      .map((l) => Number(l.price))
      .filter((p) => Number.isFinite(p) && p > 0 && p < 1);
    if (asks.length === 0) return null;
    return { yesPrice: Math.min(...asks) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function startArbScan(deps: ArbScanDeps): ArbScanHandle {
  const intervalMs = Math.max(deps.intervalMs ?? 30 * 60_000, 30_000);
  const eventLimit = deps.eventLimit ?? 20;
  const maxTokens = deps.maxTokens ?? 30;
  const minEdge = deps.minEdge ?? 0.03;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async (): Promise<ArbScanSummary> => {
    const summary: ArbScanSummary = {
      eventsScanned: 0,
      tokensRead: 0,
      observations: 0,
    };
    try {
      const raw = deps.fetchEvents
        ? await deps.fetchEvents()
        : await (async () => {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 15_000);
            try {
              const res = await fetch(
                `${GAMMA_EVENTS_URL}?active=true&closed=false&limit=50`,
                { signal: ctrl.signal },
              );
              if (!res.ok) throw new Error(`Gamma API HTTP ${res.status}`);
              return (await res.json()) as unknown;
            } finally {
              clearTimeout(t);
            }
          })();
      const read = deps.readTouch ?? defaultReadTouch;
      let budget = maxTokens;
      for (const ev of groupArbEvents(raw).slice(0, eventLimit)) {
        if (budget <= 0) break;
        summary.eventsScanned += 1;
        const legs: Array<{ tokenId: string; yesPrice: number }> = [];
        for (const tokenId of ev.yesTokens) {
          if (budget <= 0) break;
          budget -= 1;
          summary.tokensRead += 1;
          try {
            const touch = await read(tokenId);
            if (touch) legs.push({ tokenId, yesPrice: touch.yesPrice });
          } catch {
            // unreadable token: basket without it is a different basket
          }
        }
        // Partial baskets are not baskets: only evaluate complete sets.
        if (legs.length !== ev.yesTokens.length) continue;
        const verdict = evaluateMultiOutcomeArb(legs, { minEdge });
        if (!verdict.valid || !verdict.direction) continue;
        // Same event+direction seen within the hour: refresh nothing.
        // Without this the table fills with one row per scan per event.
        const recent = await deps.pool.query(
          `SELECT 1 FROM arb_observations
            WHERE event_id = $1 AND direction = $2
              AND observed_at > now() - interval '1 hour'
            LIMIT 1`,
          [ev.eventId, verdict.direction],
        );
        if (recent.rows.length > 0) continue;
        await deps.pool.query(
          `INSERT INTO arb_observations
             (event_id, direction, legs, total_cost, guaranteed_payout, edge)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            ev.eventId,
            verdict.direction,
            JSON.stringify(
              legs.map((l) => ({ tokenId: l.tokenId, yesPrice: l.yesPrice })),
            ),
            verdict.totalCost,
            verdict.guaranteedPayout,
            verdict.edge,
          ],
        );
        summary.observations += 1;
      }
      deps.onTick?.(summary);
      return summary;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      deps.onError?.(e);
      return summary;
    }
  };

  const first = setTimeout(() => {
    if (stopped) return;
    void tick();
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
  }, 60_000);

  return {
    stop: () => {
      stopped = true;
      clearTimeout(first);
      if (timer) clearInterval(timer);
    },
    tick,
  };
}
