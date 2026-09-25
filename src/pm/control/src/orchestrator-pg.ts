/**
 * @polyroot/control-pg — PostgreSQL-wired Orchestrator factory.
 *
 * Wires the canonical pipeline (EDGE → RISK → BUILD → SUBMIT) with
 * PostgreSQL-backed persistence for the Money Kernel and the Control plane.
 *
 *   kernel    = MoneyKernel(PgBalanceStore, PgKernelEventSink)
 *   persistence = PgPersistence (recovery_ledger)
 *   reconciler  = PgReconciler(executor, pg)
 *   supervisor  = PgSupervisor(reconciler, pg, policy)
 *   signer      = provided by caller (SignerVault with injected CryptoSigner)
 *   venue       = VenueAdapter provided by caller
 */

import { Pool, type PoolConfig } from "pg";
import type {
  ExecutionPermit,
  Forecast,
  MarketSnapshot,
  OrderResult,
  RiskPolicy,
  TradeIntent,
  VenueMode,
  WalletIdentity,
} from "@polyroot/domain";
import type { SignerVault } from "@polyroot/signer";
import type {
  PgPersistence,
  ReconcilerLike,
  SupervisorLike,
} from "./persistence-pg.js";
import { createPgStores, MoneyKernel } from "@polyroot/risk";
import { createPgControlStores } from "@polyroot/control";
import { Executor } from "@polyroot/executor";
import type { VenueAdapter } from "@polyroot/venue";
import { evaluateEdge } from "./signal.js";
import { validateAndReserve } from "./risk-gate.js";
import { buildSignedOrder } from "./order-builder.js";

export interface OrchestratorPgDeps {
  /** Wallet whose funds are reserved. */
  wallet: WalletIdentity;
  /** Current risk policy. */
  policy: RiskPolicy;
  policyHash: string;
  /** Venue adapter for the live venue (or mock for PAPER). */
  venue: VenueAdapter;
  /** Signer vault already wired with the real/mock CryptoSigner. */
  signer: SignerVault;
  /** Venue mode observed immediately before each stage. */
  venueMode: () => VenueMode;
  leaseEpoch: () => number;
  now: () => Date;
  /** PostgreSQL connection (string or PoolConfig). */
  pgConfig: PoolConfig | string;
  /**
   * Shared pool. When provided, EVERY store reuses it (single-pool invariant:
   * no hidden second pool, no pool exhaustion). When omitted, the factory
   * creates exactly one pool and owns it (ended on shutdown).
   */
  pool?: Pool;
}

export interface OrchestrateInput {
  forecast: Forecast;
  book: MarketSnapshot;
  intent: TradeIntent;
  currentMarketExposureUsd?: number;
  currentPortfolioExposureUsd?: number;
}

export type OrchestrateStage = "EDGE" | "RISK" | "BUILD" | "SUBMIT";

export type OrchestrateOutcome =
  | {
      ok: true;
      outcome: "SUBMITTED" | "NEEDS_RECONCILIATION";
      state: import("@polyroot/executor").OrderLifecycleState;
      order: OrderResult | { order_id: string };
      permit: ExecutionPermit;
    }
  | {
      ok: false;
      stage: "EDGE" | "RISK" | "BUILD" | "SUBMIT";
      code: string;
      reason: string;
    };

export interface WiredOrchestrator {
  orchestrate: (input: OrchestrateInput) => Promise<OrchestrateOutcome>;
  supervisor: SupervisorLike;
  reconciler: ReconcilerLike;
  kernel: MoneyKernel;
  persistence: PgPersistence;
  shutdown: () => Promise<void>;
}

