# ADR-05: Market/Event Graph Relation Taxonomy and Graph-Aware Risk/Strategy Use

**Status:** Accepted
**Date:** 2026-09-09
**Deciders:** Crypty Root (Tech Lead)
**Technical Story:** PR-DATA-05…07, PR-RISK-02, PR-STR-03/06; Blueprint B6

---

## Context

Polymarket events group related markets and some multi-market events are
mutually exclusive negative-risk groups (S15/S16). Correlation and structural
mispricing are both graph problems: without an explicit relation model,
correlated outcomes masquerade as diversification and inferred "arbitrage"
executes against unvalidated assumptions.

## Decision

### 1. Relation taxonomy (`graph_edges`)

Ten relation types in three trust levels:

- VERIFIED_PLATFORM: NATIVE_NEG_RISK, NATIVE_EVENT_MEMBER (from event
  grouping and negative-risk metadata with exact native provenance).
- VERIFIED_RULES or INFERRED: COMPLEMENT, MUTUALLY_EXCLUSIVE, SUBSET,
  SUPERSET (probability constraints and logical consistency).
- INFERRED: CONDITIONAL, TEMPORAL_DEPENDENCY, SHARED_RESOLUTION_SOURCE,
  CORRELATED (forecast features and risk clustering only).

Every edge carries confidence (inferred) and provenance. A negative-risk
event fixture must produce mutually-exclusive native edges and consistent
exposure grouping (T-PR-DATA-05).

### 2. Use rules

- Native edges drive risk grouping and may support structural strategy only
  when payout/rules are validated.
- Low-confidence inferred edges may inform research and conservative risk
  but can never trigger structural-arbitrage execution without deterministic
  validation (T-PR-DATA-06).
- Unknown same-event relations get conservative grouping: three markets from
  one event can never each consume a full separate market cap (T-PR-RISK-02).

### 3. Consumers

- Risk: graph-aware market/event/correlation-cluster caps plus strategy and
  portfolio caps, all including unknown obligations (PR-RISK-01/02).
- Strategy: `market_graph_relative_value_v1` trades only when relation
  provenance, settlement logic and executable economics establish a robust
  inconsistency (PR-STR-03); the multi-strategy arbiter dedupes/nets
  correlated proposals so two strategies never unknowingly buy the same
  economic risk (PR-STR-06, T-PR-STR-06).

### 4. Auditability

The full universe decision log records every discovered market a strategy
considered with eligibility status and rejection reason — not only traded
markets — so selection bias is auditable and a day's universe replay
reproduces the exact eligible/rejected set with reason codes (T-PR-DATA-07).

## Consequences

### Positive

- Correlation risk is structural, not hoped away by position counting.
- Relative-value research has a principled substrate instead of ad-hoc pairs.

### Negative

- Graph maintenance (native sync + inference provenance) is ongoing work;
  inferred-edge quality must be monitored like any model.

## Validation

- T-PR-DATA-05/06/07, T-PR-RISK-02, T-PR-STR-03/06.

## Related

- ADR-03 (graph version refs in snapshots/forecasts), ADR-07 (caps/sizing)
- Blueprint B6; PR-DATA-05…07, PR-RISK-02, PR-STR-03/06
