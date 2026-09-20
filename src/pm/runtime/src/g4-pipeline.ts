/**
 * @polyroot/runtime — G4 Pipeline (PAPER → SHADOW → MICRO-LIVE → LIVE).
 *
 * The G4 pipeline orchestrates the complete autonomous trading flow:
 *   INTELLIGENCE → STRATEGY → ORCHESTRATOR → EXECUTOR → VENUE
 *
 * Modes:
 * - PAPER: Zero financial I/O, simulator fills, no venue I/O
 * - SHADOW: Live data, no financial I/O, no order submission
 * - MICRO_LIVE: Real wallet, explicit cap, real fills
 * - LIVE: Full autonomy (requires Autonomy Charter gate)
 *
 * The pipeline enforces the financial gate at every step (PR-GOV-06, PR-EXE-01).
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
import type { EdgeResult } from "@polyroot/control";
import { G4AutonomousLoop, createG4Loop, type G4LoopConfig, type G4LoopDeps, type G4LoopInput, type G4LoopResult, type G4LoopMetrics } from "./g4-loop.js";
import { evaluateEdge, validateAndReserve, buildSignedOrder, computeGate, type FinancialGate } from "@polyroot/control";
import type { MoneyKernel } from "@polyroot/risk";
import type { Executor } from "@polyroot/executor";
import type { SignerVault } from "@polyroot/signer";
import { randomUUID } from "crypto";
import { simulateFill } from "./paper-engine.js";

/* ─── Types ──────────────────────────────────────────────────────────────── */

export type G4PipelineMode = "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE";

export interface G4PipelineConfig {
  mode: "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE";
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

export interface G4PipelineDeps {
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

export interface G4PipelineInput {
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

export interface G4PipelineResult {
  market_id: string;
  decision: "NO_TRADE" | "BUY" | "SELL";
  reason?: string;
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

export interface G4PipelineMetrics {
  totalOrders: number;
  filledOrders: number;
  totalPnl: number;
  totalFees: number;
  maxDrawdown: number;
  fillRatio: number;
  currentExposureUsd: number;
  maxExposureUsd: number;
}

/* ─── G4 Pipeline ─────────────────────────────────────────────────── */

/**
 * G4 Pipeline — implements PAPER → SHADOW → MICRO_LIVE → LIVE sequence.
 *
 * The pipeline integrates: Intelligence → Strategy → Risk Gate → Order Builder →
 * Executor → Signer Vault → Venue → Recovery → Reconciliation → Metrics.
 *
 * Modes:
 * - PAPER: zero financial I/O, simulator fills
 * - SHADOW: live data, no financial I/O
 * - MICRO-LIVE: real wallet, explicit cap, real fills
 * - LIVE: full autonomy (requires Autonomy Charter gate)
 */
export class G4Pipeline {
  private readonly config: Required<G4PipelineConfig>;
  private readonly deps: G4PipelineDeps;
  private readonly metrics: {
    totalOrders: number;
    filledOrders: number;
    totalPnl: number;
    totalFees: number;
    maxDrawdown: number;
    fillRatio: number;
    currentExposureUsd: number;
    maxExposureUsd: number;
  };
  private running = false;
  private stopFn?: () => void;
  private readonly paperFillConfig: {
    cancelProbability: number;
    partialFraction: number;
    latencyMs: number;
    makerFeeBps: number;
    takerFeeBps: number;
  };

  constructor(config: G4PipelineConfig, deps: any) {
    // Default config with sensible defaults
    this.config = {
      mode: config.mode ?? "PAPER",
      microLiveCapUsd: config.microLiveCapUsd ?? 500,
      shadowCriteria: config.shadowCriteria ?? { minDays: 30, minResolvedClusters: 100 },
      paperFillConfig: config.paperFillConfig ?? {
        cancelProbability: 0.05,
        partialFraction: 0.8,
        latencyMs: 50,
      },
      microLiveCapBase: config.microLiveCapBase ?? 100_000_000n,
      minEdgeAfterCost: config.minEdgeAfterCost ?? 0.03,
      paperConfig: config.paperConfig ?? {
        cancelProbability: 0.05,
        partialFraction: 0.8,
        latencyMs: 50,
        makerFeeBps: 0,
        takerFeeBps: 200,
      },
    };

    this.deps = deps;
    this.metrics = {
      totalOrders: 0,
      filledOrders: 0,
      totalPnl: 0,
      totalFees: 0,
      maxDrawdown: 0,
      fillRatio: 0,
      currentExposureUsd: 0,
      maxExposureUsd: 0,
    };

    this.paperFillConfig = {
      cancelProbability: this.config.paperFillConfig.cancelProbability,
      partialFraction: this.config.paperFillConfig.partialFraction,
      latencyMs: this.config.paperFillConfig.latencyMs,
      makerFeeBps: this.config.paperConfig.makerFeeBps,
      takerFeeBps: this.config.paperConfig.takerFeeBps,
    };
  }

  /** Get current mode. */
  getMode(): "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE" {
    return this.config.mode;
  }