export async function createOrchestratorPg(
  deps: OrchestratorPgDeps,
): Promise<WiredOrchestrator> {
  // ── ONE shared pool for every store (R5). Never open a second pool
  // silently: pool exhaustion under load is a liveness risk.
  const ownsPool = deps.pool === undefined;
  const sharedPool =
    deps.pool ??
    new Pool(
      typeof deps.pgConfig === "string"
        ? { connectionString: deps.pgConfig }
        : deps.pgConfig,
    );

  // ── PostgreSQL-backed Money Kernel ports ──────────────────────────────────
  const {
    balanceStore,
    eventSink,
    authority,
  }: {
    balanceStore: import("@polyroot/risk").BalanceStore;
    eventSink: import("@polyroot/risk").KernelEventSink;
    authority: import("@polyroot/risk").MoneyAuthority;
  } = createPgStores({ pool: sharedPool });

  // The atomic PgMoneyAuthority is the ONLY financial authority in production.
  // Passing it to the kernel eliminates the non-atomic fallback path
  // (balance.reserveFunds + sink.push) entirely.
  const kernel = new MoneyKernel({
    balance: balanceStore,
    sink: eventSink,
    chainId: 137,
    authority,
    mode: "LIVE",
  });

  // ── PostgreSQL-backed Permit Store & Recovery Ledger (shared pool) ──────
  const permitStore = new (await import("@polyroot/venue")).PgPermitStore(
    sharedPool,
  );
  const recoveryLedger = new (await import("@polyroot/venue")).PgRecoveryLedger(
    sharedPool,
  );

  // ── PostgreSQL-backed Executor Lease Store (epoch fencing, PR-OPS-02) ─────
  const leaseStore = new (await import("@polyroot/venue")).PgLeaseStore(
    sharedPool,
  );

  // ── Durable seen log (DB-backed, R2): hydrate BEFORE accepting intents ────
  const { PgSeenStore } = await import("@polyroot/venue");
  const seenStore = new PgSeenStore(sharedPool);
  await seenStore.hydrate(await recoveryLedger.getUnresolved());

  const executor = new Executor({
    adapter: deps.venue,
    now: deps.now,
    seen: {
      has: (orderId: string) => seenStore.has(orderId),
      add: (
        orderId: string,
        state: import("@polyroot/executor").OrderLifecycleState,
      ) => {
        seenStore.set(orderId, state);
        void seenStore
          .flush()
          .catch((err: unknown) =>
            console.error("[seen] persist failed:", (err as Error).message),
          );
      },
      get: (orderId: string) => seenStore.get(orderId),
    },
    permitStore,
    recoveryLedger,
    leaseStore,
    walletId: deps.wallet.wallet_id,
    holder: deps.wallet.signer_address,
    leaseEpoch: deps.leaseEpoch(),
  });

  // ── PostgreSQL-backed Control plane ports (with executor for reconciler) ──
  const stores = createPgControlStores(sharedPool, executor, deps.policy);
  const persistence = stores.persistence;
  const reconciler = stores.reconciler;
  const supervisor = stores.supervisor;

  // Start periodic reconciliation (PR-AUT-03, PR-OPS-05)
  const stopReconciliation = supervisor.startPeriodicReconciliation();

  // ── Orchestration pipeline ────────────────────────────────────────────────
  async function orchestrate(
    input: OrchestrateInput,
  ): Promise<OrchestrateOutcome> {
    const now = deps.now();
    const venueMode = deps.venueMode();

    // Stage EDGE: is there a tradeable edge at all?
    const edge = evaluateEdge(
      { forecast: input.forecast, book: input.book },
      { minEdge: deps.policy.min_edge_after_cost },
    );
    if (edge.action !== "TRADE") {
      return {
        ok: false,
        stage: "EDGE",
        code: "MIN_EDGE_UNMET",
        reason: `edge ${Math.round(edge.edge * 10000)} bps < ${deps.policy.min_edge_after_cost * 10000} bps`,
      };
    }

    // Stage RISK: validate & reserve
    const riskInput: import("@polyroot/control").RiskGateInput = {
      intent: input.intent,
      policy: deps.policy,
      wallet: deps.wallet,
      venueMode,
      leaseEpoch: deps.leaseEpoch(),
      now,
      policyHash: deps.policyHash,
      ...(input.currentMarketExposureUsd !== undefined
        ? { currentMarketExposureUsd: input.currentMarketExposureUsd }
        : {}),
      ...(input.currentPortfolioExposureUsd !== undefined
        ? { currentPortfolioExposureUsd: input.currentPortfolioExposureUsd }
        : {}),
    };
    const riskRes = await validateAndReserve(riskInput, kernel);
    if (!riskRes.ok) {
      return {
        ok: false,
        stage: "RISK",
        code: riskRes.code,
        reason: riskRes.reason,
      };
    }

    // Stage BUILD: sign order
    const buildRes = await buildSignedOrder(
      {
        intent: input.intent,
        permit: riskRes.permit,
        wallet: deps.wallet,
        venueMode,
        now,
      },
      deps.signer,
    );
    if (!buildRes.ok) {
      return {
        ok: false,
        stage: "BUILD",
        code: buildRes.code,
        reason: buildRes.reason,
      };
    }
    const { order, permit } = buildRes;

    // Stage SUBMIT: execute via executor
    const submitRes = await executor.submit(order, permit);
    if (submitRes.outcome === "SUBMITTED") {
      return {
        ok: true,
        outcome: "SUBMITTED",
        state: submitRes.state,
        order: submitRes.result,
        permit,
      };
    }
    if (submitRes.outcome === "NEEDS_RECONCILIATION") {
      return {
        ok: true,
        outcome: "NEEDS_RECONCILIATION",
        state: "SUBMISSION_UNKNOWN",
        order: { order_id: submitRes.orderId },
        permit,
      };
    }
    return {
      ok: false,
      stage: "SUBMIT",
      code: submitRes.code,
      reason: submitRes.reason,
    };
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────
  // Every store shares `sharedPool`: end it exactly once, and only when this
  // factory created it. Individual store close() calls would double-end a
  // shared pool, so they are deliberately not called here.
  async function shutdown(): Promise<void> {
    stopReconciliation();
    if (ownsPool) await sharedPool.end().catch(() => undefined);
  }

  return {
    orchestrate,
    supervisor,
    reconciler,
    kernel,
    persistence: persistence,
    shutdown,
  };
}
