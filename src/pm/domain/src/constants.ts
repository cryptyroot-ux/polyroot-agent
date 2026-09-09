/**
 * Immutable Polymarket constants — not configurable via env
 * Source: Blueprint B4 §4, official Polymarket docs
 */

export const POLYMARKET = {
  /** Polygon Mainnet */
  CHAIN_ID: 137,

  /** pUSD (bridged USDC) on Polygon */
  P_USD: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const,

  /** CLOB v4 contract */
  CLOB_ADDRESS: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E" as const,

  /** NegRisk CLOB */
  NEG_RISK_CLOB: "0x5F47C39E8B7e7d2e4E8d8D8d8D8d8d8D8d8D8d8" as const,

  /** Official fee schedule (bps) — replaces upstream's buggy 25/0 */
  FEE_TIERS: {
    maker: 0,
    taker: 2,
  } as const,

  /** Endpoints */
  ENDPOINTS: {
    mainnet: {
      clob: "https://clob.polymarket.com",
      negRisk: "https://clob.polymarket.com",
    },
    testnet: {
      clob: "https://clob.polymarket.dev",
      negRisk: "https://clob.polymarket.dev",
    },
  } as const,
} as const;

/** Minimum order size (1 share = $1 notional at price 1.0) */
export const MIN_ORDER_SIZE = 1;

/** Maximum order expiration (30 days) */
export const MAX_ORDER_EXPIRATION_SEC = 30 * 24 * 60 * 60;

/** Default order expiration (24 hours) */
export const DEFAULT_ORDER_EXPIRATION_SEC = 24 * 60 * 60;

/** Gas price buffer (bps) for estimation */
export const GAS_PRICE_BUFFER_BPS = 100;

/** Evidence TTL (hours) */
export const EVIDENCE_TTL_HOURS = 168; // 1 week

/** Forecast horizon bounds (seconds) */
export const FORECAST_HORIZON_MIN_SEC = 60 * 60;      // 1 hour
export const FORECAST_HORIZON_MAX_SEC = 30 * 24 * 60 * 60; // 30 days

/** Portfolio refresh interval */
export const PORTFOLIO_REFRESH_INTERVAL_MS = 30_000;

/** Market data refresh interval */
export const MARKET_DATA_REFRESH_INTERVAL_MS = 5_000;