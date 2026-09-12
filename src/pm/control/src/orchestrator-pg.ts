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

import type { PoolConfig } from "pg";
import type { ExecutionPermit } from "@polyroot/domain";
import {
  createPgStores,
  MoneyKernel,
} from "@polyroot/risk";
import {
  createPgControlStores,
  PgReconciler,
  PgSupervisor,
} from "@polyroot/control";
import { Executor } from "@polyroot/executor";
import type { VenueAdapter } from "@polyroot/venue";
import { evaluateEdge } from "./signal.js";
import { validateAndReserve } from "./risk-gate.js";
import { buildSignedOrder } from "./order-builder.js";

export interface OrchestratorPgDeps {
  /** Wallet whose funds are reserved. */
  wallet: any;
  /** Current risk policy. */
  policy: any;
  policyHash: string;
  /** Venue adapter for the live venue (or mock for PAPER). */
  venue: VenueAdapter;
  /** Signer vault already wired with the real/mock CryptoSigner. */
  signer: any;
  /** Venue mode observed immediately before each stage. */
  venueMode: () => any;
  leaseEpoch: () => number;
  now: () => Date;
  /** PostgreSQL connection (string or PoolConfig). */
  pgConfig: PoolConfig | string;
}

export interface OrchestrateInput {
  forecast: any;
  book: any;
  intent: any;
  currentMarketExposureUsd?: number;
  currentPortfolioExposureUsd?: number;
}

export type OrchestrateStage = "EDGE" | "RISK" | "BUILD" | "SUBMIT";

export type OrchestrateOutcome =
  | {
      ok: true;
      outcome: "SUBMITTED" | "NEEDS_RECONCILIATION";
      state: import("@polyroot/executor").OrderLifecycleState;
      order: any;
      permit: ExecutionPermit;
    }
  | { ok: false; stage: "EDGE" | "RISK" | "BUILD" | "SUBMIT"; code: string; reason: string };

export interface WiredOrchestrator {
  orchestrate: (input: OrchestrateInput) => Promise<OrchestrateOutcome>;
  supervisor: any;
  reconciler: any;
  kernel: MoneyKernel;
  persistence: any;
  shutdown: () => Promise<void>;
}

export async function createOrchestratorPg(deps: OrchestratorPgDeps): Promise<WiredOrchestrator> {
  // ── PostgreSQL-backed Money Kernel ports ──────────────────────────────────
  const {
    balanceStore,
    eventSink,
    pool: riskPool,
  }: {
    balanceStore: import("@polyroot/risk").BalanceStore;
    eventSink: import("@polyroot/risk").KernelEventSink;
    pool: import("pg").Pool;
  } = createPgStores(deps.pgConfig);

  const kernel = new MoneyKernel({
    balance: balanceStore,
    sink: eventSink,
    chainId: 137,
  });

  // ── PostgreSQL-backed Control plane ports ─────────────────────────────────
  const stores = createPgControlStores(deps.pgConfig, null as any, deps.policy);
  const persistence = stores.persistence;

  // ── PostgreSQL-backed Permit Store & Recovery Ledger ──────────────────────
  const permitStore = new (await import("@polyroot/venue")).PgPermitStore(deps.pgConfig);
  const recoveryLedger = new (await import("@polyroot/venue")).PgRecoveryLedger(deps.pgConfig);

  // ── Executor with in-memory seen cache (DB-backed recovery ledger for crash safety) ──
  const seenCache = new Map<string, import("@polyroot/executor").OrderLifecycleState>();

  // Hydrate cache from DB once at startup (survives restarts).
  const unknownIds = await recoveryLedger.getUnresolved();
  for (const id of unknownIds) seenCache.set(id.orderId, id.state);

  const executor = new Executor({
    adapter: deps.venue,
    now: deps.now,
    seen: {
      has: (orderId: string) => seenCache.has(orderId),
      add: (orderId: string, state: import("@polyroot/executor").OrderLifecycleState) => {
        seenCache.set(orderId, state);
      },
      get: (orderId: string) => seenCache.get(orderId),
    },
    permitStore,
    recoveryLedger,
    leaseEpoch: deps.leaseEpoch(),
  });

  // ── PostgreSQL-backed Reconciler + Supervisor ─────────────────────────────
  const reconciler = new PgReconciler(executor, deps.pgConfig);
  const supervisor = new PgSupervisor(reconciler, deps.pgConfig, deps.policy);

  // ── Orchestration pipeline ────────────────────────────────────────────────
  async function orchestrate(input: OrchestrateInput): Promise<OrchestrateOutcome> {
    const now = deps.now();
    const venueMode = deps.venueMode();

    // Stage EDGE: is there a tradeable edge at all?
    const edge = evaluateEdge(
      { forecast: input.forecast, book: input.book },
      { minEdge: deps.policy.min_edge_after_cost },
    );
    if (edge.action !== "TRADE") {
      return { ok: false, stage: "EDGE", code: "MIN_EDGE_UNMET", reason: `edge ${Math.round(edge.edge * 10000)} bps < ${deps.policy.min_edge_after_cost * 10000} bps` };
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
      return { ok: false, stage: "RISK", code: riskRes.code, reason: riskRes.reason };
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
      return { ok: false, stage: "BUILD", code: buildRes.code, reason: buildRes.reason };
    }
    const { order, permit } = buildRes;

    // Stage SUBMIT: execute via executor
    const submitRes = await executor.submit(order, permit);
    if (submitRes.outcome === "SUBMITTED") {
      return { ok: true, outcome: "SUBMITTED", state: submitRes.state, order: submitRes.result, permit };
    }
    if (submitRes.outcome === "NEEDS_RECONCILIATION") {
      return { ok: true, outcome: "NEEDS_RECONCILIATION", state: "SUBMISSION_UNKNOWN", order: { order_id: submitRes.orderId }, permit };
    }
    return { ok: false, stage: "SUBMIT", code: submitRes.code, reason: submitRes.reason };
  }

  // ── Shutdown ──────────────────────────────────────────────────────────────
  async function shutdown(): Promise<void> {
    await Promise.all([
      riskPool.end(),
      (await import("@polyroot/venue")).PgPermitStore.prototype.close?.call(permitStore),
      (await import("@polyroot/venue")).PgRecoveryLedger.prototype.close?.call(recoveryLedger),
    ]);
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
