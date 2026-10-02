/**
 * @polyroot/venue — Human-friendly market discovery.
 *
 * Owners pick markets by NAME (question text), not by raw CLOB token ids.
 * This module fetches active events from the public Polymarket Gamma API
 * (no auth needed) and resolves each pick to its Yes/No CLOB token ids,
 * which is what the agent loop actually trades on.
 *
 * Network is isolated here: parsing is pure (unit-tested), fetching has a
 * timeout and throws a plain Error so callers can fall back to manual paste.
 */

export interface DiscoveredMarket {
  question: string;
  slug: string;
  /** Yes-outcome CLOB token id. */
  yesTokenId: string;
  /** No-outcome CLOB token id. */
  noTokenId: string;
  volume24h: number;
  /**
   * Resolution timestamp (ms epoch) from Gamma `endDate`, when provided.
   * Absent = unknown (no expiry judgement — never blocks on missing data).
   */
  endDateMs?: number;
}

/** Parse Gamma ISO date to ms epoch. Null/NaN when absent or unparseable. */
function toEndDateMs(raw: unknown): number | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";

/** Normalize the Gamma `clobTokenIds` field (JSON string or array) to ids. */
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

function toNumber(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : (raw as number);
  return Number.isFinite(n) ? (n as number) : 0;
}

/** Pure parser: Gamma /events payload -> tradeable markets. Skips defects. */
export function parseGammaEvents(data: unknown): DiscoveredMarket[] {
  if (!Array.isArray(data)) return [];
  const out: DiscoveredMarket[] = [];
  for (const event of data) {
    if (typeof event !== "object" || event === null) continue;
    const eventRec = event as Record<string, unknown>;
    const markets = (event as { markets?: unknown }).markets;
    if (!Array.isArray(markets)) continue;
    for (const m of markets) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m as Record<string, unknown>;
      const ids = toTokenIds(rec["clobTokenIds"]);
      const question =
        typeof rec["question"] === "string" ? rec["question"] : "";
      if (ids.length < 2 || !question) continue;
      const market: DiscoveredMarket = {
        question,
        slug: typeof rec["slug"] === "string" ? (rec["slug"] as string) : "",
        yesTokenId: ids[0] as string,
        noTokenId: ids[1] as string,
        volume24h: toNumber(rec["volume24hr"]),
      };
      // endDate lives on the market, falling back to the parent event.
      const endDateMs =
        toEndDateMs(rec["endDate"]) ?? toEndDateMs(eventRec["endDate"]);
      if (endDateMs !== undefined) market.endDateMs = endDateMs;
      out.push(market);
    }
  }
  return out;
}

/** Fetch the most active markets, sorted by 24h volume. Throws on failure. */
export async function fetchActiveMarkets(
  limit = 20,
  timeoutMs = 15_000,
): Promise<DiscoveredMarket[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${GAMMA_EVENTS_URL}?active=true&closed=false&limit=${Math.max(1, Math.min(limit, 50))}`,
      { signal: ctrl.signal },
    );
    if (!res.ok) {
      throw new Error(`Gamma API HTTP ${res.status}`);
    }
    const data: unknown = await res.json();
    return parseGammaEvents(data)
      .sort((a, b) => b.volume24h - a.volume24h)
      .slice(0, limit);
  } catch (err) {
    throw new Error(
      `market discovery failed: ${(err as Error).message ?? err}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a human pick like "1,3,5" or "all" against a discovered list.
 * Returns the chosen markets (deduped, order preserved). Throws on garbage.
 */
export function parseMarketPick(
  raw: string,
  markets: DiscoveredMarket[],
): DiscoveredMarket[] {
  const t = raw.trim().toLowerCase();
  if (!t) return [];
  if (t === "all" || t === "semua") return [...markets];
  const picks: DiscoveredMarket[] = [];
  const seen = new Set<number>();
  for (const part of t.split(/[,\s]+/)) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > markets.length) {
      throw new Error(
        `invalid pick "${part}" — choose numbers 1-${markets.length}, comma-separated, or "all"`,
      );
    }
    if (!seen.has(n)) {
      seen.add(n);
      picks.push(markets[n - 1] as DiscoveredMarket);
    }
  }
  return picks;
}

export interface DiscoveryBounds {
  minVolume24h: number;
  maxMarkets: number;
  /** Max touch spread (ask-bid) a token may have to be tradeable. */
  maxSpread: number;
  /**
   * Markets resolving sooner than this (hours) are resolution gambles, not
   * forecastable edge — rejected. Default 2h. 0 disables the check.
   */
  minHoursToExpiry: number;
  /**
   * Minimum touch-depth notional (USD) a token must rest. A $100 account
   * cannot exit a $5-deep book without ruinous slippage. Default $25.
   * 0 disables the check.
   */
  minTouchDepthUsd: number;
  /**
   * Max 24h-volume ÷ touch-depth ratio. Extreme churn on a paper-thin book
   * is the wash/spoof signature — real liquidity rests depth proportional
   * to its flow. Default 2000. 0 disables the check.
   */
  maxChurnRatio: number;
}

