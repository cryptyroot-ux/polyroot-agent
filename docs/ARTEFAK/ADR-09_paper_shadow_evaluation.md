# ADR-09: PAPER Simulator, Prospective Evaluation, Multiple-Testing Policy and Autonomous Experiment Factory

**Status:** Accepted
**Date:** 2026-09-09
**Deciders:** Crypty Root (Tech Lead)
**Technical Story:** PR-VAL-04…08, PR-AUT-08, PR-STR-08; Blueprint B15

---

## Context

Forecasting accuracy is not trading profitability, and historical
expected-value estimates are not live-fill PnL (S32). Pretrained LLMs may
know historical outcomes, rolling backtests invite leakage, and searching
many variants guarantees selection bias (S37–S39). Promotion therefore
needs a staged evidence ladder — preregistered, time-respecting, prospective
and economically net — plus a policy that treats best-of-many history as
guilty until proven innocent.

## Decision

### 1. Staged protocol (Blueprint B15)

- **Preregistration:** universe/eligibility, strategy/model/prompt/
  calibrator/aggregator, parameter envelope, costs, benchmarks, metrics,
  CI/bootstrap, stopping rule and sensitivity are frozen before final
  evaluation.
- **Historical replay:** rolling-origin, time-respecting, `available_at`
  enforced, complete market-selection log. Debugging and priors only —
  LLM pretraining contamination may exist.
- **PAPER live:** contemporaneous book/depth/tick/min-size/fees, latency
  and a conservative queue/fill model (bid/ask/depth, fees/rebates,
  latency, partials, cancel race) with reported uncertainty. A resting
  limit merely touching midprice never counts as a fill; calibrated error
  metrics are recorded (T-PR-VAL-04).
- **SHADOW prospective:** exact frozen versions record hypothetical
  intents/quotes/research without orders against the same-timestamp market
  baseline; post-cutoff news/outcomes never enter prior decisions and the
  full universe plus abstentions are logged (T-PR-VAL-05).
- **micro-LIVE:** small explicit cap validates actual signing, rate/mode
  behavior, fills, settlement, fees/rebates — and calibrates the PAPER
  execution reality gap, which the strategy gate must reflect when PAPER
  predicts fills micro-LIVE repeatedly misses (T-PR-EXE-08).

### 2. Metrics and uncertainty (PR-VAL-06)

Forecasts: Brier, log loss, calibration/reliability, sharpness,
abstention/coverage and same-timestamp market baseline by
category/horizon/model/ensemble. Trading: gross/net PnL and edge,
drawdown, turnover, fill/cancel ratio, reality gap, fees/rebates,
LLM/data/infra cost, capacity/depth, concentration and independent event
clusters. Uncertainty uses clustered bootstrap or preregistered
equivalents where dependencies exist; too few independent clusters is
inconclusive, never a pass. A higher win rate with worse proper
score/calibration is not superior (T-PR-VAL-06).

### 3. Multiple-testing policy (PR-VAL-07)

All tried variants and failed hypotheses enter the trial registry. Changing
one threshold during holdout creates a new experiment/version; old results
stay immutable (T-PR-STR-08). No best-of-many variant promotes without
preregistered holdout/prospective evidence (T-PR-VAL-07).

### 4. Autonomous experiment factory (PR-AUT-08, PR-STR-08)

The system may propose and test new hypotheses in PAPER/SHADOW inside its
compute budget, but new executable code or unqualified strategy versions
can never self-promote to LIVE: attempted promotion without a signed
release gate fails (T-PR-AUT-08). Strategy/model/prompt/parameter versions
and routing rules are immutable per experiment — changes mint new IDs, and
LIVE eligibility is per exact version, never per strategy name.

### 5. Economic gate supremacy (PR-VAL-08)

All engineering tests green with a failed net-economic gate still denies
autonomous-LIVE promotion. Edge claims come only from prospective
net-economic evidence with uncertainty and documented exclusions.

## Consequences

### Positive

- Promotion arguments survive the questions that kill most trading bots:
  leakage, selection bias, simulator optimism and cost blindness.

### Negative

- Prospective SHADOW takes calendar time that cannot be parallelized away;
  planning estimates are not delivery promises.

## Validation

- T-PR-VAL-04/05/06/07/08, T-PR-AUT-08, T-PR-STR-08, T-PR-EXE-08.

## Related

- ADR-06 (ensemble/calibration inputs), ADR-07 (net economics)
- Blueprint B15; PR-VAL-04…08, PR-AUT-08, PR-STR-08
