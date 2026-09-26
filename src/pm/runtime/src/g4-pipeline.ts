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
  G4CoreConfig,
  G4CoreDeps,
  G4CoreInput,
  G4CoreResult,
  G4CoreMetrics,
  CreateG4CoreOptions,
} from "./g4-core.js";
import {
  isValidModeTransition,
  getDefaultModeConfig,
  computeFinancialGate,
  executeG4Step,
  createG4Core,
  buildLoopInputs,
  formatAiLine,
} from "./g4-core.js";

/* ─── Types ──────────────────────────────────────────────────────────────── */

export type G4PipelineMode = "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE";

export interface G4PipelineConfig extends G4CoreConfig {}
export interface G4PipelineDeps extends G4CoreDeps {}
export interface G4PipelineInput extends G4CoreInput {}
export interface G4PipelineResult extends G4CoreResult {}
export interface G4PipelineMetrics extends G4CoreMetrics {}

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
  private readonly metrics: G4PipelineMetrics;
  private running = false;
  private stopFn?: () => void;
  private readonly paperFillConfig: {
    cancelProbability: number;
    partialFraction: number;
    latencyMs: number;
    makerFeeBps: number;
    takerFeeBps: number;
  };

  constructor(config: G4PipelineConfig, deps: G4PipelineDeps) {
    const defaults = getDefaultModeConfig(config.mode, config);
    this.config = defaults as Required<G4PipelineConfig>;
    this.deps = {
      ...deps,
      observability: {
        emitStepStart: deps.observability?.emitStepStart ?? (() => {}),
        emitStepComplete: deps.observability?.emitStepComplete ?? (() => {}),
        emitFinancialGate: deps.observability?.emitFinancialGate ?? (() => {}),
        emitError: deps.observability?.emitError ?? (() => {}),
        emitMetrics: deps.observability?.emitMetrics ?? (() => {}),
        emitModeTransition:
          deps.observability?.emitModeTransition ?? (() => {}),
      },
    };
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
  getMode(): G4PipelineMode {
    return this.config.mode;
  }

  /** Set mode (validates transitions). */
  setMode(mode: G4PipelineMode): void {
    if (!isValidModeTransition(this.config.mode, mode)) {
      throw new Error(
        `Invalid mode transition: ${this.config.mode} -> ${mode}`,
      );
    }
    this.config.mode = mode;
  }

  /** Get current metrics. */
  getMetrics(): G4PipelineMetrics {
    return { ...this.metrics };
  }

  /** Run one iteration of the pipeline for a single market. */
  async processMarket(input: G4PipelineInput): Promise<G4PipelineResult> {
    const result = await executeG4Step(
      input,
      { config: this.config, deps: this.deps },
      this.paperFillConfig,
    );

    // Update metrics
    this.metrics.totalOrders++;
    if (
      result.fill &&
      (result.fill.status === "FILLED" || result.fill.status === "PARTIAL")
    ) {
      this.metrics.filledOrders++;
    }
    this.metrics.totalPnl += result.pnl ?? 0;
    if (result.fill) {
      this.metrics.totalFees += result.fill.makerFee + result.fill.takerFee;
    }

    return result;
  }

  /** Run a full pass over multiple markets. */
  async processMarkets(inputs: G4PipelineInput[]): Promise<G4PipelineResult[]> {
    const results: G4PipelineResult[] = [];
    for (const input of inputs) {
      const result = await this.processMarket(input);
      results.push(result);
    }
    return results;
  }

  /** Get current financial gate status. */
  getFinancialGate(): "ALLOW" | "ENTRY_BLOCKED" | "FINANCIAL_BLOCKED" {
    return computeFinancialGate(
      this.config.mode,
      this.deps.venueMode,
      this.config.minEdgeAfterCost,
    );
  }

  /**
   * Run the pipeline continuously, polling markets at the configured interval.
   * This is the main entry point for autonomous operation.
   */
  async runContinuous(): Promise<void> {
    this.running = true;
    console.log(`🔄 G4 Pipeline running in ${this.config.mode} mode...`);

    while (this.running) {
      try {
        // PAPER replays the mock fixture; every other mode iterates the
        // wired market universe (buildLoopInputs throws rather than
        // fabricating mock markets when live-configured).
        const inputs = await buildLoopInputs(this.config, this.deps);
        if (inputs.length === 0) {
          console.log("⏭️  No live markets with prices this pass.");
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }

        for (const loopInput of inputs) {
          const result = await this.processMarket(loopInput);

          if (
            result.fill &&
            (result.fill.status === "FILLED" ||
              result.fill.status === "PARTIAL")
          ) {
            console.log(
              `✅ Fill: ${result.fill.status} @ ${result.fill.fillPrice} x ${result.fill.filledSize}${formatAiLine(result)}`,
            );
          } else if (result.decision !== "NO_TRADE") {
            console.log(
              `📊 Decision: ${result.decision} @ ${result.p} (size: ${result.size})${formatAiLine(result)}`,
            );
          } else {
            console.log(
              `⏭️  No trade: ${result.reason}${formatAiLine(result)}`,
            );
          }

          // Wait for next interval
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      } catch (error) {
        console.error("❌ Pipeline error:", error);
        // Continue running even if one iteration fails
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  /**
   * Stop the continuous loop gracefully.
   */
  stop(): void {
    this.running = false;
    console.log("🛑 G4 Pipeline stopping...");
  }
}

/* ─── Factory for creating pipeline with all dependencies ─────────────────── */

export interface CreateG4PipelineOptions extends CreateG4CoreOptions {}

export function createG4Pipeline(options: CreateG4PipelineOptions) {
  const { config, deps } = createG4Core(options);
  return new G4Pipeline(config, deps);
}
