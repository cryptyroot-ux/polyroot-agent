/**
 * PolyRoot canonical domain contracts — v1.1
 * Sources: PRD v1.1 P8/P9 (96 requirements), Blueprint v1.1 B4 (canonical contracts)
 *
 * Serialization rule (B4): every persisted/exchanged object carries
 * `schema_version`; financial decimals are strings or exact typed values
 * at the boundary; token/condition IDs stay opaque strings; unknown
 * fields must never expand capabilities.
 */
import { z } from "zod";
import { ulid } from "ulid";

/** Current canonical schema version for all domain objects. */
export const SCHEMA_VERSION = "1.0.0" as const;

/**
 * Branded types for type safety
 */
export type Brand<T, B> = T & { __brand: B };
export type ULID = Brand<string, "ULID">;
export type MarketId = Brand<string, "MarketId">;
export type EventId = Brand<string, "EventId">;
export type ConditionId = Brand<string, "ConditionId">;
export type TokenId = Brand<string, "TokenId">;
export type OrderId = Brand<string, "OrderId">;
export type ReservationId = Brand<string, "ReservationId">;
export type EvidenceId = Brand<string, "EvidenceId">;
export type ForecastId = Brand<string, "ForecastId">;
export type IntentId = Brand<string, "IntentId">;
export type ProposalId = Brand<string, "ProposalId">;
export type RiskDecisionId = Brand<string, "RiskDecisionId">;
export type PermitId = Brand<string, "PermitId">;
export type PostingId = Brand<string, "PostingId">;
export type CharterId = Brand<string, "CharterId">;
export type WalletId = Brand<string, "WalletId">;
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

/* ─── Orthogonal state axes (PRD P3.2, Blueprint B3.2) ─── */

/** Operation mode — only LIVE can send financial orders. */
export const OperationModeSchema = z.enum(["PAPER", "SHADOW", "LIVE"]);
export type OperationMode = z.infer<typeof OperationModeSchema>;
/** Backwards-compatible alias used by older scaffolds. */
export const ExecutionModeSchema = OperationModeSchema;
export type ExecutionMode = OperationMode;

/** Runtime health — transient faults may auto-recover; hard blockers never self-bypass. */
export const RuntimeStateSchema = z.enum([
  "STOPPED",
  "BOOTSTRAPPING",
  "RECOVERING",
  "ACTIVE",
  "DEGRADED",
  "PROTECTIVE_PAUSE",
  "ACCESS_BLOCKED",
  "EMERGENCY_HALT",
]);
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

/** Venue mode — controls which order actions are currently legal. */
export const VenueModeSchema = z.enum([
  "NORMAL",
  "POST_ONLY",
  "CANCEL_ONLY",
  "RESTARTING",
  "UNAVAILABLE",
  "UNKNOWN",
]);
export type VenueMode = z.infer<typeof VenueModeSchema>;

/** Risk tier — automatically tightens sizing/universe/order style, never loosens hard caps. */
export const RiskTierSchema = z.enum(["NORMAL", "CAUTIOUS", "PROTECTIVE"]);
export type RiskTier = z.infer<typeof RiskTierSchema>;

/* ─── Lifecycle states (Blueprint B10.2) ─── */

export const IntentStatusSchema = z.enum([
  "CREATED",
  "VALIDATED",
  "RESERVED",
  "DISPATCHED",
  "REJECTED",
  "EXPIRED",
]);
export type IntentStatus = z.infer<typeof IntentStatusSchema>;

export const SubmitStatusSchema = z.enum([
  "SUBMITTING",
  "ACKNOWLEDGED",
  "SUBMISSION_UNKNOWN",
  "DEFINITIVE_REJECT",
]);
export type SubmitStatus = z.infer<typeof SubmitStatusSchema>;

export const OrderStatusSchema = z.enum([
  "LIVE",
  "PARTIAL",
  "MATCHED",
  "CANCELED",
  "EXPIRED",
  "REJECTED",
  "UNKNOWN",
]);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

export const CancelStatusSchema = z.enum([
  "CANCEL_REQUESTED",
  "CANCELED",
  "CANCEL_UNKNOWN",
  "NOT_CANCELED",
]);
export type CancelStatus = z.infer<typeof CancelStatusSchema>;

