/**
 * PolyRoot chain/runtime constants — v1.1
 *
 * Version-sensitive rule (Blueprint B18): every SDK name, wallet type,
 * endpoint, fee/rebate schedule, contract address, rate limit and venue
 * behavior is a research baseline, not an eternal constant. Contract
 * addresses, fee tables and wallet support are loaded from the
 * versioned asset/contract registry (PostgreSQL) and revalidated by
 * read-only contract checks at G0 — they are NOT hardcoded here.
 */

export const POLYMARKET = {
  /** Polygon Mainnet — venue chain for v1 LIVE (PR-GOV-02). */
  CHAIN_ID: 137,

  /**
   * pUSD is the trading collateral (6 decimals on Polygon, USDC-backed).
   * The exact token contract is resolved via the asset registry at
   * runtime; no address is pinned in source.
   */
  COLLATERAL_SYMBOL: "pUSD",
  COLLATERAL_DECIMALS: 6,

  /**
   * Documented maker/taker baseline from the research cut. The live fee
   * schedule is category/market dependent and must be read from versioned
   * venue metadata (PR-DATA-04); pre-trade EV assumes no rebate unless
   * the registry proves eligibility (Blueprint B9.1).
   */
  FEE_BASELINE_BPS: {
    maker: 0,
    taker: 2,
  } as const,

  /** Official documentation endpoints (informational, not trading). */
  DOCS: {
    trading_overview: "https://docs.polymarket.com/trading/overview",
    quickstart: "https://docs.polymarket.com/trading/quickstart",
    wallets_auth: "https://docs.polymarket.com/trading/wallets-auth",
    v2_migration: "https://docs.polymarket.com/v2-migration",
    ts_sdk: "https://github.com/Polymarket/ts-sdk",
  } as const,
} as const;

/** Official SDK baseline observed at research cut; exact deploy version/digest frozen at G0. */
export const SDK_BASELINE = {
  package: "@polymarket/client",
  observed_version: "0.9.0",
  node_engine: ">=24.0.0",
} as const;

/** Pinned upstream fork baseline (PR-GOV-01). */
export const UPSTREAM_BASELINE = {
  repo: "alsk1992/CloddsBot",
  commit: "715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8",
  version: "1.9.0",
  license: "MIT",
} as const;

/** Minimum order size (1 share unit). */
export const MIN_ORDER_SIZE = 1;

/** Maximum order expiration (30 days). */
export const MAX_ORDER_EXPIRATION_SEC = 30 * 24 * 60 * 60;

/** Default order expiration (24 hours). */
export const DEFAULT_ORDER_EXPIRATION_SEC = 24 * 60 * 60;

/** Forecast horizon bounds (seconds). */
export const FORECAST_HORIZON_MIN_SEC = 60 * 60;
export const FORECAST_HORIZON_MAX_SEC = 30 * 24 * 60 * 60;

/** Financial audit retention floor (PRD P8). */
export const FINANCIAL_RETENTION_DAYS = 365;

/** Backup RPO/RTO planning targets (PRD P8); proven by restore drill. */
export const BACKUP_RPO_MINUTES = 15;
export const BACKUP_RTO_MINUTES = 60;

/** Initial VPS capacity planning baseline (Blueprint B14). */
export const VPS_BASELINE = {
  vcpu: 4,
  ram_gib: 8,
  free_ssd_gib: 40,
} as const;
