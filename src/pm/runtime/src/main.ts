/**
 * @polyroot/runtime — Production Agent Entrypoint (Runtime Wiring).
 *
 * Addresses FIND-002: Wires the G4 loop and pipeline end-to-end with
 * PostgreSQL persistence, Polymarket VenueAdapter, SignerVault, and MoneyKernel.
 */

import { Pool } from "pg";
import {
  createPgStores,
  ReservationManager,
  startReservationExpiryJob,
} from "@polyroot/risk";
import { MoneyKernel } from "@polyroot/risk";
import { createHash } from "node:crypto";
import {
  SignerVault,
  deriveAddressFromPrivateKey,
  type CryptoSigner,
} from "@polyroot/signer";
import { PolymarketVenueAdapter } from "@polyroot/venue";
import {
  PgPermitStore,
  PgRecoveryLedger,
  PgLeaseStore,
  PgSeenStore,
  type PermitStore,
  type VenueAdapter,
} from "@polyroot/venue";
import { Executor } from "@polyroot/executor";
import { createG4Pipeline } from "./g4-pipeline.js";
import { DEFAULT_RISK_POLICY, type WalletIdentity } from "@polyroot/domain";
import { Metrics } from "@polyroot/observability";
import { PgLiveGuardStore } from "./live-guard-store.js";
import {
  AUTONOMY_BOUNDS,
  parseBoundsEnv,
} from "./autonomy-bounds.js";
import { readMarketUniverse } from "@polyroot/venue";
import {
  createForecastProviderFromEnv,
  type ForecastProvider,
} from "@polyroot/intelligence";
import type { G4CoreMetrics } from "./g4-core.js";

/**
 * Record a cumulative G4 metrics snapshot into shared Metrics.
 * Totals are set (not incremented) because pipeline snapshots are cumulative.
 */
export function recordG4Metrics(metrics: Metrics, m: G4CoreMetrics): void {
  metrics.setCounter("totalOrders", m.totalOrders);
  metrics.setCounter("filledOrders", m.filledOrders);
  metrics.setCounter("totalPnl", m.totalPnl);
  metrics.setCounter("totalFees", m.totalFees);
  metrics.gauge("maxDrawdown", m.maxDrawdown);
  metrics.gauge("fillRatio", m.fillRatio);
  metrics.gauge("currentExposureUsd", m.currentExposureUsd);
  metrics.gauge("maxExposureUsd", m.maxExposureUsd);
}

/** PAPER/SHADOW placeholder identity (mock venue — never touches real funds). */
const PAPER_WALLET_IDENTITY: WalletIdentity = {
  schema_version: "1.1",
  wallet_id: "00000000-0000-0000-0000-000000000001",
  wallet_type: "DEPOSIT_WALLET",
  signer_address: "0xSIGNER_ADDRESS_1111111111111111",
  account_wallet: "0xACCOUNT_ADDRESS_22222222222222",
  funder: "0xFUNDER_ADDRESS_3333333333333333",
  chain_id: 137,
  verified_at: new Date("2026-01-01T00:00:00.000Z"),
};

/**
 * Deterministic wallet id (UUID-style) derived from the signer address.
 * Stable across restarts so lease fencing and recovery stay consistent
 * for the same wallet.
 */
