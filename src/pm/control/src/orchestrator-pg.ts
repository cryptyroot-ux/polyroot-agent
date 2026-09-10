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
  type BalanceStore,
  type KernelEventSink,
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
      state: any;
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
    balanceStore: BalanceStore;
    eventSink: KernelEventSink;
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
  const controlPool = stores.pool;

// ── Executor with PostgreSQL-backed seen map (in-memory cache, DB sync) ──
  const _seenCache = new Map<string, import("@polyroot/executor").OrderLifecycleState>();

  // Hydrate cache from DB once at startup (survives restarts).
  const _unknownIds = await persistence.listUnknown();
  for (const _id of _unknownIds) _seenCache.set(_id, "SUBMISSION_UNKNOWN");

  const executor = new Executor({
    adapter: deps.venue,
    now: deps.now,
    seen: {
      has: (orderId: string) => _seenCache.has(orderId),
      add: (orderId: string, state: any) => {
        _seenCache.set(orderId, state);
        void persistence.set(orderId, state); // fire-and-forget DB sync
      },
      get: (orderId: string) => _seenCache.get(orderId),
    },
    markPermitUsed: async (permitId: string) => {
      await controlPool.query(
        `UPDATE execution_permits SET used_at = now() WHERE permit_id = $1`,
        [permitId],
      );
    },
    isPermitUsed: async (permitId: string) => {
      const result = await controlPool.query(
        `SELECT used_at FROM execution_permits WHERE permit_id = $1`,
        [permitId],
      );
      return Boolean(result.rows[0]?.used_at);
    },
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
    if (edge.action === "NO_TRADE") {
      return { ok: false, stage: "EDGE" as const, code: edge.code, reason: edge.reason };
    }

    // Stage RISK: policy limits + atomic reservation → permit
    const gate = await validateAndReserve(
      {
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
      },
      kernel,
    );
    if (!gate.ok) {
      return { ok: false, stage: "RISK" as const, code: gate.code, reason: gate.reason };
    }

    // Stage BUILD: clamp to permit + sign
    const built = await buildSignedOrder(
      {
        intent: input.intent,
        permit: gate.permit,
        wallet: deps.wallet,
        venueMode,
        now,
      },
      deps.signer,
    );
    if (!built.ok) {
      return { ok: false, stage: "BUILD" as const, code: built.code, reason: built.reason };
    }

    // Stage SUBMIT: idempotent, permit-bound, venue-gated
    const submitted = await executor.submit(built.order, gate.permit);
    switch (submitted.outcome) {
      case "SUBMITTED":
        return {
          ok: true,
          outcome: "SUBMITTED" as const,
          state: submitted.state,
          order: built.order,
          permit: gate.permit,
        };
      case "NEEDS_RECONCILIATION":
        return {
          ok: true,
          outcome: "NEEDS_RECONCILIATION" as const,
          state: "SUBMISSION_UNKNOWN" as const,
          order: built.order,
          permit: gate.permit,
        };
      default:
        return {
          ok: false,
          stage: "SUBMIT" as const,
          code: submitted.code,
          reason: submitted.reason,
        };
    }
  }

  async function shutdown(): Promise<void> {
    await riskPool.end();
    await controlPool.end();
  }

  return {
    orchestrate,
    supervisor,
    reconciler,
    kernel,
    persistence,
    shutdown,
  };
}