/** Owner guardrails for auto-discovery. Invalid values fall back to safe
 *  defaults (never zero/unbounded). */
export function parseDiscoveryBounds(env: {
  POLYROOT_DISCOVERY_MIN_VOLUME_24H?: string;
  POLYROOT_DISCOVERY_MAX_MARKETS?: string;
  POLYROOT_DISCOVERY_MAX_SPREAD?: string;
  POLYROOT_DISCOVERY_MIN_HOURS_TO_EXPIRY?: string;
  POLYROOT_DISCOVERY_MIN_TOUCH_DEPTH_USD?: string;
  POLYROOT_DISCOVERY_MAX_CHURN_RATIO?: string;
}): DiscoveryBounds {
  const minRaw = Number(env.POLYROOT_DISCOVERY_MIN_VOLUME_24H);
  const maxRaw = Number(env.POLYROOT_DISCOVERY_MAX_MARKETS);
  const spreadRaw = Number(env.POLYROOT_DISCOVERY_MAX_SPREAD);
  const expRaw = Number(env.POLYROOT_DISCOVERY_MIN_HOURS_TO_EXPIRY);
  const depthRaw = Number(env.POLYROOT_DISCOVERY_MIN_TOUCH_DEPTH_USD);
  const churnRaw = Number(env.POLYROOT_DISCOVERY_MAX_CHURN_RATIO);
  return {
    minVolume24h:
      Number.isFinite(minRaw) && minRaw > 0 ? Math.floor(minRaw) : 10_000,
    maxMarkets:
      Number.isFinite(maxRaw) && maxRaw > 0
        ? Math.min(Math.floor(maxRaw), 20)
        : 5,
    maxSpread:
      Number.isFinite(spreadRaw) && spreadRaw > 0
        ? Math.min(Math.max(spreadRaw, 0.01), 0.5)
        : 0.1,
    minHoursToExpiry:
      env.POLYROOT_DISCOVERY_MIN_HOURS_TO_EXPIRY === undefined
        ? 2
        : Number.isFinite(expRaw) && expRaw >= 0
          ? expRaw
          : 2,
    minTouchDepthUsd:
      env.POLYROOT_DISCOVERY_MIN_TOUCH_DEPTH_USD === undefined
        ? 25
        : Number.isFinite(depthRaw) && depthRaw >= 0
          ? depthRaw
          : 25,
    maxChurnRatio:
      env.POLYROOT_DISCOVERY_MAX_CHURN_RATIO === undefined
        ? 2000
        : Number.isFinite(churnRaw) && churnRaw >= 0
          ? churnRaw
          : 2000,
  };
}

/** Pure selector: liquid markets only, top-N by 24h volume. */
export function selectLiquidMarkets(
  markets: DiscoveredMarket[],
  bounds: DiscoveryBounds,
): DiscoveredMarket[] {
  return [...markets]
    .filter((m) => m.volume24h >= bounds.minVolume24h)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, bounds.maxMarkets);
}

const CLOB_BOOK_URL = "https://clob.polymarket.com/book";

export interface TokenTouch {
  tokenId: string;
  bid?: number;
  ask?: number;
  /** Resting shares at the best bid/ask (CLOB book `size`). Absent = unknown. */
  bidSizeShares?: number;
  askSizeShares?: number;
}

/**
 * Touch-depth notional in USD (best bid value + best ask value).
 * Null when size data is absent — callers must skip depth judgement then
 * (legacy stubs, partial books), never fabricate it.
 */
export function touchDepthNotionalUsd(t: TokenTouch): number | null {
  if (t.bidSizeShares === undefined || t.askSizeShares === undefined) {
    return null;
  }
  const bid = t.bid ?? 0;
  const ask = t.ask ?? 0;
  const depth =
    (Number.isFinite(bid) ? bid : 0) * Math.max(t.bidSizeShares, 0) +
    (Number.isFinite(ask) ? ask : 0) * Math.max(t.askSizeShares, 0);
  return Number.isFinite(depth) ? depth : null;
}

