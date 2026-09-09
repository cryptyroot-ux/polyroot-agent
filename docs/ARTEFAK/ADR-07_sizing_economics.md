# ADR-07: Position Sizing/Economics, Fee/Rebate Treatment, Risk Tiers and Exit/Reallocation Utility

**Status:** Accepted
**Date:** 2026-09-09
**Deciders:** Crypty Root (Tech Lead)
**Technical Story:** PR-RISK-01/04/05/06, PR-LED-06, PR-STR-07; Blueprint B9

---

## Context

Gross edge evaporates after execution economics: category-dependent taker
fees, dynamic maker/taker rebates, slippage, latency and AI/data/infra
costs. Upstream's dynamic Kelly maps edge to a probability proxy, consumes
an arbitrary confidence input and can boost size after win streaks
(S07) — recent wins are not new information about the current event. And a
position held too long decays: the system must continuously compare holding
against exiting or reallocating, not wait for resolution or a human.

## Decision

### 1. Net economic EV (Blueprint B9.1, PR-LED-06)

Net EV = expected payout − executable cash debit − taker fee −
adverse-selection/slippage/latency cost − allocated AI/data/infra cost +
conservatively eligible rebates. Rules: never hardcode rebate tables as
durable alpha — query/version fee/rebate parameters where available,
otherwise assume no rebate pre-trade and record realized payments later;
VWAP already incorporates depth, so the same slippage component is never
double-counted; assumptions are explicit and tested against micro-LIVE
(T-PR-EXE-08). Trading PnL and net economic PnL are reported separately;
deposits/withdrawals are cash flows, never profit.

### 2. Robust position sizer (PR-RISK-04)

The sizer derives a suggested amount from the calibrated actionable
probability/payoff distribution and market liquidity, then applies, in
order: optional bounded fractional Kelly only after empirical validation,
strategy cap, graph-aware market/event/correlation caps, portfolio cap, loss
tier and exact reservation. Hard caps and liquidity are final. No
win-streak boost, no verbal-confidence sizing (T-PR-RISK-04). If the safe
size falls below venue `min_size`, the system abstains instead of rounding
up (T-PR-RISK-05); executable VWAP/depth, spread, tick/min-size, slippage
and quote age are validated and quantities rounded down (PR-RISK-05).

### 3. Hierarchical caps with unknowns (PR-RISK-01/08)

Caps apply per order, token/market, native event/negative-risk group,
inferred correlation cluster, strategy and portfolio — covering positions,
resting orders, reservations and unknown/pending obligations. Parallel
intents that jointly breach a cap reserve at most the safe subset
(T-PR-RISK-01). SUBMISSION_UNKNOWN, CANCEL_UNKNOWN, pending settlement and
external/manual trades consume capacity until reconciled; uncertainty never
recreates capacity (T-PR-RISK-08). Cancel failure never falsely frees shares
(T-PR-RISK-07).

### 4. Tiers and loss latches (PR-AUT-06, PR-RISK-06)

NORMAL/CAUTIOUS/PROTECTIVE tiers automatically reduce sizing, universe and
order style under uncertainty, drawdown, degraded liquidity or repeated
faults; recovery follows only preconfigured auditable criteria
(T-PR-AUT-06). Daily-loss and drawdown breaches latch preconfigured
protective behavior; auto-resume is allowed only under charter-defined
cooldown/reconciliation/reduced-risk rules (T-PR-RISK-06).

### 5. Exit and reallocation engine (PR-STR-07)

The engine continuously compares HOLD vs EXIT/REDUCE vs REALLOCATE expected
value using current bid/depth, remaining payout, uncertainty,
time-to-resolution, fees, liquidity and portfolio opportunity cost. A
position with deteriorated hold EV exits or reduces without waiting for
human approval or market resolution (T-PR-STR-07). Kill-switch actions are
distinct: PAUSE_ENTRIES, CANCEL_OPEN, FLATTEN/REDUCE — SELL uses only
verified available shares, with no leverage, naked short or assumed
native reduce-only behavior (PR-RISK-07).

## Consequences

### Positive

- Size follows validated economics, not narratives or streaks.
- Exits are first-class decisions with the same rigor as entries.

### Negative

- Conservative rebate and abstention rules will skip trades a looser bot
  would take — that is the intended price of survival.

## Validation

- T-PR-RISK-01/04/05/06/07/08, T-PR-STR-07, T-PR-EXE-08, T-PR-LED-06.

## Related

- ADR-03 (reservations), ADR-05 (graph caps), ADR-09 (reality-gap calibration)
- Blueprint B9; PR-RISK-01/04/05/06/07/08, PR-LED-06, PR-STR-07