  /** Set mode (validates transitions). */
  setMode(mode: "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE"): void {
    const validTransitions: Record<"PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE", string[]> = {
      PAPER: ["SHADOW"],
      SHADOW: ["MICRO_LIVE", "PAPER"],
      MICRO_LIVE: ["LIVE", "SHADOW"],
      LIVE: ["SHADOW"],
    };
    if (!validTransitions[this.config.mode].includes(mode)) {
      throw new Error(`Invalid mode transition: ${this.config.mode} -> ${mode}`);
    }
    this.config.mode = mode;
  }

  /** Get current metrics. */
  getMetrics(): { totalOrders: number; filledOrders: number; totalPnl: number; totalFees: number; maxDrawdown: number; fillRatio: number; currentExposureUsd: number; maxExposureUsd: number } {
    return { ...this.metrics };
  }

  /** Run one iteration of the pipeline for a single market. */
  async processMarket(input: {
    market_id: string;
    bid: number;
    ask: number;
    forecastOverride?: number | null;
    forecastObj?: any;
    currentMarketExposureUsd?: number;
    currentPortfolioExposureUsd?: number;
  }): Promise<{
    market_id: string;
    decision: "NO_TRADE" | "BUY" | "SELL";
    reason?: string;
    fill?: { status: "FILLED" | "PARTIAL" | "CANCELLED"; filledSize: number; fillPrice: number; makerFee: number; takerFee: number; latencyMs: number } | undefined;
    pnl?: number;
    orderId?: string | undefined;
    permitId?: string | undefined;
    outcome?: "SUBMITTED" | "NEEDS_RECONCILIATION" | undefined;
    p?: number | undefined;
    size?: number | undefined;
  }> {
    const { market_id, bid, ask, forecastOverride, forecastObj, currentMarketExposureUsd, currentPortfolioExposureUsd } = input;

    // 1. Check financial gate (mode, health, venue)
    const gate = computeGate(
      this.config.mode === "LIVE" ? "LIVE" : "PAPER",
      "ACTIVE",
      this.deps.venueMode(),
    );
    if (gate !== "ALLOW") {
      return {
        market_id: input.market_id,
        decision: "NO_TRADE",
        reason: `Financial gate: ${gate}`,
      };
    }

    // 2. Get forecast (or use override)
    let p: number | null;
    if (forecastOverride !== undefined) {
      p = forecastOverride;
    } else {
      p = await this.deps.forecast({ market_id: input.market_id, bid, ask });
    }
    if (p === null || p <= 0.02 || p >= 0.98 || Math.abs(p - 0.5) < 0.02) {
      return {
        market_id: input.market_id,
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
          market_id: input.market_id,
          schema_version: "1.1",
        },
        book: {
          yes_price: bid,
          no_price: ask,
          market_id: input.market_id,
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
          venue_mode: "NORMAL",
          source_at: new Date(),
          received_at: new Date(),
          schema_version: "1.1",
        },
      },
      { minEdge: this.config.minEdgeAfterCost ?? 0.03 }
    );
    if (edge.action === "NO_TRADE") {
      return {
        market_id: input.market_id,
        decision: "NO_TRADE",
        reason: edge.code ?? "MIN_EDGE_UNMET",
      };
    }

    // 4. Build intent from edge
    const intentSide = edge.side === "YES" ? "BUY" : "SELL";
    const size = this.deps.sizeIntent({ market_id: input.market_id, bid, ask }, p);
    if (size <= 0) {
      return {
        market_id: input.market_id,
        decision: "NO_TRADE",
        reason: "sizing returned zero",
      };
    }

    // 5. Risk gate + reservation
    const now = this.deps.now();
    const gateResult = await validateAndReserve({
      intent: {
        schema_version: "1.1",
        intent_id: crypto.randomUUID(),
        dedupe_key: `${input.market_id}_${Date.now()}`,
        purpose: "ENTRY",
        market_id: input.market_id,
        side: intentSide,
        desired_qty: size,
        limit_price: edge.reference_price ?? (intentSide === "BUY" ? ask : bid),
        created_at: now,
        evidence_ids: [],
        counterevidence_ids: [],
        assumptions: [],
        invalidators: [],
        status: "CREATED",
        forecast_refs: [],
        expiration_sec: 300,
      },
      policy: this.deps.policy,
      wallet: this.deps.wallet,
      venueMode: this.deps.venueMode(),
      leaseEpoch: this.deps.leaseEpoch(),
      now: this.deps.now(),
      policyHash: this.deps.policyHash,
      currentMarketExposureUsd: input.currentMarketExposureUsd,
      currentPortfolioExposureUsd: input.currentPortfolioExposureUsd,
    }, this.deps.kernel);

    if (!gateResult.ok) {
      return {
        market_id: input.market_id,
        decision: "NO_TRADE",
        reason: gateResult.reason ?? gateResult.code,
      };
    }

