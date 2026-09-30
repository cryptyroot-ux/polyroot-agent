/**
 * @polyroot/runtime — G4 micro-LIVE safety harness (PRD G4, Blueprint §8/§13).
 *
 * Micro-LIVE is owner-capped calibration, not a promotion: bounded loss,
 * authenticated venue behavior, and reality-gap coverage must all hold
 * before a single real order is allowed. This module is the pure,
 * unit-testable core of that gate:
 *
 *   1. Loss-cap latch — realized loss vs the owner-set cap. Once breached
 *      the latch STAYS engaged until an explicit owner reset; there is no
 *      timed auto-resume (a restart must never clear a breach). Cancel,
 *      reconcile and monitoring paths are never blocked — only entries.
 *   2. G4 readiness — combines the SHADOW baseline (days + resolved
 *      clusters), the reality-gap verdict, and the loss latch into one
 *      three-state decision: PROMOTE / HOLD / BLOCKED.
 *
 * Pure functions (no I/O): the caller persists the returned latch state.
 */
import { type KillLevel } from "@polyroot/risk";
import { type ShadowCriteria } from "./paper-engine.js";
import { type RealityGapInput, type RealityGapTolerances } from "./reality-gap.js";
export type LossGuardCode = "LOSS_WITHIN_CAP" | "LOSS_CAP_BREACHED" | "LOSS_CAP_LATCHED" | "LOSS_CAP_UNCONFIGURED";
export interface LossGuardState {
    halted: boolean;
    haltedAt?: string | undefined;
    realizedLossPusd: number;
}
export interface LossGuardInput {
    /** Realized loss in pUSD (>= 0). Never a forecast or unrealized value. */
    realizedLossPusd: number;
    /** Owner-set loss cap in pUSD. Must be finite and > 0. */
    lossCapPusd: number;
    /** Explicit owner reset. Clears the latch only if loss is back under cap. */
    reset: boolean;
    /** Previously persisted latch state, or null on first evaluation. */
    previous: LossGuardState | null;
    now?: Date;
}
export interface LossGuardResult {
    halted: boolean;
    /** Kill level to enforce: PAUSE_ENTRIES while halted, NONE otherwise. */
    level: KillLevel;
    code: LossGuardCode;
    reason: string;
    /** Persist this state; the next evaluation must receive it as `previous`. */
    state: LossGuardState;
}
export declare function evaluateLossGuard(input: LossGuardInput): LossGuardResult;
/** Entries follow the kill-switch lattice: halted ⇒ blocked at PAUSE_ENTRIES. */
export declare function microLiveEntriesBlocked(level: KillLevel): boolean;
export type G4Readiness = "PROMOTE" | "HOLD" | "BLOCKED";
export interface G4ReadinessInput {
    observedDays: number;
    resolvedClusters: number;
    criteria: ShadowCriteria;
    gap: RealityGapInput;
    gapTolerances?: RealityGapTolerances;
    loss: Omit<LossGuardInput, "now"> & {
        now?: Date;
    };
}
export interface G4ReadinessResult {
    decision: G4Readiness;
    reasons: string[];
    shadow: {
        passed: boolean;
        reason: string;
    };
    gapVerdict: string;
    lossCode: LossGuardCode;
    lossHalted: boolean;
}
/**
 * Single promotion gate for SHADOW → MICRO_LIVE.
 *
 *   PROMOTE — baseline met, reality gap PASS, loss latch clear.
 *   HOLD    — baseline growing or evidence insufficient (time/data, not a fault).
 *   BLOCKED — reality-gap FAIL or loss latch engaged (a fault that needs action).
 */
export declare function evaluateG4Readiness(input: G4ReadinessInput): G4ReadinessResult;
//# sourceMappingURL=micro-live-guard.d.ts.map