export const TradeStatusSchema = z.enum([
  "MATCHED",
  "MINED",
  "RETRYING",
  "CONFIRMED",
  "FAILED",
]);
export type TradeStatus = z.infer<typeof TradeStatusSchema>;

export const PositionStatusSchema = z.enum([
  "PENDING",
  "SETTLED",
  "REDEEMABLE",
  "REDEEMED",
  "DISPUTED",
]);
export type PositionStatus = z.infer<typeof PositionStatusSchema>;

export const ResolutionStatusSchema = z.enum([
  "OPEN",
  "PROPOSED",
  "CHALLENGED",
  "DISPUTED",
  "FINAL",
]);
export type ResolutionStatus = z.infer<typeof ResolutionStatusSchema>;

export const IntentPurposeSchema = z.enum([
  "ENTRY",
  "REDUCE",
  "EXIT",
  "REBALANCE",
]);
export type IntentPurpose = z.infer<typeof IntentPurposeSchema>;

/* ─── Wallet / asset taxonomy (PR-WAL-02..06, Blueprint B5) ─── */

export const WalletTypeSchema = z.enum([
  "DEPOSIT_WALLET",
  "EOA",
  "LEGACY_PROXY",
  "SAFE",
  "UNKNOWN",
]);
export type WalletType = z.infer<typeof WalletTypeSchema>;

