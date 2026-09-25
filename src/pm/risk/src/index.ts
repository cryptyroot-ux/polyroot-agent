/**
 * @polyroot/risk — Risk engine, EV calculation, sizing, reservations
 * Phase 2: Full implementations — no more placeholders
 */

// Re-export domain types
export type {
  TradeIntent,
  RiskDecision,
  RiskPolicy,
  Portfolio,
} from "@polyroot/domain";

// EV Calculator
export {
  EVCalculator,
  evaluateEdge,
  type EVCalculatorInput,
} from "./ev-calculator.js";

// Sizing Engine
export {
  SizingEngine,
  type SizingInput,
  type SizingResult,
  pctToBps,
} from "./sizing-engine.js";

// Reservation Manager
export {
  ReservationManager,
  type ReservationManagerDeps,
  type Reservation,
  isReservationValid,
  startReservationExpiryJob,
} from "./reservation-manager.js";

// Money Kernel (PM-RISK-01..08, Blueprint B9)
export * from "./money-kernel.js";

// PostgreSQL implementations for MoneyKernel ports
export * from "./money-kernel-pg.js";

// Kill switch + reduction paths (PM-RISK-05/06)
export * from "./kill-switch.js";

// Key-compromise response planner (PM-SEC-08)
export * from "./key-compromise.js";

// Loss floors (PM-RISK-03)
export * from "./loss-floor.js";
