// G4 Core Module - SHARED between G4AutonomousLoop and G4Pipeline
// This module contains the shared G4 logic for mode transitions, financial gates, and common utilities

import type {
  Forecast,
  RiskPolicy,
  VenueMode,
  WalletIdentity,
} from "@polyroot/domain";
import { simulateFill } from "./paper-engine.js";
import { evaluateEdge, validateAndReserve, buildSignedOrder } from "@polyroot/control";

/* ─── Core G4 Types ──────────────────────────────────────────────────────── */

export type G4Mode = "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE";

export interface G4CoreConfig {
  mode: G4Mode;
  /** Explicit capital cap for MICRO_LIVE (USD). Required for MICRO_LIVE. */
  microLiveCapUsd?: number;
  /** SHADOW baseline criteria (minimum days & resolved clusters). */
  shadowCriteria?: { minDays: number; minResolvedClusters: number };
  /** PAPER simulator configuration. */
  paperFillConfig?: {
    cancelProbability: number;
    partialFraction: number;
    latencyMs: number;
  };
  /** Microlive explicit cap (base units). */
  microLiveCapBase?: bigint;
  /** Minimum edge after costs for entry. */
  minEdgeAfterCost?: number;
  /** Paper simulator configuration. */
  paperConfig?: {
    cancelProbability: number;
    partialFraction: number;
    latencyMs: number;
    makerFeeBps: number;
    takerFeeBps: number;
  };
}

export interface G4CoreDeps {
  /** Intelligence: produces forecast from market data. */
  forecast: (market: { market_id: string; bid: number; ask: number }) => Promise<number | null>;
  /** Strategy: produces intent from forecast + market. */
  sizeIntent: (market: { market_id: string; bid: number; ask: number }, p: number) => number;
  /** Money Kernel for reservations & permits. */
  kernel: any;
  /** Signer Vault for signing orders. */
  signer: any;
  /** Executor for submitting orders. */
  executor: any;
  /** Wallet identity for financial operations. */
  wallet: WalletIdentity;
  /** Risk policy with caps & limits. */
  policy: RiskPolicy;
  /** Policy hash for permit binding. */
  policyHash: string;
  /** Current venue mode. */
  venueMode: () => VenueMode;
  /** Current lease epoch for permit binding. */
  leaseEpoch: () => number;
  /** Clock for TTL checks. */
  now: () => Date;
  /** Wallet for simulator fills. */
  paperWallet?: WalletIdentity;
}

export interface G4CoreInput {
  market_id: string;
  bid: number;
  ask: number;
  /** Optional forecast override (for testing/overrides). */
  forecastOverride?: number | null;
  /** Optional forecast object (for metadata). */
  forecastObj?: Forecast | null;
  /** Current market exposure in USD. */
  currentMarketExposureUsd?: number;
  /** Current portfolio exposure in USD. */
  currentPortfolioExposureUsd?: number;
}

export interface G4CoreResult {
  market_id: string;
  decision: "NO_TRADE" | "BUY" | "SELL";
  reason: string | undefined;
  /** For simulated/real fills. */
  fill?: {
    status: "FILLED" | "PARTIAL" | "CANCELLED";
    filledSize: number;
    fillPrice: number;
    makerFee: number;
    takerFee: number;
    latencyMs: number;
  } | undefined;
  pnl?: number;
  /** For real execution. */
  orderId?: string | undefined;
  permitId?: string | undefined;
  outcome?: "SUBMITTED" | "NEEDS_RECONCILIATION" | undefined;
  p?: number | undefined;
  size?: number | undefined;
}

export interface G4CoreMetrics {
  totalOrders: number;
  filledOrders: number;
  totalPnl: number;
  totalFees: number;
  maxDrawdown: number;
  fillRatio: number;
  currentExposureUsd: number;
  maxExposureUsd: number;
}

export interface CreateG4CoreOptions {
  config: G4CoreConfig;
  kernel: any;
  signer: any;
  executor: any;
  wallet: WalletIdentity;
  policy: RiskPolicy;
  policyHash: string;
  venueMode: () => VenueMode;
  leaseEpoch: () => number;
  now: () => Date;
  forecast: (market: { market_id: string; bid: number; ask: number }) => Promise<number | null>;
  sizeIntent: (market: { market_id: string; bid: number; ask: number }, p: number) => number;
}

export function createG4Core(options: CreateG4CoreOptions) {
  const deps: G4CoreDeps = {
    forecast: options.forecast,
    sizeIntent: options.sizeIntent,
    kernel: options.kernel,
    signer: options.signer,
    executor: options.executor,
    wallet: options.wallet,
    policy: options.policy,
    policyHash: options.policyHash,
    venueMode: options.venueMode,
    leaseEpoch: options.leaseEpoch,
    now: options.now,
  };
  return {
    config: options.config,
    deps,
  };
}