    // 6. Build signed order
    const built = await buildSignedOrder({
      intent: {
        schema_version: "1.1",
        intent_id: crypto.randomUUID(),
        dedupe_key: `${input.market_id}_${Date.now()}`,
        purpose: "ENTRY",
        market_id: input.market_id,
        side: intentSide,
        desired_qty: size,
        limit_price: edge.reference_price ?? (intentSide === "BUY" ? ask : bid),
        created_at: now,
        status: "CREATED",
        evidence_ids: [],
        counterevidence_ids: [],
        assumptions: [],
        invalidators: [],
        forecast_refs: [],
        expiration_sec: 300,
      },
      permit: gateResult.permit,
      wallet: this.deps.wallet,
      venueMode: this.deps.venueMode(),
      now: this.deps.now(),
    }, this.deps.signer);

    if (!built.ok) {
      return {
        market_id: input.market_id,
        decision: "NO_TRADE",
        reason: built.reason ?? built.code,
      };
    }

    // 7. Execute based on mode
    let fill: { status: "FILLED" | "PARTIAL" | "CANCELLED"; filledSize: number; fillPrice: number; makerFee: number; takerFee: number; latencyMs: number } | undefined;
    let orderId: string | undefined;
    let permitId: string | undefined;
    let outcome: "SUBMITTED" | "NEEDS_RECONCILIATION" | undefined;

    if (this.config.mode === "PAPER" || this.config.mode === "SHADOW") {
      // Simulate fill
      const fillResult = simulateFill({
        size: this.deps.sizeIntent({ market_id: input.market_id, bid, ask }, p),
        bid,
        ask,
        depth: 1000,
        taker: true,
        makerFeeBps: this.paperFillConfig.makerFeeBps,
        takerFeeBps: this.paperFillConfig.takerFeeBps,
        latencyMs: this.paperFillConfig.latencyMs,
        cancelProbability: this.paperFillConfig.cancelProbability,
        partialFraction: this.paperFillConfig.partialFraction,
      });
      fill = {
        status: fillResult.status,
        filledSize: fillResult.filledSize,
        fillPrice: fillResult.fillPrice,
        makerFee: fillResult.makerFee,
        takerFee: fillResult.takerFee,
        latencyMs: fillResult.latencyMs,
      };
    } else if (this.config.mode === "MICRO_LIVE" || this.config.mode === "LIVE") {
      // Submit to executor
      const submitted = await this.deps.executor.submit(built.order, gateResult.permit);
      if (submitted.outcome === "SUBMITTED") {
        orderId = built.order.order_id;
        permitId = gateResult.permit.permit_id;
        outcome = "SUBMITTED";
      } else if (submitted.outcome === "NEEDS_RECONCILIATION") {
        outcome = "NEEDS_RECONCILIATION";
      } else {
        return {
          market_id: input.market_id,
          decision: "NO_TRADE",
          reason: `Executor: ${submitted.reason ?? submitted.code}`,
        };
      }
    }

    // Calculate PnL
    const side = intentSide === "BUY" ? 1 : -1;
    const pnl = fill
      ? (fill.status === "FILLED" || fill.status === "PARTIAL")
        ? (fill.filledSize * (p - 0.5) - (fill.makerFee + fill.takerFee))
        : 0
      : 0;

    // Update metrics
    this.metrics.totalOrders++;
    if (fill && (fill.status === "FILLED" || fill.status === "PARTIAL")) {
      this.metrics.filledOrders++;
    }
    this.metrics.totalPnl += pnl ?? 0;
    if (fill) {
      this.metrics.totalFees += fill.makerFee + fill.takerFee;
    }

    return {
      market_id: input.market_id,
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

  /** Run a full pass over multiple markets. */
  async processMarkets(inputs: { market_id: string; bid: number; ask: number; forecastOverride?: number | null; forecastObj?: any; currentMarketExposureUsd?: number; currentPortfolioExposureUsd?: number }[]): Promise<any[]> {
    const results: any[] = [];
    for (const input of inputs) {
      const result = await this.processMarket(input);
      results.push(result);
    }
    return results;
  }

  /** Get current financial gate status. */
  getFinancialGate(): "ALLOW" | "ENTRY_BLOCKED" | "FINANCIAL_BLOCKED" {
    return computeGate(
      this.config.mode === "LIVE" ? "LIVE" : "PAPER",
      "ACTIVE",
      this.deps.venueMode(),
    );
  }
}

/* ─── Factory for creating pipeline with all dependencies ─────────────────── */

export interface CreateG4PipelineOptions {
  config: any; // G4PipelineConfig
  kernel: any;
  signer: any;
  executor: any;
  wallet: any;
  policy: any;
  policyHash: string;
  venueMode: () => any;
  leaseEpoch: () => number;
  now: () => Date;
  forecast: (market: { market_id: string; bid: number; ask: number }) => Promise<number | null>;
  sizeIntent: (market: { market_id: string; bid: number; ask: number }, p: number) => number;
}

export function createG4Pipeline(options: any) {
  const deps: any = {
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
  return new G4Pipeline(options.config, deps);
}

/* ─── Exports ─────────────────────────────────────────────────────────────── */

export type {
  G4PipelineMode,
  G4PipelineConfig,
  G4PipelineDeps,
  G4PipelineInput,
  G4PipelineResult,
  G4PipelineMetrics,
};
