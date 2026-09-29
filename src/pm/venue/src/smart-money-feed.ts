/**
 * @polyroot/venue — Smart-money flow feed.
 *
 * Reads public wallet activity (Polymarket Data API, no auth — any address
 * is readable) for an OWNER-CURATED watchlist and reduces it to per-token
 * net-flow signals. There is deliberately no auto-discovered "top trader"
 * list: photocopying strangers is how you import their biases and their
 * wash trades. The owner curates wallets they have independent reason to
 * respect (persistent public track records), capped at 20.
 *
 * Live shape (verified 2026-09-29 against /activity):
 *   TRADE rows carry {asset (TOKEN id), side BUY|SELL, price, size,
 *   usdcSize, timestamp (sec), transactionHash}. Everything else
 *   (REDEEM, MAKER_REBATE, …) is skipped. Rows without a token id or a
 *   legible side are skipped, never guessed.
 *
 * The consumer (executeG4Step) uses these signals ONE-WAY only: a strong
 * opposing flow raises the edge floor (contradiction guard). Aligned flow
 * never lowers any bar — photocopied conviction is not edge.
 */

const DATA_ACTIVITY_URL = "https://data-api.polymarket.com/activity";

export interface WalletTrade {
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  sizeShares: number;
  usdcSize: number;
  timestampMs: number;
  txHash: string;
}

export interface TokenFlow {
  tokenId: string;
  /** Signed net flow in USD: buys minus sells. */
  netFlowUsd: number;
  buyUsd: number;
  sellUsd: number;
  /** Distinct watched wallets behind the flow. */
  wallets: number;
  trades: number;
  updatedAtMs: number;
}

