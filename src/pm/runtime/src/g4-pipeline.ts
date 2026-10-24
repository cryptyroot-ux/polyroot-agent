/**
 * @polyroot/runtime — G4 Pipeline (MICRO-LIVE → LIVE).
 *
 * The G4 pipeline orchestrates the complete autonomous trading flow:
 *   INTELLIGENCE → STRATEGY → ORCHESTRATOR → EXECUTOR → VENUE
 *
 * Mode: LIVE only. Real wallet, explicit cap, real fills. Full
 * autonomy still requires an owner-signed promotion; without it the
 * financial gate stays FINANCIAL_BLOCKED.
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
  formatStepBlock,
  resolveEdgeFloor,
  type StepFunds,
} from "./g4-core.js";
import {
  selectMarketsForPass,
  scoreOpportunity,
  PositionTracker,
  type RankedMarket,
} from "@polyroot/strategy";
import { AUTONOMY_BOUNDS } from "./autonomy-bounds.js";
import { accountAfterStep, exposureForStep } from "./live-accounting.js";
import { syncDurableExposure, type ExposureBook } from "./exposure-sync.js";

/* ─── Types ──────────────────────────────────────────────────────────────── */

export type G4PipelineMode = "LIVE";

export interface G4PipelineConfig extends G4CoreConfig {}
export interface G4PipelineDeps extends G4CoreDeps {}
export interface G4PipelineInput extends G4CoreInput {}
export interface G4PipelineResult extends G4CoreResult {}
export interface G4PipelineMetrics extends G4CoreMetrics {}

/* ─── G4 Pipeline ─────────────────────────────────────────────────── */

/**
 * G4 Pipeline — drives the LIVE trading sequence.
 *
 * The pipeline integrates: Intelligence → Strategy → Risk Gate → Order Builder →
 * Executor → Signer Vault → Venue → Recovery → Reconciliation → Metrics.
 *
 * LIVE only. Owner promotion is required before the gate allows submits.
 */
