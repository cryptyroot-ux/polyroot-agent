# STATE_MACHINES.md — Canonical state machines (Phase 4)

Date: 2026-09-09 · Baseline: spec pack 124 `PM-*` · Owner: Execution / Ledger

## 1. Order lifecycle (Exec → Venue) — no-blind-retry core

Types in `src/pm/executor/src/index.ts` (`OrderLifecycleState`, `orderLifecycleNext`).

```
        submit     venue ack
NOT_SEEN ──► SUBMITTING ──► ACKNOWLEDGED (LIVE/PARTIAL/MATCHED)
   │            │  │
   │            │  └──(transfer unknown)──► SUBMISSION_UNKNOWN ─ reconciled externally,
   │            │                             NEVER re-enters SUBMITTING blindly
   │            └──(definitive)──► DEFINITIVE_REJECT
   └──(no submit)────────────────► NOT_SEEN stays
```

Invariant (PM-EXE-03, PM-VENUE-06): an infinite `UNKNOWN/SUBMITTING` loop is impossible —
`SUBMISSION_UNKNOWN` never re-submits the same order.

## 2. Intent lifecycle (Strategy → Risk → Exec)

Types: `IntentStatusSchema` (domain).

```
CREATED → VALIDATED → RESERVED → DISPATCHED → (venue submitted)
   │          │          │
   └──────────┴──────────┴──► REJECTED / EXPIRED
```

- `RESERVED` binds reservations (max_qty / max_cash) inside the money kernel.
- `DISPATCHED` consumed the single-use `ExecutionPermitSchema` permit.

## 3. Trade / settlement lifecycle (FT-33, PM-LED-03)

Types: `TradeStatusSchema`, `OrderStatusSchema`.

```
MATCHED → (tx mined) → MINED → (enough confirmations) → CONFIRMED
   │                                       │
   └──(reorg / settlement FAILED)──► FAILED ──► compensating journal entry;
                                               provisional inventory NOT spendable
   MINED ──(confirmations slow)──► RETRYING (bounded, surfaced)
```

Invariant (FT-33): provisional inventory is never spendable until CONFIRMED; a settlement
failure or reorg must land a compensating journal entry.

## 4. Cancel lifecycle (FT-06)

Types: `CancelStatusSchema`.

```
CANCEL_REQUESTED → CANCELED
        │
        └──► CANCEL_UNKNOWN ──(reconcile fill vs cancel)──► resolve
        └──► NOT_CANCELED (definitive)
```

Invariant (FT-06): partial fill arriving with a cancel response reserves both the unsettled
fill and the residual until reconciliation.

## 5. Runtime / protective states (PM-OPS-*, PM-RISK-*)

`RuntimeStateSchema`: `ACTIVE ⇄ DEGRADED`, `RECOVERING`, and protective states are sticky —
`PROTECTIVE_PAUSE`, `ACCESS_BLOCKED`, `EMERGENCY_HALT` never self-bypass. Strictly monotonic
toward halt; recovery requires owner review (PM-GOV-03 mandate sides).

## 6. Enforcement points

| Transition | Guard | ID |
|---|---|---|
| NOT_SEEN → submit | idempotency log (`seen`) + single-use permit + venue-mode gate | PM-EXE-02/03 |
| permit → order | permit covers order in exact base units (`cashNeededFor`, `decimalToBase`) | PM-PROTO-04 |
| any state → spend | TradeStatus must be CONFIRMED; provisional never spendable | PM-LED-03 / FT-33 |
| venue submit/cancel | `venueActionGate` matrix (NORMAL/POST_ONLY submit; READ_ONLY blocks both) | PM-VENUE-01 |

## 7. Verification

- `domain-baseline.test.ts` asserts the canonical enum sets (GOV-02, VENUE-01, WALLET-01).
- `venue-gate.test.ts` asserts the fail-closed action matrix per mode.
- `executor-lifecycle.test.ts` exercises orderLifecycleNext across submit outcomes.
- `money-kernel.test.ts` / `money-kernel-property.test.ts` bundle permit issuance, reservations,
  single-use and exact-arithmetic invariants.