function toFinite(n: unknown): number | null {
  const v = typeof n === "string" ? Number(n) : (n as number);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Pure parser: /activity payload -> TRADE rows for one wallet.
 * `wallet` binds proxyWallet (case-insensitive); foreign rows are dropped.
 */
export function parseActivityTrades(
  data: unknown,
  wallet: string,
  nowMs = Date.now(),
): WalletTrade[] {
  if (!Array.isArray(data)) return [];
  const want = wallet.toLowerCase();
  const out: WalletTrade[] = [];
  const seen = new Set<string>();
  for (const r of data) {
    if (typeof r !== "object" || r === null) continue;
    const rec = r as Record<string, unknown>;
    if (rec["type"] !== "TRADE") continue;
    if (
      typeof rec["proxyWallet"] !== "string" ||
      (rec["proxyWallet"] as string).toLowerCase() !== want
    ) {
      continue;
    }
    const tokenId =
      typeof rec["asset"] === "string" ? (rec["asset"] as string) : "";
    const sideRaw =
      typeof rec["side"] === "string"
        ? (rec["side"] as string).toUpperCase()
        : "";
    if (!tokenId || (sideRaw !== "BUY" && sideRaw !== "SELL")) continue;
    const price = toFinite(rec["price"]);
    const sizeShares = toFinite(rec["size"]);
    const usdcSize = toFinite(rec["usdcSize"]);
    const tsSec = toFinite(rec["timestamp"]);
    if (price === null || price <= 0 || price >= 1) continue;
    if (sizeShares === null || sizeShares <= 0) continue;
    if (usdcSize === null || usdcSize < 0) continue;
    if (tsSec === null || tsSec <= 0) continue;
    const txHash =
      typeof rec["transactionHash"] === "string"
        ? (rec["transactionHash"] as string)
        : "";
    if (!txHash || seen.has(txHash)) continue;
    seen.add(txHash);
    out.push({
      tokenId,
      side: sideRaw,
      price,
      sizeShares,
      usdcSize,
      timestampMs: Math.floor(tsSec * 1000),
      txHash,
    });
  }
  void nowMs;
  return out;
}

/**
 * Reduce trades to per-token net flows inside a lookback window.
 * Pure. Stale trades (older than lookbackMs) are excluded, not decayed —
 * a silent wallet must fade to "no signal", never to a stale veto.
 */
export function buildTokenFlows(
  trades: WalletTrade[],
  lookbackMs: number,
  nowMs = Date.now(),
): Map<string, TokenFlow> {
  const flows = new Map<string, TokenFlow>();
  const cutoff = nowMs - Math.max(lookbackMs, 0);
  for (const t of trades) {
    if (t.timestampMs < cutoff) continue;
    let f = flows.get(t.tokenId);
    if (!f) {
      f = {
        tokenId: t.tokenId,
        netFlowUsd: 0,
        buyUsd: 0,
        sellUsd: 0,
        wallets: 0,
        trades: 0,
        updatedAtMs: 0,
      };
      flows.set(t.tokenId, f);
    }
    if (t.side === "BUY") {
      f.buyUsd += t.usdcSize;
      f.netFlowUsd += t.usdcSize;
    } else {
      f.sellUsd += t.usdcSize;
      f.netFlowUsd -= t.usdcSize;
    }
    f.trades += 1;
    f.updatedAtMs = Math.max(f.updatedAtMs, t.timestampMs);
  }
  return flows;
}

/** Parse + validate the owner watchlist (0x addresses, max 20, deduped). */
export function parseWatchlist(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const w = part.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Fetch recent TRADE rows for one wallet. Throws plain Error on failure
 * (sync treats it as a skipped wallet, never a crash).
 */
export async function fetchWalletTrades(
  wallet: string,
  limit = 100,
  timeoutMs = 15_000,
): Promise<WalletTrade[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${DATA_ACTIVITY_URL}?user=${encodeURIComponent(wallet)}&limit=${Math.max(1, Math.min(limit, 500))}`,
      { signal: ctrl.signal },
    );
    if (!res.ok) {
      throw new Error(`Data API HTTP ${res.status}`);
    }
    return parseActivityTrades(await res.json(), wallet);
  } catch (err) {
    throw new Error(
      `wallet activity fetch failed: ${(err as Error).message ?? err}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface SmartMoneySyncDeps {
  wallets: string[];
  lookbackMs?: number;
  intervalMs?: number;
  fetchTrades?: (wallet: string) => Promise<WalletTrade[]>;
  onUpdate?: (tokens: number, wallets: number) => void;
  onError?: (err: Error) => void;
}

export interface SmartMoneySyncHandle {
  stop: () => void;
  /** Fresh flow for a token, or undefined when unknown/stale. */
  getFlow: (tokenId: string) => TokenFlow | undefined;
  tick: () => Promise<void>;
}

/**
 * Background refresh of the watchlist into an in-memory flow cache.
 * Wallet count per token is tracked so the guard can demand corroboration
 * (one wallet selling is an anecdote; three is a signal).
 */
export function startSmartMoneySync(
  deps: SmartMoneySyncDeps,
): SmartMoneySyncHandle {
  const lookbackMs = deps.lookbackMs ?? 24 * 3_600_000;
  const intervalMs = Math.max(deps.intervalMs ?? 15 * 60_000, 30_000);
  const cache = new Map<string, TokenFlow>();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    const perToken = new Map<
      string,
      { trades: WalletTrade[]; wallets: Set<string> }
    >();
    for (const w of deps.wallets) {
      try {
        const trades = deps.fetchTrades
          ? await deps.fetchTrades(w)
          : await fetchWalletTrades(w);
        for (const t of trades) {
          let e = perToken.get(t.tokenId);
          if (!e) {
            e = { trades: [], wallets: new Set<string>() };
            perToken.set(t.tokenId, e);
          }
          e.trades.push(t);
          e.wallets.add(w);
        }
      } catch (err) {
        deps.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
    const now = Date.now();
    cache.clear();
    for (const [tokenId, e] of perToken) {
      const flows = buildTokenFlows(e.trades, lookbackMs, now);
      const f = flows.get(tokenId);
      if (!f) continue;
      // Corroboration demand: one wallet selling is an anecdote.
      f.wallets = e.wallets.size;
      cache.set(tokenId, f);
    }
    deps.onUpdate?.(cache.size, deps.wallets.length);
  };

  // First pass runs soon after boot (5s) so a fresh box learns fast;
  // the steady interval carries it from there.
  const first = setTimeout(() => {
    if (stopped) return;
    void tick();
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
  }, 5_000);

  return {
    stop: () => {
      stopped = true;
      clearTimeout(first);
      if (timer) clearInterval(timer);
    },
    getFlow: (tokenId) => cache.get(tokenId),
    tick,
  };
}
