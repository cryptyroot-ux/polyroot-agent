/**
 * @polyroot/runtime — G4 Autonomous Runtime Loop.
 *
 * Implements the G4 autonomous loop per Blueprint B17.3:
 * PAPER → SHADOW → MICRO_LIVE → autonomous-LIVE
 *
 * The loop integrates: Intelligence → Strategy → Risk Gate → Order Builder →
 * Executor → Signer Vault → Venue → Recovery → Reconciliation → Metrics.
 *
 * Modes:
 * - PAPER: zero financial I/O, simulator fills
 * - SHADOW: live data, no financial I/O
 * - MICRO-LIVE: real wallet, explicit cap, real fills
 * - LIVE: full autonomy (requires Autonomy Charter gate)
 */

import type {
  G4Mode,
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
} from "./g4-core.js";

/* ─── Types ──────────────────────────────────────────────────────────────── */

export type { G4Mode };

export interface G4LoopConfig extends G4CoreConfig {
  mode: G4Mode;
}
export type G4LoopDeps = G4CoreDeps;
export type G4LoopInput = G4CoreInput;
export type G4LoopResult = G4CoreResult;
export type G4LoopMetrics = G4CoreMetrics;

/* ─── G4 Autonomous Loop ─────────────────────────────────────────────────── */

/**
 * G4 Autonomous Loop — implements PAPER → SHADOW → MICRO_LIVE → LIVE sequence.
 *
 * The loop integrates: Intelligence → Strategy → Risk Gate → Order Builder →
 * Executor → Signer Vault → Venue → Recovery → Reconciliation → Metrics.
 *
 * Modes:
 * - PAPER: zero financial I/O, simulator fills
 * - SHADOW: live data, no financial I/O
 * - MICRO-LIVE: real wallet, explicit cap, real fills
 * - LIVE: full autonomy (requires Autonomy Charter gate)
 */
export class G4AutonomousLoop {
  private readonly config: Required<G4LoopConfig>;
  private readonly deps: G4LoopDeps;
  private readonly metrics: G4LoopMetrics;
  private running = false;
  private stopFn?: () => void;
  private readonly paperFillConfig: {
    cancelProbability: number;
    partialFraction: number;
    latencyMs: number;
    makerFeeBps: number;
    takerFeeBps: number;
  };

  constructor(config: G4LoopConfig, deps: G4LoopDeps) {
    const defaults = getDefaultModeConfig(config.mode, config);
    this.config = defaults as Required<G4LoopConfig>;
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
  getMode(): G4Mode {
    return this.config.mode;
  }

  /** Set mode (validates transitions). */
  setMode(mode: G4Mode): void {
    if (!isValidModeTransition(this.config.mode, mode)) {
      throw new Error(`Invalid mode transition: ${this.config.mode} -> ${mode}`);
    }
    this.config.mode = mode;
  }

  /** Get current metrics. */
  getMetrics(): G4LoopMetrics {
    return { ...this.metrics };
  }

  /** Run one iteration of the autonomous loop for a single market. */
  async step(input: G4LoopInput): Promise<G4LoopResult> {
    const result = await executeG4Step(input, { config: this.config, deps: this.deps }, this.paperFillConfig);

    // Update metrics
    this.metrics.totalOrders++;
    if (result.fill && (result.fill.status === "FILLED" || result.fill.status === "PARTIAL")) {
      this.metrics.filledOrders++;
    }
    this.metrics.totalPnl += result.pnl ?? 0;
    if (result.fill) {
      this.metrics.totalFees += result.fill.makerFee + result.fill.takerFee;
    }

    return result;
  }

  /** Run a full pass over multiple markets. */
  async runPass(inputs: G4LoopInput[]): Promise<G4LoopResult[]> {
    const results: G4LoopResult[] = [];
    for (const input of inputs) {
      const result = await this.step(input);
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
   * Run the autonomous loop continuously, polling markets at the configured interval.
   * This is the main entry point for autonomous operation.
   */
  async runContinuous(): Promise<void> {
    this.running = true;
    console.log(`🔄 G4 Autonomous Loop running in ${this.config.mode} mode...`);
    
    while (this.running) {
      try {
        // In a real implementation, this would fetch markets from the venue adapter
        // For now, we'll run a single iteration with mock data
        const mockInput = {
          market_id: "mock_market_1",
          bid: 0.45,
          ask: 0.55,
        };
        
        const result = await this.step(mockInput);
        
        if (result.fill && (result.fill.status === "FILLED" || result.fill.status === "PARTIAL")) {
          console.log(`✅ Fill: ${result.fill.status} @ ${result.fill.fillPrice} x ${result.fill.filledSize}`);
        } else if (result.decision !== "NO_TRADE") {
          console.log(`📊 Decision: ${result.decision} @ ${result.p} (size: ${result.size})`);
        } else {
          console.log(`⏭️  No trade: ${result.reason}`);
        }
        
        // Wait for next interval
        await new Promise(resolve => setTimeout(resolve, 5000));
        
      } catch (error) {
        console.error("❌ Loop error:", error);
        // Continue running even if one iteration fails
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  /**
   * Stop the continuous loop gracefully.
   */
  stop(): void {
    this.running = false;
    console.log("🛑 G4 Autonomous Loop stopping...");
  }
}

/* ─── Factory for creating G4 loop with all dependencies ─────────────────── */

export interface CreateG4LoopOptions extends CreateG4CoreOptions {}

export function createG4Loop(options: CreateG4LoopOptions) {
  const { config, deps } = createG4Core(options);
  return new G4AutonomousLoop(config, deps);
}

/* ─── Exports ─────────────────────────────────────────────────────────────── */

// All types are exported via their interface/type declarations above