/** Best touch from a public CLOB book. Null when no usable levels. */
export async function fetchTokenTouch(
  tokenId: string,
  timeoutMs = 8_000,
): Promise<TokenTouch | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${CLOB_BOOK_URL}?token_id=${encodeURIComponent(tokenId)}`,
      { signal: ctrl.signal },
    );
    if (!res.ok) return null;
    const book = (await res.json()) as {
      bids?: Array<{ price?: string; size?: string }>;
      asks?: Array<{ price?: string; size?: string }>;
    };
    const finite = (
      levels: Array<{ price?: string; size?: string }> | undefined,
    ): Array<{ price: number; size: number }> =>
      (levels ?? [])
        .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
        .filter(
          (l) =>
            Number.isFinite(l.price) &&
            l.price >= 0 &&
            l.price <= 1 &&
            Number.isFinite(l.size) &&
            l.size > 0,
        );
    const bids = finite(book.bids).sort((a, b) => b.price - a.price);
    const asks = finite(book.asks).sort((a, b) => a.price - b.price);
    if (bids.length === 0 && asks.length === 0) return null;
    const touch: TokenTouch = { tokenId };
    const bestBid = bids[0];
    const bestAsk = asks[0];
    if (bestBid) {
      touch.bid = bestBid.price;
      touch.bidSizeShares = bestBid.size;
    }
    if (bestAsk) {
      touch.ask = bestAsk.price;
      touch.askSizeShares = bestAsk.size;
    }
    return touch;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface SpreadCheckedMarket {
  market: DiscoveredMarket;
  /** Only the token ids whose touch spread is within maxSpread. */
  tokenIds: string[];
}

/**
 * Verify real order-book touches and keep tradeable tokens only. A token
 * survives when it has bid+ask with (ask - bid) <= maxSpread AND both sides
 * inside the evaluable price band (0.02..0.98, mirroring the pipeline's
 * extreme filter — dust at 0.001/0.999 can never carry edge). A market
 * survives when at least one of its Yes/No tokens survives. Failures
 * (network/empty book) drop the token, never fabricate it. `touch` is
 * injectable for tests.
 */
export type DiscoveryStrictness = "permissive" | "standard" | "strict";

export interface TouchGuards {
  /** Minimum touch-depth notional in USD (default 25, 0 disables). */
  minTouchDepthUsd?: number;
  /** Max 24h-volume ÷ touch-depth churn ratio (default 2000, 0 disables). */
  maxChurnRatio?: number;
  /** Markets resolving sooner than this (hours) are skipped (default 2, 0 disables). */
  minHoursToExpiry?: number;
  /** Clock override (tests). */
  nowMs?: number;
  /**
   * Fail-open policy for incomplete data (default "standard" = historic
   * behavior). "strict" (LIVE/MICRO_LIVE) blocks unknown expiries and
   * price-only touches without depth: real money never trades what it
   * cannot see. "permissive" equals standard today and stays reserved
   * for PAPER experimentation.
   */
  strictness?: DiscoveryStrictness;
}

export async function filterTightSpreadTokens(
  markets: DiscoveredMarket[],
  maxSpread: number,
  touch: (tokenId: string) => Promise<TokenTouch | null> = fetchTokenTouch,
  guards: TouchGuards = {},
): Promise<SpreadCheckedMarket[]> {
  const out: SpreadCheckedMarket[] = [];
  const nowMs = guards.nowMs ?? Date.now();
  const minDepth = guards.minTouchDepthUsd ?? 25;
  const maxChurn = guards.maxChurnRatio ?? 2000;
  const minExpMs = (guards.minHoursToExpiry ?? 2) * 3_600_000;
  const strict = guards.strictness === "strict";
  await Promise.all(
    markets.map(async (market) => {
      // Expiry gate first: no network spent on resolution gambles.
      // Unknown expiry never blocks (fail-open on missing data) — except
      // under strictness "strict", where an unknowable horizon is itself
      // disqualifying for real-money books.
      if (minExpMs > 0) {
        if (market.endDateMs === undefined) {
          if (strict) return;
        } else if (market.endDateMs - nowMs < minExpMs) {
          return;
        }
      }
      const [yes, no] = await Promise.all([
        touch(market.yesTokenId),
        touch(market.noTokenId),
      ]);
      const tokenIds: string[] = [];
      for (const t of [yes, no]) {
        if (
          t?.bid === undefined ||
          t?.ask === undefined ||
          t.bid < 0.02 ||
          t.ask > 0.98 ||
          t.ask - t.bid > maxSpread
        ) {
          continue;
        }
        // Depth + churn gates only when size data exists (legacy stubs and
        // partial books carry price-only touches — judged by spread alone).
        // Under "strict", a touch without depth is unpriceable slippage:
        // block it instead of judging by spread alone.
        const depth = touchDepthNotionalUsd(t);
        if (depth === null) {
          if (strict) continue;
        } else {
          if (minDepth > 0 && depth < minDepth) continue;
          if (
            maxChurn > 0 &&
            market.volume24h / Math.max(depth, 1e-9) > maxChurn
          ) {
            continue;
          }
        }
        tokenIds.push(t.tokenId);
      }
      if (tokenIds.length > 0) out.push({ market, tokenIds });
    }),
  );
  // Preserve volume order (parallel fetch completes out of order).
  const rank = new Map(markets.map((m, i) => [m.question, i]));
  out.sort(
    (a, b) =>
      (rank.get(a.market.question) ?? 0) - (rank.get(b.market.question) ?? 0),
  );
  return out;
}

/**
 * Decide manual vs auto discovery (pure, fully unit-tested).
 *
 * - explicit "auto"/"manual" always wins.
 * - unset + curated POLYROOT_MARKET_IDS present → manual (backward compat:
 *   existing installs keep hunting exactly their list).
 * - unset + no ids → auto (fresh installs hunt by themselves; nothing to configure).
 */
export function resolveDiscoveryMode(env: {
  POLYROOT_MARKET_DISCOVERY?: string;
  POLYROOT_MARKET_IDS?: string;
}): "auto" | "manual" {
  const raw = (env.POLYROOT_MARKET_DISCOVERY ?? "").trim().toLowerCase();
  if (raw === "auto") return "auto";
  if (raw === "manual") return "manual";
  return (env.POLYROOT_MARKET_IDS ?? "").trim().length > 0 ? "manual" : "auto";
}

/**
 * Resolve the trading universe for SHADOW/MICRO_LIVE/LIVE.
 *
 * - manual: exact owner-curated POLYROOT_MARKET_IDS (unchanged).
 * - auto: the agent fetches active markets itself, keeps the most liquid
 *   by volume, then verifies each token's real order-book touch and drops
 *   anything wider than the owner max spread. Every surviving id is still
 *   validated as a CLOB asset id; zero survivors = throw, fail-closed.
 */
export async function resolveMarketUniverse(env: {
  POLYROOT_MARKET_DISCOVERY?: string;
  POLYROOT_MARKET_IDS?: string;
  POLYROOT_DISCOVERY_MIN_VOLUME_24H?: string;
  POLYROOT_DISCOVERY_MAX_MARKETS?: string;
  POLYROOT_DISCOVERY_MAX_SPREAD?: string;
}): Promise<string[]> {
  return (await resolveMarketUniverseWithSides(env)).ids;
}

/** Token side within its binary market. */
export type TokenSide = "YES" | "NO";

export interface MarketUniverseWithSides {
  ids: string[];
  /**
   * Side per token id. Discovery fills it from yesTokenId/noTokenId;
   * manual ids are absent (= UNKNOWN — treated as YES, see executeG4Step).
   */
  sides: Partial<Record<string, TokenSide>>;
}

/**
 * resolveMarketUniverse plus per-token sides. resolveMarketUniverse
 * delegates to this and returns ids only (unchanged contract).
 */
export async function resolveMarketUniverseWithSides(env: {
  POLYROOT_MARKET_DISCOVERY?: string;
  POLYROOT_MARKET_IDS?: string;
  POLYROOT_DISCOVERY_MIN_VOLUME_24H?: string;
  POLYROOT_DISCOVERY_MAX_MARKETS?: string;
  POLYROOT_DISCOVERY_MAX_SPREAD?: string;
}): Promise<MarketUniverseWithSides> {
  const { readMarketUniverse } = await import("./market-universe.js");
  if (resolveDiscoveryMode(env) !== "auto") {
    return { ids: readMarketUniverse(env), sides: {} };
  }
  const bounds = parseDiscoveryBounds(env);
  const volOk = (await fetchActiveMarkets(50))
    .filter((m) => m.volume24h >= bounds.minVolume24h)
    .sort((a, b) => b.volume24h - a.volume24h);
  const liquid = await filterTightSpreadTokens(
    volOk.slice(0, 15),
    bounds.maxSpread,
    fetchTokenTouch,
    {
      minTouchDepthUsd: bounds.minTouchDepthUsd,
      maxChurnRatio: bounds.maxChurnRatio,
      minHoursToExpiry: bounds.minHoursToExpiry,
    },
  );
  const chosen = liquid.slice(0, bounds.maxMarkets);
  const ids = chosen.flatMap((m) => m.tokenIds);
  if (ids.length === 0) {
    throw new Error(
      `MARKET_UNIVERSE_MISSING: auto-discovery found no tradeable tokens (24h volume >= $${bounds.minVolume24h}, spread <= ${bounds.maxSpread}). Lower the guardrails via \`polyroot setup\` or curate POLYROOT_MARKET_IDS.`,
    );
  }
  const sides: Partial<Record<string, TokenSide>> = {};
  for (const id of ids) {
    for (const m of volOk) {
      if (m.yesTokenId === id) sides[id] = "YES";
      else if (m.noTokenId === id) sides[id] = "NO";
    }
  }
  return {
    ids: readMarketUniverse({ POLYROOT_MARKET_IDS: ids.join(",") }),
    sides,
  };
}
