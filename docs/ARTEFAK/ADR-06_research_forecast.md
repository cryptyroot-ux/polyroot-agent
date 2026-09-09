# ADR-06: Research Quarantine, Source Registry, Forecast Ensemble/Calibration and Provider Lineage

**Status:** Accepted
**Date:** 2026-09-09
**Deciders:** Crypty Root (Tech Lead)
**Technical Story:** PR-INT-01…08, PR-SEC-01…03; Blueprint B7

---

## Context

Forecast literature is mixed and contamination-prone: LLM eloquence is not
evidence of edge, pretrained models may know historical outcomes, and
expensive LLM features can contribute nothing after calibration (S30–S35).
Meanwhile web/news/social content is untrusted and must never become system
instruction or reach the signer (PR-SEC-01). The design must therefore
isolate retrieval, enforce source discipline, ensemble independent
forecasters, calibrate by segment, and preserve temporal lineage — with
prospective evaluation as the only promotion currency.

## Decision

### 1. Research quarantine (PR-SEC-01/02/03)

A low-privilege retrieval worker receives a market research question, a
source allow/deny policy and a resource budget — never system authority or
financial secrets. HTTP egress validates scheme/domain/IP, blocks
localhost/private/link-local/metadata ranges, revalidates redirects/DNS and
caps bytes, archive expansion, content type and time. Raw content is
normalized into evidence claims with provenance; embedded instructions stay
quoted data and never enter privileged system instructions. A compromised
retrieval worker cannot reach the executor, signing or private DB roles
(T-PR-SEC-02); redirect/DNS-rebind to private ranges is blocked and logged
(T-PR-SEC-03). Sports streams are informational only — sports strategies need
independently validated authoritative feeds (Blueprint B7.1).

### 2. Source registry and independence (PR-INT-04)

Every source is classified by authority, family, syndication lineage, domain
expertise, measurable reliability/corrections, publication latency and
rights. Three syndicated copies of one article count as one independent
source; first-party primary sources stay distinguishable (T-PR-INT-04).
Counter-search is mandatory: a one-sided evidence set must surface opposing
evidence or record a documented coverage failure (T-PR-INT-03).

### 3. Forecast ensemble (PR-INT-05)

Multiple independently versioned forecasters (market-baseline/prior,
retrieval-driven, microstructure/statistical, structural-graph) feed a
deterministic aggregator that preserves component predictions and weights.
No single monolithic LLM response is the only forecast path; removing one
component reruns the ensemble with changed lineage and no hidden
substitution (T-PR-INT-05). The contemporaneous executable market
probability is captured as benchmark/prior signal — never as unquestioned
truth or future-price input (PR-INT-02, T-PR-INT-02).

### 4. Calibration by segment (PR-INT-06)

Calibration is trained and evaluated by model/provider, category, horizon
and regime, only on past eligible labels; aggregates may need their own
recalibration (forecast-combination literature, S40). Verbal LLM confidence
is not a sizing signal: an unchanged calibrated distribution with "95%
confident" prose must not increase size (T-PR-RISK-04). Model/category
shifts cannot silently inherit an incompatible calibrator — the system
abstains or uses an eligible fallback (T-PR-INT-06).

### 5. Temporal integrity and budgets (PR-INT-07/08)

Every feature/evidence item carries `available_at`/source cutoff; model,
prompt, config and provider-response fingerprints are versioned. Canary
future evidence must never appear in historical replay (T-PR-INT-07).
Token/cost/time/source/concurrency budgets bound research; exhaustion
degrades research or abstains without affecting position monitoring,
cancellation, heartbeat or reconciliation (T-PR-INT-08).

## Consequences

### Positive

- Forecasts are auditable probability machines with lineage, not oracles.
- Prompt-injection, SSRF and contamination each have a dedicated layer.

### Negative

- Ensemble + calibration + registry is the most research-heavy subsystem;
  it needs real sample sizes before any segment claim is credible.

## Validation

- T-PR-INT-01…08, T-PR-SEC-01…03, T-PR-RISK-04.

## Related

- ADR-01 (quarantine boundary), ADR-09 (prospective evaluation)
- Blueprint B7; PR-INT-01…08, PR-SEC-01…03
