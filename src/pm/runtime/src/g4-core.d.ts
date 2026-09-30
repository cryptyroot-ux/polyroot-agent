import type { Forecast, RiskPolicy, VenueMode, WalletIdentity } from "@polyroot/domain";
import type { MoneyKernel } from "@polyroot/risk";
import type { SignerVault } from "@polyroot/signer";
import type { Executor } from "@polyroot/executor";
import { type LossGuardState } from "./micro-live-guard.js";
import { type LiveMarketInput, type MarketSource } from "@polyroot/venue";
export type G4Mode = "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE";
export interface G4CoreConfig {
    mode: G4Mode;
    /** Explicit capital cap for MICRO_LIVE (USD). Required for MICRO_LIVE. */
    microLiveCapUsd?: number;
    /** SHADOW baseline criteria (minimum days & resolved clusters). */
    shadowCriteria?: {
        minDays: number;
        minResolvedClusters: number;
    };
    /** PAPER simulator configuration. */
    paperFillConfig?: {
        cancelProbability: number;
        partialFraction: number;
        latencyMs: number;
    };
    /** Microlive explicit cap (base units). */
    microLiveCapBase?: bigint;
    /**
     * Owner loss cap in pUSD for MICRO_LIVE/LIVE. REQUIRED in live modes:
     * the order path refuses to submit without a finite positive cap.
     */
    liveLossCapPusd?: number;
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
    forecast: (market: {
        market_id: string;
        bid: number;
        ask: number;
    }) => Promise<number | null>;
    /** Strategy: produces intent from forecast + market. */
    sizeIntent: (market: {
        market_id: string;
        bid: number;
        ask: number;
    }, p: number) => number;
    /** Money Kernel for reservations & permits. */
    kernel: MoneyKernel;
    /** Signer Vault for signing orders. */
    signer: SignerVault;
    /** Executor for submitting orders. */
    executor: Executor;
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
    /** Observability hooks for metrics and logging */
    observability?: G4CoreObservability;
    /**
     * Live enforcement dependencies (MICRO_LIVE/LIVE only). REQUIRED in live
     * modes: without a wired guard the order path refuses to submit.
     */
    liveGuard?: LiveGuardDeps;
    /**
     * Live market source (SHADOW and live modes). REQUIRED outside PAPER:
     * loops refuse to run on mock data when real money or live reads are
     * configured.
     */
    marketSource?: MarketSource;
}
/**
 * Live enforcement inputs: durable loss latch + realized-loss reader.
 * Production wiring uses PgLiveGuardStore; tests inject fakes.
 */
export interface LiveGuardDeps {
    loadLatch(): Promise<LossGuardState | null>;
    saveLatch(state: LossGuardState): Promise<void>;
    realizedLossPusd(): number | Promise<number>;
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
    /** AI thinking, surfaced so operators see the LLM working, not just outcomes. */
    edge?: number | undefined;
    bookBid?: number | undefined;
    bookAsk?: number | undefined;
}
/** One-line rendering of the AI's thinking for operator logs. */
export declare function formatAiLine(result: {
    p?: number | undefined;
    edge?: number | undefined;
    bookBid?: number | undefined;
    bookAsk?: number | undefined;
}): string;
export interface G4CoreObservability {
    emitStepStart?(input: G4CoreInput, mode: G4Mode): void;
    emitStepComplete?(input: G4CoreInput, result: G4CoreResult): void;
    emitFinancialGate?(gate: "ALLOW" | "ENTRY_BLOCKED" | "FINANCIAL_BLOCKED", mode: G4Mode, venue: VenueMode): void;
    emitError?(error: Error, context: unknown): void;
    emitMetrics?(metrics: G4CoreMetrics): void;
    emitModeTransition?(from: G4Mode, to: G4Mode, reason: string): void;
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
/** Paper-fill simulator overrides passed to each G4 step (subset of FillModelInput). */
export interface G4FillSimulatorConfig {
    cancelProbability: number;
    partialFraction: number;
    latencyMs: number;
    makerFeeBps: number;
    takerFeeBps: number;
}
export interface CreateG4CoreOptions {
    config: G4CoreConfig;
    kernel: MoneyKernel;
    signer: SignerVault;
    executor: Executor;
    wallet: WalletIdentity;
    policy: RiskPolicy;
    policyHash: string;
    venueMode: () => VenueMode;
    leaseEpoch: () => number;
    now: () => Date;
    forecast: (market: {
        market_id: string;
        bid: number;
        ask: number;
    }) => Promise<number | null>;
    sizeIntent: (market: {
        market_id: string;
        bid: number;
        ask: number;
    }, p: number) => number;
    observability?: G4CoreObservability;
    liveGuard?: LiveGuardDeps;
    marketSource?: MarketSource;
}
export declare function createG4Core(options: CreateG4CoreOptions): {
    config: G4CoreConfig;
    deps: G4CoreDeps;
};
export declare const G4_MODE_TRANSITIONS: Record<G4Mode, G4Mode[]>;
export declare function isValidModeTransition(current: G4Mode, target: G4Mode): boolean;
export declare function getDefaultModeConfig(mode: G4Mode, baseConfig: Partial<G4CoreConfig>): G4CoreConfig;
export declare function computeFinancialGate(mode: G4Mode, venueMode: () => VenueMode, minEdgeAfterCost?: number): "ALLOW" | "ENTRY_BLOCKED" | "FINANCIAL_BLOCKED";
/**
 * Build one loop pass of market inputs. PAPER uses the mock fixture;
 * every other mode REQUIRES a wired market source and NEVER falls back
 * to mock data (a live-configured loop on mock markets would fabricate
 * decisions).
 */
export declare function buildLoopInputs(config: Pick<G4CoreConfig, "mode">, deps: Pick<G4CoreDeps, "marketSource">): Promise<LiveMarketInput[]>;
export declare function executeG4Step(input: G4CoreInput, core: {
    config: G4CoreConfig;
    deps: G4CoreDeps;
}, paperFillConfig: G4FillSimulatorConfig): Promise<G4CoreResult>;
//# sourceMappingURL=g4-core.d.ts.map