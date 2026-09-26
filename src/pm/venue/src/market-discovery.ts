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
    const markets = (event as { markets?: unknown }).markets;
    if (!Array.isArray(markets)) continue;
    for (const m of markets) {
      if (typeof m !== "object" || m === null) continue;
      const rec = m as Record<string, unknown>;
      const ids = toTokenIds(rec["clobTokenIds"]);
      const question =
        typeof rec["question"] === "string" ? rec["question"] : "";
      if (ids.length < 2 || !question) continue;
      out.push({
        question,
        slug: typeof rec["slug"] === "string" ? (rec["slug"] as string) : "",
        yesTokenId: ids[0] as string,
        noTokenId: ids[1] as string,
        volume24h: toNumber(rec["volume24hr"]),
      });
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
}

/** Owner guardrails for auto-discovery. Invalid values fall back to safe
 *  defaults (never zero/unbounded). */
export function parseDiscoveryBounds(env: {
  POLYROOT_DISCOVERY_MIN_VOLUME_24H?: string;
  POLYROOT_DISCOVERY_MAX_MARKETS?: string;
  POLYROOT_DISCOVERY_MAX_SPREAD?: string;
}): DiscoveryBounds {
  const minRaw = Number(env.POLYROOT_DISCOVERY_MIN_VOLUME_24H);
  const maxRaw = Number(env.POLYROOT_DISCOVERY_MAX_MARKETS);
  const spreadRaw = Number(env.POLYROOT_DISCOVERY_MAX_SPREAD);
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
      bids?: Array<{ price?: string }>;
      asks?: Array<{ price?: string }>;
    };
    const finite = (levels: Array<{ price?: string }> | undefined): number[] =>
      (levels ?? [])
        .map((l) => Number(l.price))
        .filter((p) => Number.isFinite(p) && p >= 0 && p <= 1);
    const bids = finite(book.bids);
    const asks = finite(book.asks);
    if (bids.length === 0 && asks.length === 0) return null;
    const touch: TokenTouch = { tokenId };
    if (bids.length > 0) touch.bid = Math.max(...bids);
    if (asks.length > 0) touch.ask = Math.min(...asks);
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
export async function filterTightSpreadTokens(
  markets: DiscoveredMarket[],
  maxSpread: number,
  touch: (tokenId: string) => Promise<TokenTouch | null> = fetchTokenTouch,
): Promise<SpreadCheckedMarket[]> {
  const out: SpreadCheckedMarket[] = [];
  await Promise.all(
    markets.map(async (market) => {
      const [yes, no] = await Promise.all([
        touch(market.yesTokenId),
        touch(market.noTokenId),
      ]);
      const tokenIds: string[] = [];
      for (const t of [yes, no]) {
        if (
          t?.bid !== undefined &&
          t?.ask !== undefined &&
          t.bid >= 0.02 &&
          t.ask <= 0.98 &&
          t.ask - t.bid <= maxSpread
        ) {
          tokenIds.push(t.tokenId);
        }
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
 * Resolve the trading universe for SHADOW/MICRO_LIVE/LIVE.
 *
 * - manual (default): exact owner-curated POLYROOT_MARKET_IDS (unchanged).
 * - auto (POLYROOT_MARKET_DISCOVERY=auto): the agent fetches active markets
 *   itself, keeps the most liquid by volume, then verifies each token's real
 *   order-book touch and drops anything wider than the owner max spread.
 *   Every surviving id is still validated as a CLOB asset id; zero
 *   survivors = throw, fail-closed.
 */
export async function resolveMarketUniverse(env: {
  POLYROOT_MARKET_DISCOVERY?: string;
  POLYROOT_MARKET_IDS?: string;
  POLYROOT_DISCOVERY_MIN_VOLUME_24H?: string;
  POLYROOT_DISCOVERY_MAX_MARKETS?: string;
  POLYROOT_DISCOVERY_MAX_SPREAD?: string;
}): Promise<string[]> {
  const { readMarketUniverse } = await import("./market-universe.js");
  if (
    (env.POLYROOT_MARKET_DISCOVERY ?? "manual").trim().toLowerCase() !== "auto"
  ) {
    return readMarketUniverse(env);
  }
  const bounds = parseDiscoveryBounds(env);
  // Volume pre-filter WITHOUT the maxMarkets slice: the top-by-volume
  // markets are often dust (0.001/0.999), so spread-check a wider pool
  // first and only then take the top-N survivors.
  const volOk = (await fetchActiveMarkets(50))
    .filter((m) => m.volume24h >= bounds.minVolume24h)
    .sort((a, b) => b.volume24h - a.volume24h);
  const liquid = await filterTightSpreadTokens(
    volOk.slice(0, 15),
    bounds.maxSpread,
  );
  const chosen = liquid.slice(0, bounds.maxMarkets);
  const ids = chosen.flatMap((m) => m.tokenIds);
  if (ids.length === 0) {
    throw new Error(
      `MARKET_UNIVERSE_MISSING: auto-discovery found no tradeable tokens (24h volume >= $${bounds.minVolume24h}, spread <= ${bounds.maxSpread}). Lower the guardrails via \`polyroot setup\` or curate POLYROOT_MARKET_IDS.`,
    );
  }
  return readMarketUniverse({ POLYROOT_MARKET_IDS: ids.join(",") });
}
