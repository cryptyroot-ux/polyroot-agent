/**
 * @polyroot/executor — Order lifecycle, signing, venue routing
 * Phase 1: Placeholder exports — implementation in Sprint 2+
 */

// Re-export domain types
export type { TradeIntent, RiskDecision, SignedOrder, OrderResult } from "@polyroot/domain";

/** Placeholder for Executor — to be implemented */
export interface Executor {
  process(intent: TradeIntent, decision: RiskDecision): Promise<OrderResult>;
}

/** Placeholder for SignatureRegistry — to be implemented */
export interface SignatureRegistry {
  sign(unsigned: unknown, decision: RiskDecision): Promise<SignedOrder>;
}

/** Placeholder for WalletAdapter — to be implemented */
export interface WalletAdapter {
  sign(payload: Uint8Array): Promise<string>;
  getAddress(): string;
}

/** Placeholder for OrderRouter — to be implemented */
export interface OrderRouter {
  route(order: SignedOrder): Promise<OrderResult>;
}

/** Placeholder for ReconciliationService — to be implemented */
export interface ReconciliationService {
  reconcile(): Promise<void>;
}
