/**
 * @polyroot/control — Control API, owner auth, commands, audit
 * Phase 2: Signal (edge), risk gate, order builder, orchestrator (Sprint 2.5)
 */

// Re-export domain types
import type {
  TradeIntent,
  RiskDecision,
  RiskPolicy,
  Portfolio,
  LedgerEvent,
} from "@polyroot/domain";

export type { TradeIntent, RiskDecision, RiskPolicy, Portfolio, LedgerEvent };

// Signal / edge evaluation
export {
  evaluateEdge,
  type EdgeResult,
  type SignalInput,
  type SignalOpts,
  type SignalSide,
} from "./signal.js";

// Risk gate — policy limits + atomic reservation
export {
  validateAndReserve,
  type RiskGateInput,
  type RiskGateResult,
} from "./risk-gate.js";

// Order builder — clamp inside permit + sign
export {
  buildSignedOrder,
  type OrderBuildInput,
  type OrderBuildResult,
} from "./order-builder.js";

// Orchestrator — signal → risk → build → submit
export {
  orchestrate,
  type OrchestratorDeps,
  type OrchestrateInput,
  type OrchestrateResult,
  type OrchestrateStage,
} from "./orchestrator.js";

/** Placeholder for ControlServer — to be implemented */
export interface ControlServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Placeholder for OwnerAuth — to be implemented */
export interface OwnerAuth {
  verify(apiKey: string): Promise<boolean>;
}

/** Placeholder for CommandHandlers — to be implemented */
export interface CommandHandlers {
  pause(): Promise<void>;
  resume(): Promise<void>;
  updatePolicy(policy: Partial<RiskPolicy>): Promise<void>;
  emergencyStop(): Promise<void>;
}

/** Placeholder for AuditLogger — to be implemented */
export interface AuditLogger {
  log(entry: unknown): Promise<void>;
}