/* ─── Mode Transition Logic ──────────────────────────────────────────────── */

export const G4_MODE_TRANSITIONS: Record<G4Mode, G4Mode[]> = {
  PAPER: ["SHADOW"],
  SHADOW: ["MICRO_LIVE", "PAPER"],
  MICRO_LIVE: ["LIVE", "SHADOW"],
  LIVE: ["SHADOW"],
};

export function isValidModeTransition(current: G4Mode, target: G4Mode): boolean {
  return G4_MODE_TRANSITIONS[current].includes(target);
}

export function getDefaultModeConfig(mode: G4Mode, baseConfig: Partial<G4CoreConfig>): G4CoreConfig {
  const defaults: Partial<G4CoreConfig> = {
    microLiveCapUsd: 500,
    shadowCriteria: { minDays: 30, minResolvedClusters: 100 },
    paperFillConfig: { cancelProbability: 0.05, partialFraction: 0.8, latencyMs: 50 },
    microLiveCapBase: 100_000_000n,
    minEdgeAfterCost: 0.03,
    paperConfig: {
      cancelProbability: 0.05,
      partialFraction: 0.8,
      latencyMs: 50,
      makerFeeBps: 0,
      takerFeeBps: 200,
    },
  };

  return {
    mode,
    ...defaults,
    ...baseConfig,
  };
}

export function computeFinancialGate(
  mode: G4Mode,
  venueMode: () => VenueMode,
  minEdgeAfterCost?: number,
): "ALLOW" | "ENTRY_BLOCKED" | "FINANCIAL_BLOCKED" {
  if (mode === "LIVE") {
    return "FINANCIAL_BLOCKED";
  }

  if (mode === "MICRO_LIVE" || mode === "SHADOW") {
    const venue = venueMode();
    if (venue === "UNAVAILABLE" || venue === "UNKNOWN" || venue === "READ_ONLY") {
      return "ENTRY_BLOCKED";
    }

    if (minEdgeAfterCost && minEdgeAfterCost > 0.5) {
      return "FINANCIAL_BLOCKED";
    }
  }

  return "ALLOW";
}