export function deterministicWalletId(signerAddress: string): string {
  const digest = createHash("sha256")
    .update(`polyroot-wallet-id-v1:${signerAddress.toLowerCase()}`)
    .digest();
  const b6 = digest[6] ?? 0;
  const b8 = digest[8] ?? 0;
  digest[6] = (b6 & 0x0f) | 0x40; // version 4
  digest[8] = (b8 & 0x3f) | 0x80; // variant RFC 4122
  const hex = digest.toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

/**
 * Build the runtime WalletIdentity. Live modes derive the signer address
 * from the user's configured key and require distinct account/funder
 * addresses (WAL-03); PAPER/SHADOW keep the mock placeholder.
 */
export function buildWalletIdentity(
  mode: "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE",
  env: NodeJS.ProcessEnv = process.env,
): WalletIdentity {
  if (mode === "PAPER" || mode === "SHADOW")
    return { ...PAPER_WALLET_IDENTITY };
  const rawKey = env["PRIVATE_KEY_HEX"] ?? env["WALLET_PRIVATE_KEY"] ?? "";
  const signerAddress = deriveAddressFromPrivateKey(rawKey);
  const account = env["WALLET_ACCOUNT"] ?? "";
  const funder = env["WALLET_FUNDER"] ?? "";
  if (!account || !funder) {
    throw new Error(
      "LIVE_WALLET_MISSING: WALLET_ACCOUNT and WALLET_FUNDER are required for MICRO_LIVE/LIVE",
    );
  }
  const lower = (a: string): string => a.toLowerCase();
  if (
    lower(account) === lower(signerAddress) ||
    lower(funder) === lower(signerAddress) ||
    lower(account) === lower(funder)
  ) {
    throw new Error(
      "LIVE_WALLET_INVALID: signer, account and funder must be three distinct addresses (WAL-03)",
    );
  }
  return {
    schema_version: "1.1",
    wallet_id: deterministicWalletId(signerAddress),
    wallet_type: "DEPOSIT_WALLET",
    signer_address: signerAddress,
    account_wallet: account,
    funder,
    chain_id: 137,
    verified_at: new Date(),
  };
}

export interface BootstrapAgentOptions {
  /**
   * Production signer (KMS, HSM, or encrypted keystore). REQUIRED for MICRO_LIVE/LIVE.
   * When omitted, a PAPER/SHADOW-only placeholder signer is used that
   * rejects unhashed requests and must never touch real funds.
   */
  cryptoSigner?: CryptoSigner;
  /**
   * Real venue adapter. REQUIRED for MICRO_LIVE/LIVE.
   * When omitted, a mock venue adapter is used (PAPER/SHADOW-only).
   */
  venueAdapter?: VenueAdapter;
}

export async function bootstrapAgent(
  connectionString: string,
  mode: "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE" = "PAPER",
  opts: BootstrapAgentOptions = {},
) {
  const pool = new Pool({ connectionString });
  pool.on("error", (err: unknown) => {
    console.error("PG pool idle client error:", err);
  });

  // 1. Initialize PostgreSQL-backed persistence stores on ONE shared pool.
  // Passing { pool } avoids a second internal pool that would leak on shutdown.
  const stores = createPgStores({ pool });

  // 2. Initialize Money Kernel with authoritative PG persistence
  // FIND-003 remediation: authority is now REQUIRED - no non-authoritative fallback
  const kernel = new MoneyKernel({
    balance: stores.balanceStore,
    sink: stores.eventSink,
    authority: stores.authority,
    chainId: 137,
    mode,
  });

  // Fail-closed LIVE guard: placeholder signer + mock venue are PAPER/SHADOW-only.
  // MICRO_LIVE/LIVE require explicitly injected production dependencies.
  const isLive = mode === "MICRO_LIVE" || mode === "LIVE";
  if (isLive && (!opts.cryptoSigner || !opts.venueAdapter)) {
    await pool.end().catch(() => undefined);
    throw new Error(
      "REFUSE_LIVE_WITH_STUBS: MICRO_LIVE/LIVE requires explicit cryptoSigner (keystore/KMS/HSM) " +
        "and venueAdapter; the placeholder signer and mock venue are PAPER/SHADOW-only",
    );
  }

  // 3. Initialize SignerVault with a secure production signer (placeholder for KMS/HSM)
  // FIND-001 remediation: enforce actual cryptographic signing or HSM check
  const signer = new SignerVault({
    expectedChainId: 137,
    cryptoSigner:
      opts.cryptoSigner ??
      (async (req) => {
        // In production, this MUST invoke an HSM, AWS KMS, or Vault service.
        // For runtime wiring demonstration, we ensure strict payload verification.
        if (!req.payloadHash) {
          throw new Error("REJECT_UNHASHED_SIGNING_REQUEST");
        }
        return `0x_prod_sig_${req.actionId}`;
      }),
  });

  // 4. Initialize Venue Adapter with Polymarket SDK client wrapper
  const mockSdkClient = {
    fetchOrderBook: async () => ({
      bids: [],
      asks: [],
      market: { question: "Production Book", status: "ACTIVE" },
    }),
    postOrder: async () => ({ success: true, orderID: "ord_" + Date.now() }),
    cancelOrder: async () => ({ success: true }),
    fetchOrder: async () => ({ status: "LIVE" }),
  };
  const venueAdapter: VenueAdapter =
    opts.venueAdapter ?? new PolymarketVenueAdapter(mockSdkClient, "NORMAL");

  // 5. Initialize Executor with recovery ledger and lease store
  const permitStore: PermitStore = new PgPermitStore(pool);
  const recoveryLedger = new PgRecoveryLedger(pool);
  const leaseStore = new PgLeaseStore(pool);

  // 5b. Reservation expiry: stranded ACTIVE reservations (e.g. after a
  // crash between permit issue and consume/release) are terminally expired
  // back to available funds every 30s. Fail-closed: expiry errors are logged,
  // never thrown into the pipeline.
  const reservationManager = new ReservationManager({
    balanceStore: stores.balanceStore,
    permitStore,
    pool,
  });
  const stopReservationExpiry = startReservationExpiryJob({
    reservations: reservationManager,
  });

  // Restart idempotency: the seen log is hydrated from durable storage by
  // hydrateSeen() BEFORE the pipeline accepts new intents, so a restart can
  // never re-submit a known order. Sync mirror keeps the executor hot path
  // allocation-free. Hydration is deliberately NOT eager here: bootstrapAgent
  // must validate config guards without touching the network (see
  // runtime-live-guard tests). The startup entry (startAgent) awaits
  // hydrateSeen() before running the pipeline. Live modes fail closed when
  // the DB is unreachable; PAPER/SHADOW (zero financial I/O) warn and
  // continue with an empty mirror.
  const seenStore = new PgSeenStore(pool);
  const hydrateSeen = async (): Promise<void> => {
    try {
      await seenStore.hydrate(await recoveryLedger.getUnresolved());
    } catch (err) {
      if (isLive) {
        await pool.end().catch(() => undefined);
        throw new Error(
          `SEEN_HYDRATE_FAILED: cannot load durable seen_orders for ${mode}: ${(err as Error).message}`,
        );
      }
      console.warn(
        `[seen] hydrate skipped (non-live): ${(err as Error).message}`,
      );
    }
  };
  const executor = new Executor({
    adapter: venueAdapter,
    now: () => new Date(),
    seen: {
      has: (id) => seenStore.has(id),
      add: (id, st) => {
        seenStore.set(id, st);
        void seenStore
          .flush()
          .catch((err: unknown) =>
            console.error("[seen] persist failed:", (err as Error).message),
          );
      },
      get: (id) => seenStore.get(id),
    },
    permitStore,
    recoveryLedger,
    leaseEpoch: 1,
    walletId: "00000000-0000-0000-0000-000000000001",
    holder: "prod-runtime-node-1",
    leaseStore,
    // Authoritative settlement accounting: consume on fill, release on
    // reject/cancel. Without this, committed funds strand forever.
    reservationManager,
  });

  // 6. Wallet Identity: derived from the user's key on live modes,
  // mock placeholder on PAPER/SHADOW (WAL-03 distinctness enforced).
  const wallet: WalletIdentity = buildWalletIdentity(mode);

  // 7. Forecast provider from env (null = abstain, never a stub value).
  const forecastProvider: ForecastProvider | null =
    createForecastProviderFromEnv();
  let warnedNoProvider = false;

  // 8. Market universe (fail-closed outside PAPER): the loop iterates
  // exactly these owner-curated CLOB token ids — never mock data.
  const marketUniverse =
    mode === "PAPER" ? [] : readMarketUniverse(process.env);
  const marketSource =
    marketUniverse.length === 0
      ? undefined
      : {
          universe: () => marketUniverse,
          snapshot: async (marketId: string) => {
            const snap = await venueAdapter.getOrderBook(marketId);
            if (snap.yes_price === undefined || snap.no_price === undefined) {
              return null;
            }
            return { bid: snap.yes_price, ask: snap.no_price };
          },
        };

  // 9. Shared metrics + G4 Pipeline (observability wired to Metrics).
  const metrics = new Metrics();

  // Live enforcement inputs (fail-closed): an explicit owner loss cap is
  // REQUIRED in live modes; the exposure cap defaults to the approved
  // AUTONOMY_BOUNDS.CAPITAL_CAP_USD and can only be changed by the owner
  // via `polyroot setup` (never by the AI path).
  const isLiveMode = mode === "MICRO_LIVE" || mode === "LIVE";
  const bounds = parseBoundsEnv(process.env);
  const liveLossCapPusd = bounds.lossCapPusd;
  if (isLiveMode && liveLossCapPusd === undefined) {
    await pool.end().catch(() => undefined);
    throw new Error(
      "LIVE_LOSS_CAP_UNCONFIGURED: POLYROOT_MICRO_LIVE_LOSS_CAP_USD must be a positive number for MICRO_LIVE/LIVE",
    );
  }
  if (
    process.env["POLYROOT_MICRO_LIVE_CAP_USD"] !== undefined &&
    bounds.capUsd === undefined
  ) {
    await pool.end().catch(() => undefined);
    throw new Error(
      "LIVE_CAP_INVALID: POLYROOT_MICRO_LIVE_CAP_USD must be a positive number when set",
    );
  }
  const microLiveCapUsd =
    bounds.capUsd ?? (isLiveMode ? AUTONOMY_BOUNDS.CAPITAL_CAP_USD : undefined);
  const liveGuardStore = new PgLiveGuardStore(pool);
  const pipeline = createG4Pipeline({
    config: {
      mode,
      minEdgeAfterCost: 0.03,
      ...(microLiveCapUsd !== undefined ? { microLiveCapUsd } : {}),
      ...(liveLossCapPusd !== undefined ? { liveLossCapPusd } : {}),
    },
    observability: {
      emitMetrics: (m) => recordG4Metrics(metrics, m),
    },
    kernel,
    signer,
    executor,
    wallet,
    policy: {
      ...DEFAULT_RISK_POLICY,
      capital_usd_cap: 10000, // Commissioned capital basis
    },
    policyHash: "ph_prod_audited_137",
    venueMode: () => venueAdapter.mode,
    leaseEpoch: () => 1,
    now: () => new Date(),
    ...(marketSource ? { marketSource } : {}),
    liveGuard: {
      loadLatch: () => liveGuardStore.load(),
      saveLatch: (s) => liveGuardStore.save(s),
      // Session realized loss from shared metrics. The latch itself is
      // DB-persisted, so a restart can never clear an engaged breach —
      // at worst a fresh session re-detects it from new activity.
      realizedLossPusd: () =>
        Math.max(0, -(metrics.getCounter("totalPnl") ?? 0)),
    },
    forecast: async (market) => {
      if (!forecastProvider) {
        if (!warnedNoProvider) {
          warnedNoProvider = true;
          console.warn(
            "POLYROOT_FORECAST_PROVIDER unset — forecasting abstains (NO_TRADE). " +
              "Set POLYROOT_FORECAST_PROVIDER=openai with OPENAI_API_KEY + POLYROOT_FORECAST_MODEL to enable.",
          );
        }
        return null;
      }
      try {
        return await forecastProvider.forecast(market);
      } catch {
        return null;
      }
    },
    sizeIntent: () => 100, // Example size in shares
  });

  return {
    pool,
    kernel,
    signer,
    executor,
    pipeline,
    metrics,
    reservationManager,
    stopReservationExpiry,
    seenStore,
    hydrateSeen,
  };
}