export class G4Pipeline {
  private readonly config: Required<G4PipelineConfig>;
  private readonly deps: G4PipelineDeps;
  private readonly metrics: G4PipelineMetrics;
  private running = false;
  private stopFn?: () => void;
  private degradedLogged = false;
  /** Previous-pass scores for autonomous per-pass market selection. */
  private readonly scoreMemory = new Map<string, RankedMarket>();
  /**
   * Open exposure per token: venue fill notional, or the reserved limit
   * notional when the ACK has no fill yet. Freed only by settlement.
   */
  private readonly tracker = new PositionTracker();
  /**
   * Shares already folded into session PnL, plus whether this process
   * has snapshotted durable exposure. A cold start restores exposure
   * without replaying historical mark-to-model PnL.
   */
  private readonly exposureBook: ExposureBook = {
    bookedFillShares: new Map(),
    baselined: false,
    sawStep: false,
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

  /**
   * Owner wall for per-pass breadth (default MAX_CONCURRENT_ORDERS).
   * The allocator ranks and defers within this ceiling — never above it.
   */
  maxConcurrentMarkets(): number {
    const k = this.config.maxConcurrentMarkets;
    if (k !== undefined && Number.isFinite(k) && k > 0) {
      return Math.floor(k);
    }
    return AUTONOMY_BOUNDS.MAX_CONCURRENT_ORDERS;
  }

  /** Portfolio cap in USD: explicit cap, else the autonomy default. */
  portfolioCapUsd(): number {
    return this.config.microLiveCapUsd ?? AUTONOMY_BOUNDS.CAPITAL_CAP_USD;
  }

  /**
   * Reclaim settled positions via the settlement feed (best-effort —
   * feed failure never blocks trading; without a feed the tracker only
   * grows and the full-gate below only tightens).
   */
  async syncSettlements(): Promise<void> {
    const list = this.deps.listSettledTokens;
    if (!list) return;
    try {
      const settled = await list();
      if (!Array.isArray(settled) || settled.length === 0) return;
      const { reclaimedUsd, count } = this.tracker.resolve(settled);
      if (count > 0) {
        console.log(
          `💰 Settled ${count} position(s), $${reclaimedUsd.toFixed(2)} freed back to the portfolio.`,
        );
      }
    } catch {
      // feed failure must never break the loop
    }
  }

  /** Current open exposure in USD (fills plus unfilled reserved submits). */
  openExposureUsd(): number {
    return this.tracker.total();
  }

  /**
   * Poll unresolved orders, then replace the tracker from the durable
   * snapshot. A failed or null load leaves the in-memory book in place.
   */
  async syncOpenExposure(): Promise<void> {
    await syncDurableExposure(
      this.deps,
      this.exposureBook,
      this.tracker,
      this.metrics,
    );
  }

  /**
   * Re-read the mode from the DB watcher (hot-reload without restart).
   * Returns true when entries may proceed, false when the loop must skip
   * the pass (READ_ONLY degradation — fail-closed, cancels/reconcile
   * unaffected). Public so operators and tests can drive/inspect it
   * without running the infinite loop. No watcher = always true.
   */
  syncModeFromWatcher(): boolean {
    const w = this.deps.modeWatcher;
    if (!w) return true;
    if (w.isDegraded() || w.getMode() === "READ_ONLY") {
      if (!this.degradedLogged) {
        this.degradedLogged = true;
        console.log(
          "⛔ READ_ONLY — database unreachable, entries halted (fail-closed).",
        );
      }
      return false;
    }
    this.degradedLogged = false;
    const dbMode = w.getMode();
    if (dbMode === this.config.mode) return true;
    const target = dbMode as G4PipelineMode;
    if (!isValidModeTransition(this.config.mode, target)) {
      console.log(
        `⚠️  Refusing live mode jump ${this.config.mode} -> ${dbMode} (DB); staying. Step with \`polyroot mode\`.`,
      );
      return true;
    }
    const from = this.config.mode;
    this.config.mode = target;
    console.log(`🔄 Live mode switch ${from} -> ${dbMode} (no restart needed)`);
    this.deps.observability?.emitModeTransition?.(
      from,
      target,
      "database live_guard_state",
    );
    return true;
  }

  /** Run one iteration of the pipeline for a single market. */
  async processMarket(input: G4PipelineInput): Promise<G4PipelineResult> {
    const tracked = exposureForStep(
      this.tracker,
      input.market_id,
      input.currentPortfolioExposureUsd,
      input.currentMarketExposureUsd,
    );
    const result = await executeG4Step(
      {
        ...input,
        currentPortfolioExposureUsd: tracked.currentPortfolioExposureUsd,
        currentMarketExposureUsd: tracked.currentMarketExposureUsd,
      },
      {
        config: this.config,
        deps: this.deps,
      },
    );

    // Single step-complete emission point: covers every exit path
    // (abstains, gates, fills) exactly once for persistence observers.
    this.deps.observability?.emitStepComplete?.(input, result);

    // Book exposure + session PnL, then publish the snapshot. The loss
    // latch and Kelly bankroll read the shared metrics counter, which
    // only moves when this hook runs.
    accountAfterStep(this.tracker, this.metrics, input.market_id, result);
    if (
      result.orderId &&
      result.fill &&
      Number.isFinite(result.fill.filledSize) &&
      result.fill.filledSize > 0
    ) {
      const prev = this.exposureBook.bookedFillShares.get(result.orderId) ?? 0;
      if (result.fill.filledSize > prev) {
        this.exposureBook.bookedFillShares.set(
          result.orderId,
          result.fill.filledSize,
        );
      }
    }
    this.exposureBook.sawStep = true;
    this.deps.observability?.emitMetrics?.({ ...this.metrics });

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
      this.config.liveAdmission,
    );
  }

