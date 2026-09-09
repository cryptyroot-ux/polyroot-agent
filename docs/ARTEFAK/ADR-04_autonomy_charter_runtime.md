# ADR-04: Autonomy Charter, 24/7 Runtime States, Auto-Recovery/Resume and Hard-Block Governance

**Status:** Accepted
**Date:** 2026-09-09
**Deciders:** Crypty Root (Tech Lead)
**Technical Story:** PR-GOV-03…07, PR-AUT-01…07, PR-OPS-02/03; Blueprint B3

---

## Context

"Autonomous 24/7" means: after one-time commissioning, no human click,
message, confirmation or approval is required for any individual trade or
ordinary recovery (PR-GOV-04). The dashboard is an observability surface, not
a control loop — closing it must not stop qualified trading. At the same
time, no LLM, strategy, plugin or recovered process may ever widen its own
financial authority (PR-GOV-05). These two demands are reconciled by an
immutable charter plus explicit runtime states with deterministic
recovery rules.

## Decision

### 1. Autonomy Charter (PR-GOV-03)

One-time commissioning creates an immutable, versioned `autonomy_charters`
row binding wallet, qualified strategy/version set, market classes, capital
ceiling, loss limits, allowed actions, risk tiers, auto-recovery rules,
effective/expiry/revocation and commissioning proof. With an active charter,
100 eligible intents execute with zero interactive approval; an expired or
superseded charter blocks new risk (T-PR-GOV-03). Owner governance is
exceptional only: commissioning, capital/signer changes, promotion,
emergency stop/revocation, funding/withdrawal, compliance/security recovery —
all authenticated and audited (PR-GOV-07). Governance mutations attempted
from LLM/research processes get 403 + immutable audit event (T-PR-GOV-07).

### 2. Orthogonal states (PRD P3.2, Blueprint B3.2)

Operation mode PAPER/SHADOW/LIVE, runtime health (STOPPED, BOOTSTRAPPING,
RECOVERING, ACTIVE, DEGRADED, PROTECTIVE_PAUSE, ACCESS_BLOCKED,
EMERGENCY_HALT), venue mode (NORMAL, POST_ONLY, CANCEL_ONLY, RESTARTING,
UNAVAILABLE, UNKNOWN) and risk tier (NORMAL, CAUTIOUS, PROTECTIVE) are
independent axes. Mode is not health; venue mode gates which order actions
are legal (action matrix, Blueprint B11.2); tiers only tighten, never loosen
hard caps (PR-AUT-06).

### 3. Supervisor and leases (PR-AUT-01, PR-OPS-02)

A dedicated supervisor, independent of the LLM loop, owns liveness,
schedules and safe restart orchestration. Executor authority is fenced by a
durable `executor_leases` epoch per wallet: a replacement cannot submit
until the previous epoch is invalid and in-flight/unknown obligations are
reconciled — no split-brain orders when two replicas race (T-PR-OPS-02).
Killing any service at randomized boundaries restores it with no duplicate
economic execution (T-PR-AUT-01).

### 4. Auto-recovery and resume (PR-AUT-03, PR-OPS-03)

After transient venue/stream/provider/process/DB faults the system enters
RECOVERING/DEGRADED, reconciles durable state, and resumes automatically
only when deterministic readiness passes. Every startup is RECOVERING until
release/clock/charter/credentials/ledger/orders/trades/balances/unknowns/venue
mode reconcile; old intents are never replayed blindly (T-PR-OPS-03).
Research starvation or provider failure degrades intelligence but never
disables heartbeat, cancellation, reconciliation, risk monitoring or
settlement. Daily-stop latches persist through restart; next-period recovery
resumes at a reduced tier only under preconfigured deterministic criteria
(T-PR-RISK-06).

### 5. Hard blocks stay hard (PR-GOV-06, PR-OPS-02)

Geoblock/access states (BLOCKED, CLOSE_ONLY) are first-class: entries denied,
only platform-permitted reduction attempted, no location bypass
(T-PR-GOV-06). Secret compromise, integrity failure or hard drawdown latch
EMERGENCY_HALT: signing stops, state is preserved, alerts fire, and recovery
requires governance/security workflow because automated self-fix would cross
the authority boundary.

## Consequences

### Positive

- True 24/7 operation: a 24-hour deterministic scenario completes
  entries/exits/reconciliation with no UI session (T-PR-AUT-02).
- Autonomy can never promote itself: policy hash is immutable to the agent.

### Negative

- Supervisor, leases, fencing and recovery drills are substantial
  infrastructure before LIVE.

## Validation

- Kill/restart/outage injection suites (T-PR-AUT-01/03, T-PR-OPS-02/03).
- Charter-expiry and self-weaken-attempt fixtures (T-PR-GOV-03/05).
- Dashboard-disconnect continuation check (T-PR-GOV-04).

## Related

- ADR-03 (permit/lease versions), ADR-05 (tiers/universe), ADR-08 (recovery infra)
- Blueprint B3, B11; PR-GOV-03…07, PR-AUT-01…07, PR-OPS-02/03
