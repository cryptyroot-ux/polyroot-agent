/**
 * @polyroot/control — Orchestrator.
 *
 * End-to-end single-shot pipeline: signal edge → risk gate + reservation →
 * signed order → executor submit. Each stage fails closed with a typed code so
 * callers (and the audit trail) know exactly where and why a trade was blocked.
 *
 *   stage EDGE    evaluateEdge against policy.min_edge_after_cost
 *   stage RISK    validateAndReserve (policy % limits + MoneyKernel reserve)
 *   stage BUILD   buildSignedOrder (clamped, signed inside permit bounds)
 *   stage SUBMIT  executor.submit (idempotent, permit-bound, venue-gated)
 *
 * An in-flight unknown submission is NOT a failure: it routes to reconciliation
 * (no blind re-submit; EXE-04).
 */

import type {
  ExecutionPermit,
  Forecast,
  MarketSnapshot,
  RiskPolicy,
  SignedOrder,
  TradeIntent,
  VenueMode,
  WalletIdentity,
} from "@polyroot/domain";
import { Executor, type OrderLifecycleState } from "@polyroot/executor";
import { MoneyKernel } from "@polyroot/risk";
import { SignerVault } from "@polyroot/signer";
import { evaluateEdge } from "./signal.js";
import { validateAndReserve } from "./risk-gate.js";
import { buildSignedOrder } from "./order-builder.js";

export interface OrchestratorDeps {
  kernel: MoneyKernel;
  signer: SignerVault;
  executor: Executor;
  wallet: WalletIdentity;
  policy: RiskPolicy;
  policyHash: string;
  /** Venue mode observed immediately before each stage. */
  venueMode: () => VenueMode;
  leaseEpoch: () => number;
  now: () => Date;
}

export interface OrchestrateInput {
  forecast: Forecast;
  book: MarketSnapshot;
  intent: TradeIntent;
  currentMarketExposureUsd?: number;
  currentPortfolioExposureUsd?: number;
}

export type OrchestrateStage = "EDGE" | "RISK" | "BUILD" | "SUBMIT";

export type OrchestrateResult =
  | {
      ok: true;
      outcome: "SUBMITTED" | "NEEDS_RECONCILIATION";
      state: OrderLifecycleState;
      order: SignedOrder;
      permit: ExecutionPermit;
    }
  | { ok: false; stage: OrchestrateStage; code: string; reason: string };

export async function orchestrate(
  deps: OrchestratorDeps,
  input: OrchestrateInput,
): Promise<OrchestrateResult> {
  // ── Stage EDGE: is there a tradeable edge at all? ─────────────────────────
  const edge = evaluateEdge(
    { forecast: input.forecast, book: input.book },
    { minEdge: deps.policy.min_edge_after_cost },
  );
  if (edge.action === "NO_TRADE") {
    return {
      ok: false,
      stage: "EDGE",
      code: edge.code,
      reason: edge.reason,
    };
  }

  const now = deps.now();
  const venueMode = deps.venueMode();

  // ── Stage RISK: policy limits + atomic reservation → permit ───────────────
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
    deps.kernel,
  );
  if (!gate.ok) {
    return { ok: false, stage: "RISK", code: gate.code, reason: gate.reason };
  }

  // ── Stage BUILD: clamp to permit + sign ───────────────────────────────────
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
    return { ok: false, stage: "BUILD", code: built.code, reason: built.reason };
  }

  // ── Stage SUBMIT: idempotent, permit-bound, venue-gated ───────────────────
  const submitted = await deps.executor.submit(built.order, gate.permit);
  switch (submitted.outcome) {
    case "SUBMITTED":
      return {
        ok: true,
        outcome: "SUBMITTED",
        state: submitted.state,
        order: built.order,
        permit: gate.permit,
      };
    case "NEEDS_RECONCILIATION":
      return {
        ok: true,
        outcome: "NEEDS_RECONCILIATION",
        state: "SUBMISSION_UNKNOWN",
        order: built.order,
        permit: gate.permit,
      };
    default:
      return {
        ok: false,
        stage: "SUBMIT",
        code: submitted.code,
        reason: submitted.reason,
      };
  }
}

export type { Executor, MoneyKernel, SignerVault };