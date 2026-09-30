/**
 * @polyroot/runtime — Streaming Observability Bridge.
 *
 * Connects the Telegram streaming emitter to the G4Core observability hooks,
 * converting internal events into rich stream events with full AI reasoning.
 */

import {
  type G4CoreObservability,
  type G4CoreInput,
  type G4CoreResult,
  type G4Mode,
  type StepReasoning,
} from "./g4-core.js";
import { type VenueMode } from "@polyroot/domain";
import {
  type StreamEmitter,
  type ResearchEvent,
  type ForecastingEvent,
  type RiskEvent,
  type ExecutionEvent,
} from "./telegram-stream.js";

export interface StreamingObservabilityConfig {
  emitter: StreamEmitter;
  /** Current AI model lineage string for forecast events. */
  modelLineage: string;
  /** Get current funds for risk events. */
  getFunds?: () => Promise<{
    bankrollUsd: number | null;
    lockedUsd: number | undefined;
    sessionPnlUsd: number;
  }>;
  /** Get latest reasoning for a market. */
  getReasoning?: (marketId: string) => StepReasoning | undefined;
  /** Minimum edge threshold for risk events. */
  minEdgeThreshold?: number;
}

/**
 * Creates a G4CoreObservability implementation that emits streaming events
 * to the Telegram stream emitter.
 */
export function createStreamingObservability(
  config: StreamingObservabilityConfig,
): G4CoreObservability {
  const {
    emitter,
    modelLineage,
    getFunds,
    getReasoning,
    minEdgeThreshold = 0.03,
  } = config;

  return {
    async emitStepStart(input: G4CoreInput, mode: G4Mode): Promise<void> {
      // Emit research phase when a step starts
      const marketId = input.market_id;
      const bid = input.bid;
      const ask = input.ask;
      const spread = Math.abs(ask - bid);

      // We don't have real research data here, but we can emit a system event
      // showing the market being analyzed
      await emitter.emitSystem({
        type: "health",
        message: `Analyzing market ${marketId} (mode: ${mode})`,
        severity: "info",
        details: { bid, ask, spread },
      });
    },

    async emitStepComplete(
      input: G4CoreInput,
      result: G4CoreResult,
    ): Promise<void> {
      const marketId = input.market_id;
      const bid = input.bid;
      const ask = input.ask;
      const spread = Math.abs(ask - bid);
      const p = result.p ?? null;

      // Get reasoning if available
      const reasoning = getReasoning?.(marketId);

      // Emit FORECASTING event
      const forecastingEvent: ForecastingEvent = {
        marketId,
        modelLineage,
        pYes: p,
        pNo: p !== null ? 1 - p : null,
        edge: result.edge ?? 0,
        bookBid: bid,
        bookAsk: ask,
        spread,
        rationale: reasoning?.rationale ?? "No rationale available",
        factors: reasoning?.factors ?? [],
        confidence: reasoning?.rationale ? 0.7 : 0.3, // Heuristic
        abstainReason: p === null ? result.reason : undefined,
      };
      await emitter.emitForecasting(forecastingEvent);

      // Emit RISK event
      const decision = result.decision;
      const edge = result.edge ?? 0;
      const minEdge = minEdgeThreshold;

      // Get funds for risk event
      const funds = await getFunds?.();

      const riskEvent: RiskEvent = {
        marketId,
        decision: decision === "BUY" || decision === "SELL" ? "TRADE" : "NO_TRADE",
        reason: result.reason ?? "No reason given",
        edge,
        minEdge,
        kellyFraction: 0.25, // From config
        size: result.size ?? 0,
        bankrollUsd: funds?.bankrollUsd ?? 0,
        exposureUsd: funds?.lockedUsd ?? 0,
      };
      await emitter.emitRisk(riskEvent);

      // Emit EXECUTION event if trade happened
      if (decision === "BUY" || decision === "SELL") {
        const executionEvent: ExecutionEvent = {
          marketId,
          action: "SUBMIT",
          side: decision,
          shares: result.size ?? 0,
          price: decision === "BUY" ? ask : bid,
          status: "Submitted to executor",
        };
        await emitter.emitExecution(executionEvent);
      }
    },

    async emitFinancialGate(
      gate: "ALLOW" | "ENTRY_BLOCKED" | "FINANCIAL_BLOCKED",
      mode: G4Mode,
      venue: VenueMode,
    ): Promise<void> {
      await emitter.emitSystem({
        type: "health",
        message: `Financial Gate: ${gate}`,
        severity: gate === "ALLOW" ? "info" : "warning",
        details: { mode, venue },
      });
    },

    async emitError(error: Error, context: unknown): Promise<void> {
      await emitter.emitSystem({
        type: "error",
        message: error.message,
        severity: "critical",
        details: { context: String(context).slice(0, 200) },
      });
    },

    async emitMetrics(metrics: {
      totalOrders: number;
      filledOrders: number;
      totalPnl: number;
      totalFees: number;
      maxDrawdown: number;
      fillRatio: number;
      currentExposureUsd: number;
      maxExposureUsd: number;
    }): Promise<void> {
      // Emit periodic metrics as system event (rate-limited by emitter)
      await emitter.emitSystem({
        type: "health",
        message: `Metrics: Orders=${metrics.totalOrders} Filled=${metrics.filledOrders} PnL=${metrics.totalPnl.toFixed(2)} Exposure=$${metrics.currentExposureUsd.toFixed(2)}`,
        severity: "info",
        details: metrics,
      });
    },

    async emitModeTransition(
      from: G4Mode,
      to: G4Mode,
      reason: string,
    ): Promise<void> {
      await emitter.emitSystem({
        type: "mode_change",
        message: `Mode transition: ${from} → ${to}`,
        severity: "info",
        details: { reason },
      });
    },
  };
}

/**
 * Creates a richer streaming observability that also emits RESEARCH events
 * when the intelligence layer runs. This requires the intelligence components
 * to call the emitter directly (they're not part of the G4Core observability).
 */
export interface IntelligenceStreamHooks {
  /** Called when research phase starts for a market. */
  onResearchStart(marketId: string, question?: string): Promise<void>;
  /** Called when research completes with evidence. */
  onResearchComplete(data: ResearchEvent): Promise<void>;
  /** Called when forecasting produces a result. */
  onForecastComplete(data: ForecastingEvent): Promise<void>;
  /** Called when risk gate makes a decision. */
  onRiskDecision(data: RiskEvent): Promise<void>;
  /** Called when order is submitted/acknowledged/filled. */
  onExecutionUpdate(data: ExecutionEvent): Promise<void>;
}

export function createIntelligenceStreamHooks(
  emitter: StreamEmitter,
): IntelligenceStreamHooks {
  return {
    async onResearchStart(marketId: string, question?: string): Promise<void> {
      await emitter.emitSystem({
        type: "health",
        message: `🔍 Research started for ${marketId}${question ? `: ${question.slice(0, 50)}` : ""}`,
        severity: "info",
        details: { marketId, question },
      });
    },

    async onResearchComplete(data: ResearchEvent): Promise<void> {
      await emitter.emitResearch(data);
    },

    async onForecastComplete(data: ForecastingEvent): Promise<void> {
      await emitter.emitForecasting(data);
    },

    async onRiskDecision(data: RiskEvent): Promise<void> {
      await emitter.emitRisk(data);
    },

    async onExecutionUpdate(data: ExecutionEvent): Promise<void> {
      await emitter.emitExecution(data);
    },
  };
}