  /**
   * Run the pipeline continuously, polling markets at the configured interval.
   * This is the main entry point for autonomous operation.
   */
  async runContinuous(): Promise<void> {
    this.running = true;
    this.deps.modeWatcher?.start();
    console.log(`🔄 G4 Pipeline running in ${this.config.mode} mode...`);

    while (this.running) {
      try {
        // Hot-reload: `polyroot mode X` lands here within one pass.
        // READ_ONLY degradation skips entries until the DB is back.
        if (!this.syncModeFromWatcher()) {
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }
        // Restore durable exposure before the full-book check so a
        // restart cannot treat an open reservation as an empty portfolio.
        // Settlement then drops tokens the resolver already closed.
        await this.syncOpenExposure();
        await this.syncSettlements();
        const cap = this.portfolioCapUsd();
        if (this.tracker.total() >= cap) {
          console.log(
            `🧺 Portfolio full ($${this.tracker.total().toFixed(2)} ≥ $${cap}): skipping pass until settlements free capital.`,
          );
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }
        // Iterate the wired market universe
        const inputs = await buildLoopInputs(this.config, this.deps);
        if (inputs.length === 0) {
          console.log("⏭️  No live markets with prices this pass.");
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }
        const { selected, deferred } = selectMarketsForPass(
          this.scoreMemory,
          inputs.map((i) => i.market_id),
          this.maxConcurrentMarkets(),
          Date.now(),
        );
        if (deferred.length > 0) {
          console.log(
            `⏭️  Portfolio: evaluating ${selected.length}/${inputs.length} top-scored markets, ${deferred.length} deferred to next pass.`,
          );
        }
        // Real per-pass universe report for observers (Telegram stream).
        // Fire-and-forget: observer failure never breaks the pass.
        const byId = new Map(inputs.map((i) => [i.market_id, i] as const));
        try {
          this.deps.onUniversePass?.({
            scanned: inputs.length,
            selected: selected.length,
            deferred: deferred.length,
            mode: this.config.mode,
            evaluated: selected
              .map((id) => {
                const hit = byId.get(id);
                const q = hit?.question;
                const s = hit?.side;
                return {
                  id,
                  question: typeof q === "string" && q.length > 0 ? q : id,
                  ...(s === "YES" || s === "NO" ? { side: s } : {}),
                };
              })
              .slice(0, 5),
          });
        } catch {
          // observability is never load-bearing
        }

        for (const id of selected) {
          const loopInput = byId.get(id);
          if (!loopInput) continue;
          const result = await this.processMarket(loopInput);

          // Learn for the next pass: score every outcome, track fills.
          this.scoreMemory.set(loopInput.market_id, {
            marketId: loopInput.market_id,
            score: scoreOpportunity(result.edge, result.p),
            scoredAtMs: Date.now(),
          });
          // Exposure is booked inside processMarket (fills and unfilled
          // submits). Do not add it again here.

          let funds = undefined as StepFunds | undefined;
          try {
            const f = await this.deps.getFunds?.();
            if (f) funds = f;
          } catch {
            // display-only: omit the funds line rather than break the loop
          }
          console.log(
            formatStepBlock({
              mode: this.config.mode,
              marketId: loopInput.market_id,
              bid: loopInput.bid,
              ask: loopInput.ask,
              p: result.p,
              rationale: this.deps.getReasoning?.(loopInput.market_id)
                ?.rationale,
              decision: result.decision,
              reason: result.reason,
              edge: result.edge,
              fillPrice: result.fill?.fillPrice,
              fillStatus: result.fill?.status,
              size: result.size,
              floorPct:
                resolveEdgeFloor(
                  this.config.minEdgeAfterCost ?? 0.03,
                  Math.abs(loopInput.ask - loopInput.bid),
                ) * 100,
              funds,
            }),
          );

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
    try {
      this.deps.modeWatcher?.stop();
    } catch {
      // timer cleanup must never break shutdown
    }
    console.log("🛑 G4 Pipeline stopping...");
  }
}

/* ─── Factory for creating pipeline with all dependencies ─────────────────── */

export interface CreateG4PipelineOptions extends CreateG4CoreOptions {}

export function createG4Pipeline(options: CreateG4PipelineOptions) {
  const { config, deps } = createG4Core(options);
  return new G4Pipeline(config, deps);
}
