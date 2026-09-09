# ADR-03: Canonical Domain Schemas, Event Ledger, Idempotency, Reservations and State Machines

**Status:** Accepted
**Date:** 2026-09-09
**Deciders:** Crypty Root (Tech Lead)
**Technical Story:** PR-DATA-01, PR-RISK-03, PR-EXE-03, PR-LED-01…07; Blueprint B4, B10.2, B12

---

## Context

Every economic action must be reproducible from market snapshot, evidence,
model/strategy version, policy version, risk decision, order state and ledger
events (PRD P1.1). That requires canonical schemas shared by all planes,
an append-only ledger as the sole financial truth, idempotent intents so a
logical decision can never become two economic orders, and atomic
reservations so capacity accounting survives crashes and timeouts.

## Decision

### 1. Canonical schemas (Blueprint B4)

`@polyroot/domain` owns the canonical Zod contracts: AutonomyCharter,
MarketSnapshot, EvidenceItem, Forecast (+components), StrategyProposal,
TradeIntent, RiskDecision, ExecutionPermit, SignedOrder/OrderResult,
LedgerEvent, Position, Portfolio, RiskPolicy, WalletIdentity, AssetRecord,
GraphEdge. Serialization rule: every persisted/exchanged object carries
`schema_version`; financial decimals are exact (NUMERIC/integer base units,
never float uint256); token/condition IDs are opaque strings; unknown fields
can never expand capabilities.

### 2. Append-only double-entry ledger (PR-LED-01/02/07)

Orders, reservations, fills, fees, rebates, observed transfers, settlement
and corrections produce append-only events/postings balanced per asset;
projections carry `projected_event_seq` and are rebuildable by deletion +
replay (T-PR-LED-03). Venue corrections, failed settlement or reorgs append
compensating events with `correction_of_event_id` — history is never mutated.

### 3. Idempotent intents (PR-EXE-03)

Every logical decision carries a stable `dedupe_key` within
wallet/strategy/decision scope, enforced by
`UNIQUE(wallet_id, dedupe_key)`. Intent, permit, canonical order request and
signed/order hashes are persisted before any ambiguous network side effect.
Repeating one logical request 100 times yields one intent and at most one
active economic order (T-PR-EXE-03).

### 4. Atomic reservation + permit (PR-RISK-03)

Risk check, exact asset reservation, ledger version, policy hash, quote ID
and the short-lived execution permit are written in one short DB
transaction. A timeout-after-submit preserves the reservation (UNKNOWN
retains capacity); crash between reservation and submit recovers to the
correct capacity on restart (T-PR-RISK-03).

### 5. State machines (Blueprint B10.2)

Intent: CREATED → VALIDATED → RESERVED → DISPATCHED | REJECTED | EXPIRED.
Submit: SUBMITTING → ACKNOWLEDGED | SUBMISSION_UNKNOWN | DEFINITIVE_REJECT.
Order (raw + internal): LIVE / PARTIAL / MATCHED / CANCELED / EXPIRED /
REJECTED / UNKNOWN. Cancel: CANCEL_REQUESTED → CANCELED | CANCEL_UNKNOWN |
NOT_CANCELED. Trade: MATCHED → MINED/RETRYING → CONFIRMED | FAILED.
Position: pending → settled → redeemable → redeemed (disputed separate).
Resolution: open → proposed → challenged/disputed → final. Stale events can
never downgrade terminal state or double-post economic effect (T-PR-EXE-06).

## Consequences

### Positive

- Exact replay: identical event streams reproduce identical balances/PnL
  (T-PR-LED-01); rounding/fee property tests preserve asset identity
  (T-PR-LED-02).
- No phantom capacity: uncertainty consumes risk, never creates it
  (PR-RISK-08).

### Negative

- More tables and stricter write paths than a naive orders table; every
  financial write goes through the ledger transaction.

## Validation

- Property tests: replay identity, rounding preservation, reservation
  transitions, idempotency, monotonic lifecycle (T-PR-VAL-02).
- Fault suite: zero duplicate economic execution, zero unexplained drift
  (T-PR-VAL-03).

## Related

- ADR-02 (permits/signer), ADR-04 (charter/policy versions), ADR-07 (sizing)
- Blueprint B4, B10.2, B12; PR-RISK-03, PR-EXE-03/06, PR-LED-01…07