export async function executeG4Step(
  input: G4CoreInput,
  core: { config: G4CoreConfig; deps: G4CoreDeps },
  paperFillConfig: any,
): Promise<G4CoreResult> {
  const {
    market_id,
    bid,
    ask,
    forecastOverride,
    forecastObj: _forecastObj,
    currentMarketExposureUsd,
    currentPortfolioExposureUsd,
  } = input;
  void _forecastObj;
  const { config, deps } = core;

  // 1. Check financial gate
  const gate = computeFinancialGate(
    config.mode,
    deps.venueMode,
    config.minEdgeAfterCost,
  );
  if (gate !== "ALLOW") {
    return {
      market_id,
      decision: "NO_TRADE",
      reason: `Financial gate: ${gate}`,
    };
  }

  // 2. Get forecast (or use override)
  let p: number | null;
  if (forecastOverride !== undefined) {
    p = forecastOverride;
  } else {
    p = await deps.forecast({ market_id, bid, ask });
  }
  if (p === null || p <= 0.02 || p >= 0.98 || Math.abs(p - 0.5) < 0.02) {
    return {
      market_id,
      decision: "NO_TRADE",
      reason: "forecast uncertain or unavailable",
    };
  }

  // 3. Edge evaluation
  const edge = evaluateEdge(
    {
      forecast: {
        p_calibrated: p,
        confidence: 0.8,
        horizon_sec: 3600,
        valid_until: new Date(Date.now() + 3600_000),
        created_at: new Date(),
        forecast_id: "",
        market_id,
        schema_version: "1.1",
        evidence_ids: [],
        counterevidence_ids: [],
        assumptions: [],
        invalidators: [],
      },
      book: {
        yes_price: bid,
        no_price: ask,
        market_id,
        event_id: "",
        question: "",
        chain_id: 137,
        collateral: "",
        rules_hash: "",
        fee_maker_bps: 0,
        fee_taker_bps: 200,
        tick_size: 0.01,
        min_size: 1,
        status: "ACTIVE",
        is_neg_risk: false,
        venue_mode: "NORMAL" as VenueMode,
        source_at: new Date(),
        received_at: new Date(),
        schema_version: "1.1",
      },
    },
    { minEdge: config.minEdgeAfterCost ?? 0.03 }
  );
  if (edge.action === "NO_TRADE") {
    return {
      market_id,
      decision: "NO_TRADE",
      reason: edge.code ?? "MIN_EDGE_UNMET",
    };
  }

  // 4. Build intent from edge
  const intentSide = edge.side === "YES" ? "BUY" : "SELL";
  const size = deps.sizeIntent({ market_id, bid, ask }, p);
  if (size <= 0) {
    return {
      market_id,
      decision: "NO_TRADE",
      reason: "sizing returned zero",
    };
  }

  // 5. Risk gate + reservation
  const now = deps.now();
  const gateResult = await validateAndReserve({
    intent: {
      schema_version: "1.1",
      intent_id: crypto.randomUUID(),
      dedupe_key: `${market_id}_${Date.now()}`,
      purpose: "ENTRY",
      market_id,
      side: intentSide,
      desired_qty: size,
      limit_price: edge.reference_price ?? (intentSide === "BUY" ? ask : bid),
      created_at: now,
      evidence_ids: [],
      forecast_refs: [],
      status: "CREATED",
      expiration_sec: 300,
    },
    policy: deps.policy,
    wallet: deps.wallet,
    venueMode: deps.venueMode(),
    leaseEpoch: deps.leaseEpoch(),
    now,
    policyHash: deps.policyHash,
    currentMarketExposureUsd: currentMarketExposureUsd ?? 0,
    currentPortfolioExposureUsd: currentPortfolioExposureUsd ?? 0,
  }, deps.kernel);

  if (!gateResult.ok) {
    return {
      market_id,
      decision: "NO_TRADE",
      reason: gateResult.reason ?? gateResult.code,
    };
  }

  // 6. Build signed order
  const built = await buildSignedOrder({
    intent: {
      schema_version: "1.1",
      intent_id: crypto.randomUUID(),
      dedupe_key: `${market_id}_${Date.now()}`,
      purpose: "ENTRY",
      market_id,
      side: intentSide,
      desired_qty: size,
      limit_price: edge.reference_price ?? (intentSide === "BUY" ? ask : bid),
      created_at: now,
      evidence_ids: [],
      forecast_refs: [],
      status: "CREATED",
      expiration_sec: 300,
    },
    permit: gateResult.permit,
    wallet: deps.wallet,
    venueMode: deps.venueMode(),
    now,
  }, deps.signer);

  if (!built.ok) {
    return {
      market_id,
      decision: "NO_TRADE",
      reason: built.reason ?? built.code,
    };
  }

  // 7. Execute based on mode
  let fill: G4CoreResult["fill"] | undefined;
  let orderId: string | undefined;
  let permitId: string | undefined;
  let outcome: "SUBMITTED" | "NEEDS_RECONCILIATION" | undefined;

  if (config.mode === "PAPER" || config.mode === "SHADOW") {
    // Simulate fill
    const fillResult = simulateFill({
      size,
      bid,
      ask,
      depth: 1000,
      taker: true,
      makerFeeBps: paperFillConfig.makerFeeBps,
      takerFeeBps: paperFillConfig.takerFeeBps,
      latencyMs: paperFillConfig.latencyMs,
      cancelProbability: paperFillConfig.cancelProbability,
      partialFraction: paperFillConfig.partialFraction,
    });
    fill = {
      status: fillResult.status,
      filledSize: fillResult.filledSize,
      fillPrice: fillResult.fillPrice,
      makerFee: fillResult.makerFee,
      takerFee: fillResult.takerFee,
      latencyMs: fillResult.latencyMs,
    };
  } else if (config.mode === "MICRO_LIVE" || config.mode === "LIVE") {
    // Submit to executor
    const submitted = await deps.executor.submit(built.order, gateResult.permit);
    if (submitted.outcome === "SUBMITTED") {
      orderId = built.order.order_id;
      permitId = gateResult.permit.permit_id;
      outcome = "SUBMITTED";
    } else if (submitted.outcome === "NEEDS_RECONCILIATION") {
      outcome = "NEEDS_RECONCILIATION";
    } else {
      return {
        market_id,
        decision: "NO_TRADE",
        reason: `Executor: ${submitted.reason ?? submitted.code}`,
      };
    }
  }

  // Calculate PnL
  const pnl = fill
    ? (fill.status === "FILLED" || fill.status === "PARTIAL")
      ? (fill.filledSize * (p - 0.5) - (fill.makerFee + fill.takerFee))
      : 0
    : 0;

  return {
    market_id,
    decision: fill ? (p > 0.5 ? "BUY" : "SELL") : "NO_TRADE",
    reason: fill ? undefined : "execution failed",
    fill,
    pnl,
    orderId,
    permitId,
    outcome,
    p,
    size,
  };
}