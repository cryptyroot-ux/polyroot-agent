/**
 * @polyroot/control — Control API, owner auth, commands, audit
 * Phase 1: Placeholder exports — implementation in Sprint 2+
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
