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
import { ModeWatcher } from "./mode-watcher.js";
import { DEFAULT_RISK_POLICY, type WalletIdentity } from "@polyroot/domain";
import { Metrics } from "@polyroot/observability";
import {
  getTelegramEmitter,
  type TelegramStreamEmitter,
  type AgentStreamEventType,
} from "@polyroot/observability";
import { PgLiveGuardStore } from "./live-guard-store.js";
import { PgResolvedClusters } from "./postgres-log.js";
import { createStepPersistence } from "./observability/index.js";
import { AUTONOMY_BOUNDS, parseBoundsEnv } from "./autonomy-bounds.js";
import {
  resolveMarketUniverseWithSides,
  parseWatchlist,
  startSmartMoneySync,
  type MarketSide,
  type MarketUniverseWithSides,
} from "@polyroot/venue";
import {
  createForecastProviderFromEnv,
  type ForecastProvider,
} from "@polyroot/intelligence";
import { kellyShares, equityBankroll } from "@polyroot/strategy";
import { PgCalibrationService } from "@polyroot/intelligence";
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
  /**
   * Telegram agent-stream switch. Default true; the CLI sets it false for
   * `--once` / test runs so dry runs never spam the owner's DM with mock
   * markets. The continuous service always streams.
   */
  streamEnabled?: boolean;
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
  // Latest stated reasoning per market, for live display + DB lineage.
  // Best-effort only: missing rationale never blocks or alters decisions.
  const lastReasoning = new Map<
    string,
    { rationale: string | null; factors: string[]; model: string }
  >();
  let warnedNoProvider = false;
  if (forecastProvider) {
    const model = process.env["POLYROOT_FORECAST_MODEL"] ?? "unknown";
    let host = "api.openai.com";
    try {
      host = new URL(process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com")
        .host;
    } catch {
      // keep default host label
    }
    console.log(`🤖 AI forecaster: ${model} via ${host}`);
  }

  // 8. Market universe (fail-closed outside PAPER). Manual mode iterates
  // exactly the owner-curated CLOB token ids; auto mode lets the agent
  // discover the most liquid markets itself within owner guardrails —
  // never mock data either way.
  const { ids: marketUniverse, sides: marketSides }: MarketUniverseWithSides =
    mode === "PAPER"
      ? { ids: [], sides: {} }
      : await resolveMarketUniverseWithSides(process.env);
  const marketMeta = new Map<string, { question: string; volume24h: number }>();
  // Display-only enrichment (skipped for empty universes such as PAPER):
  // an empty map just means nameless lines, never a boot failure.
  if (marketUniverse.length > 0) {
    try {
      const { fetchActiveMarkets } = await import("@polyroot/venue");
      const discovered = await fetchActiveMarkets(50, 15_000);
      for (const d of discovered) {
        if (d.yesTokenId)
          marketMeta.set(d.yesTokenId, {
            question: d.question,
            volume24h: d.volume24h,
          });
        if (d.noTokenId)
          marketMeta.set(d.noTokenId, {
            question: d.question,
            volume24h: d.volume24h,
          });
      }
    } catch {
      // display-only enrichment; an empty map just means nameless lines
    }
  }
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
            const side: MarketSide = marketSides[marketId] ?? "UNKNOWN";
            const meta = marketMeta.get(marketId);
            const q =
              typeof snap.question === "string" && snap.question.length > 0
                ? snap.question
                : meta?.question;
            return {
              bid: snap.yes_price,
              ask: snap.no_price,
              side,
              ...(q ? { question: q } : {}),
              ...(meta && Number.isFinite(meta.volume24h)
                ? { volume24h: meta.volume24h }
                : {}),
            };
          },
        };

  // 9. Shared metrics + G4 Pipeline (observability wired to Metrics).
  const metrics = new Metrics();

  // Operator display funds: sim bankroll from the ledger + locked
  // reservations (in-flight intents, auto-released) + live session PnL
  // from the shared metrics. Best-effort: null bankroll hides that line.
  const toUsd = (raw: unknown): number | null => {
    const n =
      typeof raw === "string"
        ? Number(raw)
        : typeof raw === "number"
          ? raw
          : NaN;
    return Number.isFinite(n) ? Math.round((n / 1e6) * 100) / 100 : null;
  };
  const getFunds = async (): Promise<{
    bankrollUsd: number | null;
    lockedUsd: number | undefined;
    sessionPnlUsd: number;
  }> => {
    let bankrollUsd: number | null = null;
    let lockedUsd: number | undefined = undefined;
    try {
      const r = await pool.query(
        `SELECT available_base, committed_base FROM balance_entries
          WHERE account = $1 AND asset = 'pUSD' LIMIT 1`,
        [wallet.funder],
      );
      bankrollUsd = toUsd(r.rows[0]?.["available_base"]);
      lockedUsd = toUsd(r.rows[0]?.["committed_base"]) ?? undefined;
    } catch {
      // display-only: stay null
    }
    return {
      bankrollUsd,
      lockedUsd,
      sessionPnlUsd: metrics.getCounter("totalPnl"),
    };
  };

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
  // Settlement feed for the portfolio tracker: recently resolved token
  // ids, so filled positions free their notional back. Fail-open inside.
  const resolvedClusters = new PgResolvedClusters(pool);
  // Owner wall for per-pass breadth (default MAX_CONCURRENT_ORDERS = 3):
  // the agent ranks and defers within it, never above it.
  const maxConcurrentRaw = Number(
    process.env["POLYROOT_MAX_CONCURRENT_ORDERS"],
  );
  const maxConcurrentMarkets =
    Number.isFinite(maxConcurrentRaw) && maxConcurrentRaw > 0
      ? Math.floor(maxConcurrentRaw)
      : AUTONOMY_BOUNDS.MAX_CONCURRENT_ORDERS;
  // Learned correction service: identity until the resolution sync trains
  // real maps (fail-open by construction — see calibrate()).
  const calibrationService = new PgCalibrationService(pool);
  // DB-backed hot-reload: `polyroot mode X` takes effect in the running
  // loop within one pass (no restart). Fail-closed on DB loss (READ_ONLY),
  // latch-guarded upgrades to live modes. Owned by the pipeline lifecycle:
  // started on runContinuous, stopped on pipeline.stop().
  const modeWatcher = new ModeWatcher({
    pool,
    initialMode: mode,
    onModeChange: (from, to, reason) =>
      console.log(`🔄 ModeWatcher: ${from} -> ${to} (${reason})`),
    onDegrade: (reason) => console.log(`⛔ ModeWatcher degraded: ${reason}`),
  });
  // Owner-curated smart-money watchlist (empty = disabled). Flow cache
  // feeds the contradiction guard only; a dead feed changes nothing.
  const smartWallets = parseWatchlist(process.env["POLYROOT_SMART_WALLETS"]);
  const smartMoneySync =
    smartWallets.length > 0
      ? startSmartMoneySync({
          wallets: smartWallets,
          onUpdate: (tokens, wallets) =>
            console.log(
              `🐋 Smart-money watch: ${tokens} tokens across ${wallets} wallets`,
            ),
          onError: (e) =>
            console.log(`⚠️  Smart-money sync skipped: ${e.message}`),
        })
      : null;
  // 9b. Telegram agent stream (PM-OBS-01): the same observability fan-out
  // that feeds Metrics also pushes the agent's live reasoning to Telegram.
  // Fire-and-forget by construction — a slow or failing Bot API never blocks
  // the trading loop. Disabled unless TELEGRAM_BOT_TOKEN is present.
  // Hooks are composed explicitly (never spread): persistence and metrics
  // keep running even if streaming is disabled or throws.
  const stepPersistence = createStepPersistence({
    pool,
    mode,
    model: process.env["POLYROOT_FORECAST_MODEL"],
    baseMinEdge: 0.03,
    getReasoning: (marketId: string) => lastReasoning.get(marketId),
  });
  const telegramStream: TelegramStreamEmitter = getTelegramEmitter();
  // `--once` and other dry runs stay silent: only the continuous loop may
  // push to the owner's DM (a mock_market_1 test ping is spam, not signal).
  const streamOn = opts.streamEnabled !== false && telegramStream.isEnabled();
  const emitStream = (
    type: AgentStreamEventType,
    message: string,
    marketId?: string,
    metadata?: Record<string, unknown>,
  ): void => {
    if (!streamOn) return;
    void telegramStream
      .emit({
        eventId: `${type.toLowerCase()}-${Date.now()}`,
        timestamp: new Date(),
        type,
        ...(marketId ? { marketId } : {}),
        message,
        ...(metadata ? { metadata } : {}),
      })
      .catch(() => false);
  };
  if (streamOn) {
    console.log("[telegram] agent stream ON");
  }
  const safeObserve = (fn: () => unknown): void => {
    try {
      const r = fn() as unknown;
      if (r instanceof Promise) r.catch(() => undefined);
    } catch {
      // observer failure is never a trading failure
    }
  };
  const pipeline = createG4Pipeline({
    config: {
      mode,
      minEdgeAfterCost: 0.03,
      maxConcurrentMarkets,
      ...(microLiveCapUsd !== undefined ? { microLiveCapUsd } : {}),
      ...(liveLossCapPusd !== undefined ? { liveLossCapPusd } : {}),
    },
    observability: {
      emitMetrics: (m) => {
        safeObserve(() => recordG4Metrics(metrics, m));
      },
      emitStepComplete: (input, result) => {
        safeObserve(() => stepPersistence.emitStepComplete(input, result));
        const isExecuted =
          result.decision !== "NO_TRADE" && result.fill?.status === "FILLED";
        const eventType = isExecuted
          ? "ORDER_FILL"
          : result.decision === "NO_TRADE"
            ? "NO_TRADE"
            : "ORDER_SUBMIT";
        emitStream(
          eventType,
          isExecuted
            ? `✅ Eksekusi Berhasil: Order terisi penuh di market.`
            : `⚠️ Selesai dengan status [${result.decision}]. Alasan: ${result.reason ?? "Tidak ada keterangan"}`,
          input.market_id,
          {
            decision: result.decision,
            reason: result.reason,
            fillStatus: result.fill?.status,
            fillPrice: result.fill?.fillPrice,
            filledSize: result.fill?.filledSize,
            edge: result.edge,
          },
        );
      },
      emitFinancialGate: (gate, gateMode, venue) =>
        emitStream(
          "RISK_GATE",
          `Risk Gate Evaluasi: [${gate}] (Mode: ${gateMode}, Venue: ${venue})`,
        ),
      emitError: (error, context) =>
        emitStream(
          "ERROR",
          `Error terdeteksi di Agent Loop: ${error.message}`,
          undefined,
          {
            context: String(context),
          },
        ),
      emitModeTransition: (from, to, reason) =>
        emitStream(
          "RESEARCH_INGEST",
          `Mode Transition: ${from} ➡️ ${to} | Alasan: ${reason}`,
        ),
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
    modeWatcher,
    listSettledTokens: async () => {
      try {
        const rows = await resolvedClusters.listRecent(100);
        const out: string[] = [];
        for (const r of rows) {
          for (const id of r.marketIds ?? []) {
            if (typeof id === "string" && id) out.push(id);
          }
        }
        return out;
      } catch {
        return [];
      }
    },
    ...(smartMoneySync
      ? {
          getSmartMoneyFlow: (tokenId: string) =>
            smartMoneySync.getFlow(tokenId) ?? undefined,
        }
      : {}),
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
    getReasoning: (marketId: string) => lastReasoning.get(marketId),
    getFunds,
    // Real per-pass universe report: scanned (priced) → selected for
    // evaluation → deferred. This is the only UNIVERSE_SCAN the owner
    // ever sees — real counts, never a placeholder line.
    onUniversePass: (s) =>
      emitStream(
        "UNIVERSE_SCAN",
        `Pass [Mode: ${s.mode}]: ${s.scanned} market berlikuiditas dipindai → ${s.selected} dievaluasi, ${s.deferred} ditunda`,
        undefined,
        {
          scanned: s.scanned,
          selected: s.selected,
          deferred: s.deferred,
          mode: s.mode,
        },
      ),
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
        // Prefer the rich reply so the operator sees the AI's stated
        // reasoning live; fall back to p-only on legacy providers.
        // Display-only: the returned p drives the identical decision path.
        if (typeof forecastProvider.forecastDetailed === "function") {
          const detailed = await forecastProvider.forecastDetailed(market);
          const model = process.env["POLYROOT_FORECAST_MODEL"] ?? "unknown";
          lastReasoning.set(market.market_id, {
            rationale: detailed.rationale,
            factors: detailed.factors,
            model,
          });
          // No console output here: the per-market display block (pipeline)
          // renders the rationale right below with book + verdict context.
          if (detailed.p === null) return null;
          // Learned correction, fail-open: no trained map = identity, so
          // behavior is byte-identical until resolutions teach it otherwise.
          try {
            const cal = await calibrationService.calibrate({
              p_raw: detailed.p,
              model,
              category: "general",
              horizon_sec: 3600,
            });
            return cal.p_calibrated;
          } catch {
            return detailed.p;
          }
        }
        return await forecastProvider.forecast(market);
      } catch {
        return null;
      }
    },
    // Fractional-Quarter-Kelly sizing on the touch price, hard-capped at the
    // legacy fixed size: entries can only shrink vs the old behavior, never
    // grow. Bankroll is LIVE EQUITY (owner cap + realized session P&L,
    // floored at zero) — the agent compounds wins and shrinks on losses
    // without owner input; a blown account sizes everything to zero.
    sizeIntent: ({ ask }, p) =>
      kellyShares({
        p,
        price: ask,
        bankrollUsd: equityBankroll(
          microLiveCapUsd ?? AUTONOMY_BOUNDS.CAPITAL_CAP_USD,
          metrics.getCounter("totalPnl") ?? 0,
        ),
        fraction: 0.25,
        minShares: 1,
        maxShares: 100,
      }),
  });

  return {
    pool,
    kernel,
    signer,
    executor,
    pipeline,
    modeWatcher,
    smartMoneySync,
    metrics,
    reservationManager,
    stopReservationExpiry,
    seenStore,
    hydrateSeen,
  };
}
