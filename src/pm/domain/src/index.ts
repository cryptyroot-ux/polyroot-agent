import { z } from "zod";
import { ulid } from "ulid";

/**
 * Branded types for type safety
 */
export type Brand<T, B> = T & { __brand: B };
export type ULID = Brand<string, "ULID">;
export type MarketId = Brand<string, "MarketId">;
export type EventId = Brand<string, "EventId">;
export type OrderId = Brand<string, "OrderId">;
export type ReservationId = Brand<string, "ReservationId">;
export type EvidenceId = Brand<string, "EvidenceId">;
export type ForecastId = Brand<string, "ForecastId">;
export type IntentId = Brand<string, "IntentId">;
export type RiskDecisionId = Brand<string, "RiskDecisionId">;
export type PostingId = Brand<string, "PostingId">;
export type WalletAddress = Brand<string, "WalletAddress">;

/**
 * ULID generator
 */
export function generateId<T extends string>(): Brand<string, T> {
  return ulid() as Brand<string, T>;
}

/**
 * Timestamp helpers
 */
export const now = () => new Date();
export const nowMs = () => Date.now();
export const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Core domain entities
 */

/** Evidence item fed to the intelligence layer */
export const EvidenceItemSchema = z.object({
  id: z.string().ulid(),
  type: z.enum(["market_snapshot", "news", "onchain", "social", "technical", "funding"]),
  source: z.string().min(1),
  timestamp: z.date(),
  payload: z.unknown(),
  metadata: z.record(z.unknown()).optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

/** Market snapshot from the data adapter */
export const MarketSnapshotSchema = z.object({
  marketId: z.string(),
  eventId: z.string(),
  question: z.string(),
  outcomes: z.array(z.string()),
  yesPrice: z.number().min(0).max(1),
  noPrice: z.number().min(0).max(1),
  yesSize: z.number().nonnegative(),
  noSize: z.number().nonnegative(),
  spread: z.number().nonnegative(),
  volume24h: z.number().nonnegative(),
  openInterest: z.number().nonnegative(),
  lastTradePrice: z.number().min(0).max(1).optional(),
  lastTradeTime: z.date().optional(),
  feeMakerBps: z.number().int().nonnegative(),
  feeTakerBps: z.number().int().nonnegative(),
  isNegRisk: z.boolean(),
  timestamp: z.date(),
});
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

/** Forecast produced by intelligence layer */
export const ForecastSchema = z.object({
  id: z.string().ulid(),
  marketId: z.string(),
  horizonSec: z.number().positive(),
  probabilityYes: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  model: z.string(),
  features: z.record(z.number()),
  evidenceIds: z.array(z.string().ulid()),
  createdAt: z.date(),
});
export type Forecast = z.infer<typeof ForecastSchema>;

/** Trade intent proposed by strategy/intelligence */
export const TradeIntentSchema = z.object({
  id: z.string().ulid(),
  marketId: z.string(),
  side: z.enum(["YES", "NO"]),
  price: z.number().min(0).max(1),
  size: z.number().positive(),
  orderType: z.enum(["LIMIT", "POST_ONLY", "FOK", "IOC"]),
  expirationSec: z.number().positive(),
  forecastId: z.string().ulid(),
  evidenceIds: z.array(z.string().ulid()),
  strategy: z.string(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.date(),
});
export type TradeIntent = z.infer<typeof TradeIntentSchema>;

/** Risk engine decision on an intent */
export const RiskDecisionSchema = z.object({
  id: z.string().ulid(),
  intentId: z.string().ulid(),
  status: z.enum(["ACCEPTED", "REJECTED", "MODIFIED"]),
  reservationId: z.string().ulid().optional(),
  allowedSize: z.number().nonnegative().optional(),
  allowedPriceMin: z.number().min(0).max(1).optional(),
  allowedPriceMax: z.number().min(0).max(1).optional(),
  rejectionReason: z.string().optional(),
  riskMetrics: z.object({
    evPerShare: z.number(),
    edgeAfterFees: z.number(),
    portfolioImpact: z.number(),
    marketImpact: z.number(),
  }).optional(),
  decidedAt: z.date(),
});
export type RiskDecision = z.infer<typeof RiskDecisionSchema>;

/** Signed order ready for venue submission */
export const SignedOrderSchema = z.object({
  orderId: z.string().ulid(),
  marketId: z.string(),
  side: z.enum(["BUY", "SELL"]),
  price: z.number().min(0).max(1),
  size: z.number().positive(),
  feeRateBps: z.number().int().nonnegative(),
  nonce: z.number().int().nonnegative(),
  expiration: z.number().int().positive(),
  signature: z.string(),
  signer: z.string(),
  signedAt: z.date(),
  riskDecisionId: z.string().ulid(),
});
export type SignedOrder = z.infer<typeof SignedOrderSchema>;

/** Venue order result */
export const OrderResultSchema = z.object({
  success: z.boolean(),
  orderId: z.string().optional(),
  transactionHash: z.string().optional(),
  filledSize: z.number().nonnegative().optional(),
  averagePrice: z.number().min(0).max(1).optional(),
  error: z.string().optional(),
  timestamp: z.date(),
});
export type OrderResult = z.infer<typeof OrderResultSchema>;

/** Ledger event types */
export const LedgerEventTypeSchema = z.enum([
  "INTENT_PROPOSED",
  "RISK_DECISION",
  "RESERVATION_CREATED",
  "RESERVATION_RELEASED",
  "ORDER_SIGNED",
  "ORDER_SUBMITTED",
  "ORDER_FILLED",
  "ORDER_PARTIAL",
  "ORDER_CANCELLED",
  "ORDER_REJECTED",
  "ORDER_EXPIRED",
  "FUNDS_TRANSFERRED",
  "POSITION_UPDATED",
  "PNL_REALIZED",
]);
export type LedgerEventType = z.infer<typeof LedgerEventTypeSchema>;

export const LedgerEventSchema = z.object({
  id: z.string().ulid(),
  type: LedgerEventTypeSchema,
  aggregateId: z.string().ulid(),
  aggregateType: z.enum(["Intent", "Reservation", "Order", "Position", "Portfolio"]),
  payload: z.unknown(),
  metadata: z.record(z.unknown()).optional(),
  timestamp: z.date(),
});
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

/** Portfolio position */
export const PositionSchema = z.object({
  marketId: z.string(),
  eventId: z.string(),
  side: z.enum(["YES", "NO"]),
  size: z.number(),
  avgPrice: z.number().min(0).max(1),
  unrealizedPnl: z.number(),
  realizedPnl: z.number(),
  updatedAt: z.date(),
});
export type Position = z.infer<typeof PositionSchema>;

/** Portfolio summary */
export const PortfolioSchema = z.object({
  totalValue: z.number().nonnegative(),
  cash: z.number().nonnegative(),
  positionsValue: z.number().nonnegative(),
  unrealizedPnl: z.number(),
  realizedPnl24h: z.number(),
  dailyLoss: z.number(),
  drawdown: z.number(),
  updatedAt: z.date(),
});
export type Portfolio = z.infer<typeof PortfolioSchema>;

/** Risk policy configuration (owner-set, not code) */
export const RiskPolicySchema = z.object({
  orderCapShare: z.number().min(0).max(1),
  marketCapShare: z.number().min(0).max(1),
  eventGroupCapShare: z.number().min(0).max(1),
  portfolioCapShare: z.number().min(0).max(1),
  dailyLossStopShare: z.number().min(0).max(1),
  drawdownStopShare: z.number().min(0).max(1),
  minEdgePerShare: z.number().min(0),
  maxOrderSize: z.number().positive().optional(),
  maxOpenOrders: z.number().int().positive().optional(),
  allowedMarkets: z.array(z.string()).optional(),
  blockedMarkets: z.array(z.string()).optional(),
});
export type RiskPolicy = z.infer<typeof RiskPolicySchema>;

/** Mode enum */
export const ExecutionModeSchema = z.enum(["PAPER", "SHADOW", "LIVE"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

/** Default risk policy (conservative placeholders — must be set by owner) */
export const DEFAULT_RISK_POLICY: RiskPolicy = {
  orderCapShare: 0.005,       // 0.5%
  marketCapShare: 0.02,       // 2%
  eventGroupCapShare: 0.05,   // 5%
  portfolioCapShare: 0.10,    // 10%
  dailyLossStopShare: 0.02,   // 2%
  drawdownStopShare: 0.05,    // 5%
  minEdgePerShare: 0.03,      // $0.03/share
};

export { z };