export const AssetKindSchema = z.enum([
  "PUSD",
  "USDC",
  "USDC_E",
  "OUTCOME_TOKEN",
  "UNKNOWN",
]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

/** Signer / account / funder are distinct verified identifiers (PR-WAL-03). */
export const WalletIdentitySchema = z.object({
  schema_version: z.string().default(SCHEMA_VERSION),
  wallet_id: z.string().ulid(),
  wallet_type: WalletTypeSchema,
  signer_address: z.string().min(1),
  account_wallet: z.string().min(1),
  funder: z.string().min(1),
  chain_id: z.number().int().positive(),
  verified_at: z.date(),
});
export type WalletIdentity = z.infer<typeof WalletIdentitySchema>;

/** Asset registry entry — pUSD, USDC/USDC.e and outcome tokens are distinct (PR-WAL-06). */
export const AssetRecordSchema = z.object({
  schema_version: z.string().default(SCHEMA_VERSION),
  asset_kind: AssetKindSchema,
  chain_id: z.number().int().positive(),
  contract: z.string().min(1),
  decimals: z.number().int().nonnegative(),
  symbol: z.string().min(1),
});
export type AssetRecord = z.infer<typeof AssetRecordSchema>;

/* ─── Autonomy Charter (PR-GOV-03, Blueprint B4) ─── */

/**
 * One-time commissioning artifact. Immutable, versioned. Routine trades
 * never require human approval while a charter is active; an expired or
 * superseded charter blocks new risk.
 */
export const AutonomyCharterSchema = z.object({
  schema_version: z.string().default(SCHEMA_VERSION),
  charter_id: z.string().ulid(),
  wallet_id: z.string().ulid(),
  release_manifest: z.string().min(1),
  policy_version: z.string().min(1),
  policy_hash: z.string().min(1),
  capital_usd_cap: z.number().positive().nullable(),
  strategy_allowlist: z.array(
    z.object({
      strategy: z.string().min(1),
      version: z.string().min(1),
    }),
  ),
  market_class_allowlist: z.array(z.string().min(1)),
  allowed_actions: z.array(z.string().min(1)),
  risk_limits: z.record(z.number()),
  risk_tiers: z.record(z.unknown()),
  auto_recovery_rules: z.record(z.unknown()),
  effective_at: z.date(),
  expires_at: z.date().nullable(),
  revoked_at: z.date().nullable(),
  commissioned_by: z.string().min(1),
  commissioning_proof: z.string().min(1),
});
export type AutonomyCharter = z.infer<typeof AutonomyCharterSchema>;

/* ─── Market data (PR-DATA-01..04, Blueprint B4/B6) ─── */

/** Canonical market snapshot — titles/slugs are lookup aids, never keys. */
export const MarketSnapshotSchema = z.object({
  schema_version: z.string().default(SCHEMA_VERSION),
  event_id: z.string().min(1),
  market_id: z.string().min(1),
  condition_id: z.string().min(1).optional(),
  question_id: z.string().min(1).optional(),
  question: z.string().min(1),
  token_outcome_map: z.record(z.string()).optional(),
  outcomes: z.array(z.string()).optional(),
  chain_id: z.number().int().positive(),
  collateral: z.string().min(1),
  rules_hash: z.string().min(1),
  fee_maker_bps: z.number().int().nonnegative(),
  fee_taker_bps: z.number().int().nonnegative(),
  tick_size: z.number().positive(),
  min_size: z.number().positive(),
  status: z.string().min(1),
  is_neg_risk: z.boolean(),
  venue_mode: VenueModeSchema,
  yes_price: z.number().min(0).max(1).optional(),
  no_price: z.number().min(0).max(1).optional(),
  spread: z.number().nonnegative().optional(),
  quote_hash: z.string().min(1).optional(),
  book_hash: z.string().min(1).optional(),
  graph_node: z.string().min(1).optional(),
  graph_version: z.string().min(1).optional(),
  source_at: z.date(),
  received_at: z.date(),
});
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

/** Market graph edge — native edges are VERIFIED_PLATFORM, inferred edges carry confidence. */
export const GraphEdgeSchema = z.object({
  schema_version: z.string().default(SCHEMA_VERSION),
  from_market_id: z.string().min(1),
  to_market_id: z.string().min(1),
  relation_type: z.enum([
    "NATIVE_NEG_RISK",
    "NATIVE_EVENT_MEMBER",
    "COMPLEMENT",
    "MUTUALLY_EXCLUSIVE",
    "SUBSET",
    "SUPERSET",
    "CONDITIONAL",
    "TEMPORAL_DEPENDENCY",
    "SHARED_RESOLUTION_SOURCE",
    "CORRELATED",
  ]),
  trust_level: z.enum(["VERIFIED_PLATFORM", "VERIFIED_RULES", "INFERRED"]),
  confidence: z.number().min(0).max(1).optional(),
  provenance: z.string().min(1),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/* ─── Evidence & forecast (PR-INT-01..08, Blueprint B7) ─── */

/** Evidence claim — external content is data only, never instruction. */
export const EvidenceItemSchema = z.object({
  schema_version: z.string().default(SCHEMA_VERSION),
  id: z.string().ulid(),
  source_url: z.string().min(1).optional(),
  publisher: z.string().min(1).optional(),
  source_family: z.string().min(1).optional(),
  authority: z.string().min(1).optional(),
  published_at: z.date().optional(),
  fetched_at: z.date(),
  available_at: z.date(),
  content_hash: z.string().min(1),
  claim: z.string().min(1).optional(),
  facts: z.unknown().optional(),
  relevance: z.number().min(0).max(1).optional(),
  rights_policy: z.string().min(1).optional(),
  retention_policy: z.string().min(1).optional(),
  untrusted: z.boolean().default(true),
  /** Backwards-compatible aliases for older scaffolds. */
  type: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  timestamp: z.date().optional(),
  payload: z.unknown().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

/** Single ensemble component forecast. */
export const ForecastComponentSchema = z.object({
  component: z.string().min(1),
  p_raw: z.number().min(0).max(1),
  weight: z.number().min(0).max(1).optional(),
  lineage: z.record(z.unknown()).optional(),
});
export type ForecastComponent = z.infer<typeof ForecastComponentSchema>;

/** Structured probabilistic forecast with lineage and abstention. */
export const ForecastSchema = z.object({
  schema_version: z.string().default(SCHEMA_VERSION),
  forecast_id: z.string().ulid(),
  /** Backwards-compatible alias. */
  id: z.string().ulid().optional(),
  market_id: z.string().min(1),
  rules_version: z.string().min(1).optional(),
  graph_version: z.string().min(1).optional(),
  components: z.array(ForecastComponentSchema).optional(),
  p_raw: z.number().min(0).max(1).optional(),
  p_calibrated: z.number().min(0).max(1).optional(),
  p_conservative: z.number().min(0).max(1).optional(),
  /** Backwards-compatible aliases. */
  probability_yes: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence_ids: z.array(z.string()).default([]),
  counterevidence_ids: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  invalidators: z.array(z.string()).default([]),
  horizon_sec: z.number().positive(),
  valid_until: z.date(),
  lineage: z.record(z.unknown()).optional(),
  abstain_reason: z.string().nullable().optional(),
  model: z.string().min(1).optional(),
  features: z.record(z.number()).optional(),
  created_at: z.date(),
});
export type Forecast = z.infer<typeof ForecastSchema>;

/* ─── Strategy & intent (PR-STR-01..08, Blueprint B8) ─── */

/** Strategy proposal — proposal only, never a financial effect. */
export const StrategyProposalSchema = z.object({
  schema_version: z.string().default(SCHEMA_VERSION),
  proposal_id: z.string().ulid(),
  strategy: z.string().min(1),
  strategy_version: z.string().min(1),
  strategy_params: z.record(z.unknown()).optional(),
  forecast_refs: z.array(z.string()).default([]),
  graph_refs: z.array(z.string()).default([]),
  target_exposure: z.unknown().optional(),
  entry_thesis: z.string().min(1).optional(),
  exit_thesis: z.string().min(1).optional(),
  cost_assumptions: z.record(z.unknown()).optional(),
  expected_edge_distribution: z.record(z.unknown()).optional(),
  expires_at: z.date(),
  reason_code: z.string().min(1).optional(),
  no_trade_code: z.string().min(1).optional(),
});
export type StrategyProposal = z.infer<typeof StrategyProposalSchema>;

/** Trade intent — durable, idempotent, credential-free. */
export const TradeIntentSchema = z.object({
  schema_version: z.string().default(SCHEMA_VERSION),
  intent_id: z.string().ulid(),
  dedupe_key: z.string().min(1),
  purpose: IntentPurposeSchema,
  market_id: z.string().min(1),
  token_id: z.string().min(1).optional(),
  side: z.enum(["YES", "NO", "BUY", "SELL"]),
  desired_qty: z.number().positive().optional(),
  desired_notional: z.number().positive().optional(),
  limit_price: z.number().min(0).max(1).optional(),
  deadline: z.date().optional(),
  quote_ref: z.string().min(1).optional(),
  rules_ref: z.string().min(1).optional(),
  policy_ref: z.string().min(1).optional(),
  strategy_ref: z.string().min(1).optional(),
  forecast_refs: z.array(z.string()).default([]),
  evidence_ids: z.array(z.string()).default([]),
  status: IntentStatusSchema.default("CREATED"),
  /** Backwards-compatible aliases for older scaffolds. */
  id: z.string().ulid().optional(),
  price: z.number().min(0).max(1).optional(),
  size: z.number().positive().optional(),
  order_type: z.enum(["LIMIT", "POST_ONLY", "FOK", "IOC"]).optional(),
  expiration_sec: z.number().positive().optional(),
  forecast_id: z.string().optional(),
  strategy: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  created_at: z.date(),
});
export type TradeIntent = z.infer<typeof TradeIntentSchema>;

/* ─── Money kernel (PR-RISK-01..08, Blueprint B9) ─── */

/** Risk engine decision on an intent. */
export const RiskDecisionSchema = z.object({
  schema_version: z.string().default(SCHEMA_VERSION),
  decision_id: z.string().ulid(),
  intent_id: z.string().ulid(),
  status: z.enum(["ACCEPTED", "REJECTED", "MODIFIED"]),
  reservation_ids: z.array(z.string()).default([]),
  /** Backwards-compatible single-reservation alias. */
  reservation_id: z.string().optional(),
  max_qty: z.number().nonnegative().optional(),
  max_cash: z.number().nonnegative().optional(),
  allowed_size: z.number().nonnegative().optional(),
  allowed_price_min: z.number().min(0).max(1).optional(),
  allowed_price_max: z.number().min(0).max(1).optional(),
  allowed_order_style: z.array(z.string()).default([]),
  venue_mode: VenueModeSchema.optional(),
  ledger_version: z.string().min(1).optional(),
  policy_version: z.string().min(1).optional(),
  quote_version: z.string().min(1).optional(),
  lease_version: z.string().min(1).optional(),
  rejection_reason: z.string().optional(),
  reason_codes: z.array(z.string()).default([]),
  risk_metrics: z
    .object({
      ev_per_share: z.number().optional(),
      edge_after_fees: z.number().optional(),
      portfolio_impact: z.number().optional(),
      market_impact: z.number().optional(),
    })
    .optional(),
  decided_at: z.date(),
  /** Backwards-compatible alias. */
  id: z.string().ulid().optional(),
});
export type RiskDecision = z.infer<typeof RiskDecisionSchema>;

/** Short-lived execution permit — atomic with the reservation (PR-RISK-03). */
export const ExecutionPermitSchema = z.object({
  schema_version: z.string().default(SCHEMA_VERSION),
  permit_id: z.string().ulid(),
  decision_id: z.string().ulid(),
  intent_id: z.string().ulid(),
  ledger_version: z.string().min(1),
  policy_version: z.string().min(1),
  policy_hash: z.string().min(1),
  quote_id: z.string().min(1),
  lease_epoch: z.number().int().nonnegative(),
  reservation_ids: z.array(z.string().min(1)),
  max_qty: z.number().nonnegative(),
  max_cash: z.number().nonnegative(),
  allowed_order_style: z.array(z.string().min(1)),
  venue_mode: VenueModeSchema,
  issued_at: z.date(),
  expires_at: z.date(),
  single_use: z.boolean().default(true),
  used_at: z.date().nullable().optional(),
});
export type ExecutionPermit = z.infer<typeof ExecutionPermitSchema>;

/* ─── Execution (PR-EXE-01..08, Blueprint B10/B11) ─── */

/** Signed order ready for venue submission. */
export const SignedOrderSchema = z.object({
  schema_version: z.string().default(SCHEMA_VERSION),
  order_id: z.string().ulid(),
  market_id: z.string().min(1),
  side: z.enum(["BUY", "SELL"]),
  price: z.number().min(0).max(1),
  size: z.number().positive(),
  fee_rate_bps: z.number().int().nonnegative(),
  nonce: z.number().int().nonnegative().optional(),
  expiration: z.number().int().positive().optional(),
  signature: z.string().min(1),
  signer: z.string().min(1),
  signed_at: z.date(),
  decision_id: z.string().min(1).optional(),
  permit_id: z.string().min(1).optional(),
  /** Backwards-compatible alias. */
  risk_decision_id: z.string().optional(),
});
export type SignedOrder = z.infer<typeof SignedOrderSchema>;

/** Venue order result — ACK is not a fill. */
export const OrderResultSchema = z.object({
  schema_version: z.string().default(SCHEMA_VERSION).optional(),
  success: z.boolean(),
  submit_status: SubmitStatusSchema.optional(),
  order_status: OrderStatusSchema.optional(),
  order_id: z.string().optional(),
  venue_order_id: z.string().optional(),
  transaction_hash: z.string().optional(),
  filled_size: z.number().nonnegative().optional(),
  average_price: z.number().min(0).max(1).optional(),
  fee_paid: z.number().nonnegative().optional(),
  rebate_earned: z.number().nonnegative().optional(),
  maker_taker: z.enum(["MAKER", "TAKER", "UNKNOWN"]).optional(),
  error: z.string().optional(),
  timestamp: z.date(),
});
export type OrderResult = z.infer<typeof OrderResultSchema>;

/* ─── Ledger (PR-LED-01..08, Blueprint B12) ─── */

/** Ledger event types — append-only, never mutated. */
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
  "CORRECTION",
  "EXTERNAL_ACTIVITY",
  "SETTLEMENT",
  "REDEEM",
]);
export type LedgerEventType = z.infer<typeof LedgerEventTypeSchema>;

export const LedgerEventSchema = z.object({
  schema_version: z.string().default(SCHEMA_VERSION),
  id: z.string().ulid(),
  type: LedgerEventTypeSchema,
  aggregate_id: z.string().min(1),
  aggregate_type: z.enum([
    "Intent",
    "Reservation",
    "Order",
    "Position",
    "Portfolio",
    "Wallet",
    "Experiment",
  ]),
  payload: z.unknown(),
  correction_of_event_id: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
  timestamp: z.date(),
});
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

/** Portfolio position — pending exposure consumes risk before it is sellable. */
export const PositionSchema = z.object({
  schema_version: z.string().default(SCHEMA_VERSION).optional(),
  market_id: z.string().min(1),
  event_id: z.string().min(1).optional(),
  side: z.enum(["YES", "NO"]),
  size: z.number(),
  avg_price: z.number().min(0).max(1).optional(),
  status: PositionStatusSchema.optional(),
  unrealized_pnl: z.number().optional(),
  realized_pnl: z.number().optional(),
  projected_event_seq: z.number().int().nonnegative().optional(),
  updated_at: z.date(),
});
export type Position = z.infer<typeof PositionSchema>;

/** Portfolio summary */
export const PortfolioSchema = z.object({
  schema_version: z.string().default(SCHEMA_VERSION).optional(),
  total_value: z.number().nonnegative(),
  cash: z.number().nonnegative(),
  positions_value: z.number().nonnegative(),
  unrealized_pnl: z.number(),
  realized_pnl_24h: z.number(),
  daily_loss: z.number(),
  drawdown: z.number(),
  updated_at: z.date(),
});
export type Portfolio = z.infer<typeof PortfolioSchema>;

/* ─── Risk policy (PRD P8 — 17 design-default parameters) ─── */

/**
 * Risk policy — owner-commissioned, versioned, immutable per version.
 * Values below are conservative engineering starting points, not advice.
 * `capital_usd_cap` null blocks LIVE until the owner commissions a value.
 */
export const RiskPolicySchema = z.object({
  schema_version: z.string().default(SCHEMA_VERSION),
  policy_version: z.string().min(1),
  execution_mode: OperationModeSchema.default("PAPER"),
  capital_usd_cap: z.number().positive().nullable(),
  max_order_pct: z.number().min(0).max(1),
  max_market_pct: z.number().min(0).max(1),
  max_event_group_pct: z.number().min(0).max(1),
  max_portfolio_pct: z.number().min(0).max(1),
  daily_loss_stop_pct: z.number().min(0).max(1),
  drawdown_stop_pct: z.number().min(0).max(1),
  max_open_orders: z.number().int().positive(),
  min_edge_after_cost: z.number().min(0),
  book_max_age_ms: z.number().int().positive(),
  metadata_max_age_s: z.number().int().positive(),
  forecast_max_age_s: z.number().int().positive(),
  clock_skew_max_ms: z.number().int().positive(),
  max_slippage_abs: z.number().min(0),
  intent_ttl_s: z.number().int().positive(),
  risk_permit_ttl_ms: z.number().int().positive(),
  reconcile_interval_s: z.number().int().positive(),
  /** Backwards-compatible aliases for older scaffolds. */
  order_cap_share: z.number().min(0).max(1).optional(),
  market_cap_share: z.number().min(0).max(1).optional(),
  event_group_cap_share: z.number().min(0).max(1).optional(),
  portfolio_cap_share: z.number().min(0).max(1).optional(),
  daily_loss_stop_share: z.number().min(0).max(1).optional(),
  drawdown_stop_share: z.number().min(0).max(1).optional(),
  min_edge_per_share: z.number().min(0).optional(),
  max_order_size: z.number().positive().optional(),
  allowed_markets: z.array(z.string()).optional(),
  blocked_markets: z.array(z.string()).optional(),
});
export type RiskPolicy = z.infer<typeof RiskPolicySchema>;

/** Default risk policy (conservative placeholders — owner must commission). */
export const DEFAULT_RISK_POLICY: RiskPolicy = {
  schema_version: SCHEMA_VERSION,
  policy_version: "v0-bootstrap",
  execution_mode: "PAPER",
  capital_usd_cap: null,
  max_order_pct: 0.005,
  max_market_pct: 0.02,
  max_event_group_pct: 0.05,
  max_portfolio_pct: 0.1,
  daily_loss_stop_pct: 0.02,
  drawdown_stop_pct: 0.05,
  max_open_orders: 10,
  min_edge_after_cost: 0.03,
  book_max_age_ms: 2000,
  metadata_max_age_s: 60,
  forecast_max_age_s: 900,
  clock_skew_max_ms: 1000,
  max_slippage_abs: 0.01,
  intent_ttl_s: 30,
  risk_permit_ttl_ms: 1000,
  reconcile_interval_s: 15,
};

export { z };
