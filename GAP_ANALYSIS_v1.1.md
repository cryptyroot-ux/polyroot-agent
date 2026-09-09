# PolyRoot v1.1 — Gap Analysis: Current Implementation vs Requirements

**Date**: 2026-09-09  
**Status**: Analysis complete — implementation gaps identified

---

## Executive Summary

| Metric          | v1.0 (Our Baseline) | v1.1 (Current Spec)    | Gap           |
| --------------- | ------------------- | ---------------------- | ------------- |
| Requirements    | 53 (49 P0 + 4 P1)   | **96 (86 P0 + 10 P1)** | +43 reqs      |
| Test Scenarios  | 53                  | **96**                 | +43 tests     |
| Categories      | 9                   | **12**                 | +3 categories |
| ADRs            | 6                   | **9**                  | +3 ADRs       |
| Gates           | G0-G5               | **G0-G7**              | +2 gates      |
| Risk Parameters | 7                   | **17**                 | +10 params    |
| Product Name    | "PolyRoot"          | **"PolyRoot"**         | Rename        |

**Overall**: Our Phase 1 scaffold covers ~20% of v1.1 requirements. Major gaps in: Autonomy Charter, Money Kernel, Signer Vault, Research Quarantine, Market Graph, Forecast Ensemble, Strategy Sandbox, VenueAdapter, Ledger Projections, Deployment Security.

---

## Category-by-Category Gap Analysis

### 1. GOVERNANCE (PR-GOV-01..08) — 8 reqs

| Req                                       | Status         | Notes                                               |
| ----------------------------------------- | -------------- | --------------------------------------------------- |
| PR-GOV-01: Controlled fork baseline       | 🟡 Partial     | Fork pinned but disposition matrix missing          |
| PR-GOV-02: Polymarket-first venue         | ✅ Done        | Single venue scope enforced                         |
| PR-GOV-03: **Autonomy Charter**           | ❌ **Missing** | Core new concept — immutable commissioning artifact |
| PR-GOV-04: Zero per-trade approval        | 🟡 Scaffolded  | Architecture supports but Charter not implemented   |
| PR-GOV-05: Hard policy cannot self-weaken | 🟡 Scaffolded  | Risk policy exists but no Charter binding           |
| PR-GOV-06: Access/compliance state        | ❌ **Missing** | No geoblock/venue mode state machine                |
| PR-GOV-07: Owner governance exceptional   | 🟡 Scaffolded  | Control API exists but auth not hardened            |
| PR-GOV-08: Licensing/data-right registry  | ❌ **Missing** | New P1 requirement                                  |

### 2. AUTONOMY RUNTIME (PR-AUT-01..08) — 8 reqs

| Req                                | Status         | Notes                                       |
| ---------------------------------- | -------------- | ------------------------------------------- |
| PR-AUT-01: 24/7 supervisor         | ❌ **Missing** | No supervisor process                       |
| PR-AUT-02: Closed autonomous loop  | ❌ **Missing** | No loop implementation                      |
| PR-AUT-03: Auto recovery/resume    | ❌ **Missing** | No recovery state machine                   |
| PR-AUT-04: Provider fallback       | ❌ **Missing** | No provider abstraction                     |
| PR-AUT-05: Strategy arbitration    | ❌ **Missing** | No arbiter                                  |
| PR-AUT-06: Protective risk tiers   | 🟡 Partial     | RiskPolicy has tiers but no auto-transition |
| PR-AUT-07: Bounded adaptive params | ❌ **Missing** | No adaptive tuning                          |
| PR-AUT-08: Autonomous learning     | ❌ **Missing** | P1 — experiment factory                     |

### 3. WALLET/CREDENTIALS/SIGNER (PR-WAL-01..08) — 8 reqs

| Req                                           | Status         | Notes                                          |
| --------------------------------------------- | -------------- | ---------------------------------------------- |
| PR-WAL-01: Official SDK contract              | 🟡 Partial     | @polymarket/client in deps but no VenueAdapter |
| PR-WAL-02: **Deposit Wallet / wallet type 3** | ❌ **Missing** | Critical — current default account model       |
| PR-WAL-03: Signer/wallet/funder identity      | ❌ **Missing** | No identity separation                         |
| PR-WAL-04: Credential lifecycle               | ❌ **Missing** | No L1/L2/relayer tracking                      |
| PR-WAL-05: Relayer/builder capability         | ❌ **Missing** | No isolation                                   |
| PR-WAL-06: **Asset/approval registry**        | ❌ **Missing** | pUSD, USDC, outcome tokens as distinct assets  |
| PR-WAL-07: **Narrow Signer Vault**            | ❌ **Missing** | Core new component — minimal signer boundary   |
| PR-WAL-08: Funding/break-glass boundary       | ❌ **Missing** | No separate governance workflow                |

### 4. MARKET DATA & GRAPH (PR-DATA-01..08) — 8 reqs

| Req                                         | Status         | Notes                                                        |
| ------------------------------------------- | -------------- | ------------------------------------------------------------ |
| PR-DATA-01: Canonical market identity       | 🟡 Partial     | Markets table exists but missing condition_id, token mapping |
| PR-DATA-02: Versioned rules/clarifications  | ❌ **Missing** | No rules versioning                                          |
| PR-DATA-03: Orderbook/user stream integrity | ❌ **Missing** | No stream reconciliation                                     |
| PR-DATA-04: Venue capability metadata       | ❌ **Missing** | No fee/tick/mode tracking                                    |
| PR-DATA-05: **Native Event & Market Graph** | ❌ **Missing** | Core new component — graph edges from event/neg-risk         |
| PR-DATA-06: Inferred relationship graph     | ❌ **Missing** | No inferred edges with provenance                            |
| PR-DATA-07: Full universe decision log      | ❌ **Missing** | No eligibility logging                                       |
| PR-DATA-08: Tiered research retention       | ❌ **Missing** | P1                                                           |

### 5. INTELLIGENCE & FORECASTING (PR-INT-01..08) — 8 reqs

| Req                                               | Status         | Notes                                                   |
| ------------------------------------------------- | -------------- | ------------------------------------------------------- |
| PR-INT-01: Structured probabilistic Forecast      | 🟡 Partial     | Forecast type exists but missing calibration fields     |
| PR-INT-02: Market as benchmark/prior              | ❌ **Missing** | No market baseline capture                              |
| PR-INT-03: Evidence retrieval with counter-search | ❌ **Missing** | No research quarantine                                  |
| PR-INT-04: Source Registry & independence         | ❌ **Missing** | No source classification                                |
| PR-INT-05: **Forecast ensemble**                  | ❌ **Missing** | Core — multiple forecasters + deterministic aggregation |
| PR-INT-06: Calibration by segment                 | ❌ **Missing** | No calibration service                                  |
| PR-INT-07: Temporal integrity/lineage             | ❌ **Missing** | No available_at/source_cutoff                           |
| PR-INT-08: Budget-aware abstention                | ❌ **Missing** | No cost budgets                                         |

### 6. STRATEGY PLATFORM (PR-STR-01..08) — 8 reqs

| Req                                           | Status         | Notes                            |
| --------------------------------------------- | -------------- | -------------------------------- |
| PR-STR-01: Sandboxed strategy contract        | 🟡 Partial     | Interface exists but no sandbox  |
| PR-STR-02: **evidence_directional_v2**        | ❌ **Missing** | Core strategy v2 (not v1)        |
| PR-STR-03: **market_graph_relative_value_v1** | ❌ **Missing** | Core graph strategy              |
| PR-STR-04: maker_liquidity_v1                 | ❌ **Missing** | P1 experimental                  |
| PR-STR-05: smart_money_consensus_v1           | ❌ **Missing** | P1 experimental                  |
| PR-STR-06: Multi-strategy arbiter             | ❌ **Missing** | No deduplication/netting         |
| PR-STR-07: Exit/reallocation engine           | ❌ **Missing** | No HOLD vs EXIT/REALLOCATE logic |
| PR-STR-08: Immutable experiment/promotion     | ❌ **Missing** | No versioned experiment registry |

### 7. MONEY KERNEL & RISK (PR-RISK-01..08) — 8 reqs

| Req                                             | Status         | Notes                                              |
| ----------------------------------------------- | -------------- | -------------------------------------------------- |
| PR-RISK-01: Hierarchical exposure caps          | 🟡 Partial     | RiskPolicy has caps but no graph-aware enforcement |
| PR-RISK-02: Graph-aware correlation risk        | ❌ **Missing** | No graph-aware risk                                |
| PR-RISK-03: Atomic reservation/permit           | ❌ **Missing** | Core — no atomic reservation + ExecutionPermit     |
| PR-RISK-04: Robust position sizing              | 🟡 Partial     | SizingEngine placeholder only                      |
| PR-RISK-05: Liquidity/price safety              | ❌ **Missing** | No VWAP/depth validation                           |
| PR-RISK-06: Autonomous loss/drawdown protection | 🟡 Partial     | Policy has stops but no auto-recovery logic        |
| PR-RISK-07: Kill-switch semantics               | 🟡 Partial     | Policy has actions but no executor integration     |
| PR-RISK-08: Unknown obligations consume risk    | ❌ **Missing** | No unknown state tracking                          |

### 8. EXECUTION & VENUE (PR-EXE-01..08) — 8 reqs

| Req                                             | Status         | Notes                                   |
| ----------------------------------------------- | -------------- | --------------------------------------- |
| PR-EXE-01: Single money path                    | 🟡 Partial     | Architecture supports but not enforced  |
| PR-EXE-02: **VenueAdapter capability contract** | ❌ **Missing** | Core — no adapter wrapping official SDK |
| PR-EXE-03: Idempotent intent/durability         | ❌ **Missing** | No dedupe_key, intent persistence       |
| PR-EXE-04: No blind financial retry             | ❌ **Missing** | No UNKNOWN state handling               |
| PR-EXE-05: Cancel/replace/late fill             | ❌ **Missing** | No lifecycle state machine              |
| PR-EXE-06: Lifecycle/heartbeat/settlement       | ❌ **Missing** | No raw+internal state tracking          |
| PR-EXE-07: Rate governor/venue modes            | ❌ **Missing** | No rate budgets, no venue mode matrix   |
| PR-EXE-08: Execution economics/reality gap      | ❌ **Missing** | No PAPER vs micro-LIVE calibration      |

### 9. LEDGER & RECONCILIATION (PR-LED-01..08) — 8 reqs

| Req                                     | Status         | Notes                                           |
| --------------------------------------- | -------------- | ----------------------------------------------- |
| PR-LED-01: Append-only double-entry     | 🟡 Partial     | ledger_events table exists but no postings      |
| PR-LED-02: Exact numeric representation | 🟡 Partial     | NUMERIC used but no integer base units          |
| PR-LED-03: Projection versioning        | ❌ **Missing** | No projected_event_seq, rebuildable projections |
| PR-LED-04: Continuous reconciliation    | ❌ **Missing** | No reconciliation service                       |
| PR-LED-05: External/manual activity     | ❌ **Missing** | No EXTERNAL classification                      |
| PR-LED-06: Net economic PnL             | ❌ **Missing** | No cost allocation                              |
| PR-LED-07: Corrections/reorgs           | ❌ **Missing** | No correction_of_event_id                       |
| PR-LED-08: Audit export/retention       | ❌ **Missing** | P1                                              |

### 10. SECURITY (PR-SEC-01..08) — 8 reqs

| Req                                     | Status         | Notes                                                     |
| --------------------------------------- | -------------- | --------------------------------------------------------- |
| PR-SEC-01: Untrusted external content   | 🟡 Partial     | Research quarantine concept in ADR-01 but not implemented |
| PR-SEC-02: Research quarantine boundary | ❌ **Missing** | No separate retrieval worker                              |
| PR-SEC-03: SSRF/egress protection       | ❌ **Missing** | No controlled egress                                      |
| PR-SEC-04: Secret isolation/redaction   | 🟡 Partial     | .env ignored but no secret store                          |
| PR-SEC-05: Plugin/process sandbox       | ❌ **Missing** | No sandbox                                                |
| PR-SEC-06: Dependency amputation        | 🟡 Partial     | package.json clean but no allowlist                       |
| PR-SEC-07: Authenticated product API    | 🟡 Partial     | Control API exists but TLS/auth not hardened              |
| PR-SEC-08: Adversarial verification     | ❌ **Missing** | No red-team fixtures in CI                                |

### 11. OPERATIONS (PR-OPS-01..08) — 8 reqs

| Req                                          | Status         | Notes                                               |
| -------------------------------------------- | -------------- | --------------------------------------------------- |
| PR-OPS-01: Separated deployment roles        | 🟡 Partial     | docker-compose has services but no network policies |
| PR-OPS-02: Watchdog/leases                   | ❌ **Missing** | No lease_epoch, no fencing                          |
| PR-OPS-03: Recovering startup                | ❌ **Missing** | No RECOVERING state machine                         |
| PR-OPS-04: Off-host backup/PITR              | ❌ **Missing** | No backup/restore drill                             |
| PR-OPS-05: Observability/autonomous incident | 🟡 Partial     | Metrics list exists but no alerts                   |
| PR-OPS-06: Resource/clock health             | ❌ **Missing** | No CPU/memory/disk limits, no clock sync            |
| PR-OPS-07: Immutable release/rollback        | 🟡 Partial     | Docker image but no migration compatibility test    |
| PR-OPS-08: Cost/budget governance            | ❌ **Missing** | No cost metering                                    |

### 12. VALIDATION & GATES (PR-VAL-01..08) — 8 reqs

| Req                                      | Status         | Notes                                     |
| ---------------------------------------- | -------------- | ----------------------------------------- |
| PR-VAL-01: Official contract checks      | ❌ **Missing** | No read-only SDK/API contract tests in CI |
| PR-VAL-02: Property/invariant tests      | 🟡 Partial     | fast-check tests scaffolded but empty     |
| PR-VAL-03: Fault-injection harness       | ❌ **Missing** | No fault injection                        |
| PR-VAL-04: Paper simulator calibration   | ❌ **Missing** | No PAPER engine                           |
| PR-VAL-05: Prospective SHADOW evaluation | ❌ **Missing** | No SHADOW mode                            |
| PR-VAL-06: Probabilistic quality metrics | ❌ **Missing** | No Brier/log loss/calibration             |
| PR-VAL-07: Best-of-many promotion block  | ❌ **Missing** | No trial registry                         |
| PR-VAL-08: Net economic gate             | ❌ **Missing** | No economic gate enforcement              |

---

## Architecture Component Gap

| Component                     | v1.1 Spec                                     | Current    | Gap      |
| ----------------------------- | --------------------------------------------- | ---------- | -------- |
| **Autonomy Charter**          | Immutable commissioning artifact              | ❌         | Critical |
| **24/7 Supervisor**           | Independent process, lease_epoch fencing      | ❌         | Critical |
| **Runtime State Machine**     | 8 states + transitions                        | ❌         | Critical |
| **Venue Mode State Machine**  | 6 modes + action matrix                       | ❌         | Critical |
| **Risk Tier State Machine**   | 3 tiers + auto-transition                     | 🟡 Partial | Major    |
| **Research Quarantine**       | Separate worker, controlled egress            | ❌         | Critical |
| **Source Registry**           | Authority/syndication/reliability             | ❌         | Critical |
| **Forecast Ensemble**         | Multiple forecasters + aggregation            | ❌         | Critical |
| **Calibration Service**       | Segmented by model/category/horizon           | ❌         | Critical |
| **Strategy Sandbox**          | Isolated, versioned, proposal-only            | ❌         | Critical |
| **Strategy Arbiter**          | Deduplication, netting, budgeting             | ❌         | Critical |
| **Money Kernel**              | Eligibility→economics→sizing→risk→reservation | ❌         | Critical |
| **ExecutionPermit**           | Short-lived, atomic with reservation          | ❌         | Critical |
| **VenueAdapter**              | Wraps @polymarket/client, fail-closed         | ❌         | Critical |
| **Signer Vault**              | Minimal process, typed allowlist              | ❌         | Critical |
| **Asset/Approval Registry**   | pUSD, USDC, outcome tokens distinct           | ❌         | Critical |
| **Market/Event Graph**        | Native + inferred edges with provenance       | ❌         | Critical |
| **Ledger Projections**        | projected_event_seq, rebuildable              | ❌         | Critical |
| **Continuous Reconciliation** | 15s interval + startup/reconnect              | ❌         | Critical |
| **Rate Governor**             | Separate budgets, token buckets               | ❌         | Critical |
| **Deployment Roles**          | 8 separated roles + network policies          | 🟡 Partial | Major    |

---

## Required Actions Priority Order

### Phase 1 Completion (Immediate — Foundation Fixes)

1. **Rename** "PolyRoot" → "PolyRoot" everywhere
2. **Update domain models** to match v1.1 canonical contracts (AutonomyCharter, MarketSnapshot, EvidenceItem, Forecast, StrategyProposal, TradeIntent, RiskDecision/ExecutionPermit, Order/Trade/Settlement states)
3. **Add missing migrations** for: AutonomyCharter, asset_registry, wallet/credentials, graph_edges, market_versions, outbox_jobs, leases, audit, costs
4. **Update release_manifest.json** schema to v1.1 (add fork_disposition, strategy versions, policy version, charter ref)
5. **Create 7 new ADRs** (ADR-03 through ADR-09)

### Phase 2 (Core Runtime — Sprint 2-3)

6. **Implement VenueAdapter** wrapping @polymarket/client with contract tests
7. **Implement Signer Vault** (narrow, typed, allowlisted)
8. **Implement Asset/Approval Registry** (pUSD, USDC, outcome tokens)
9. **Implement Money Kernel** (eligibility, economics, sizing, atomic reservation)
10. **Implement Executor** with Intent/Order state machines
11. **Implement Rate Governor + Venue Mode matrix**
12. **Implement Market/Event Graph** (native + inferred)
13. **Implement Research Quarantine** + Source Registry
14. **Implement Forecast Ensemble** + Calibration
15. **Implement Strategy Sandbox** + Arbiter
16. **Implement continuous Reconciliation** + Ledger Projections

### Phase 3 (Autonomy — Sprint 4-5)

16. **Implement 24/7 Supervisor** + lease_epoch fencing
17. **Implement Runtime State Machine** (8 states)
18. **Implement Auto-recovery/resume** logic
19. **Implement Protective Risk Tier transitions**
20. **Implement PAPER Engine** with calibrated simulator
21. **Implement SHADOW Mode** prospective evaluation

### Phase 4 (Hardening — Sprint 6-7)

22. **Harden Deployment** (network policies, TLS, secret stores)
23. **Implement Backup/PITR** + restore drills
24. **Add Adversarial Verification** to CI
25. **Implement Fault-Injection Harness**
26. **Implement Net Economic Gate** enforcement

---

## Next Steps

1. **Immediate**: Update domain types and migrations to match v1.1 canonical contracts
2. **This week**: Add 7 missing ADRs, update release manifest, fix product naming
3. **Sprint 2**: Begin core runtime implementation (VenueAdapter, Signer Vault, Money Kernel, Executor)
4. **Sprint 3**: Autonomy runtime (Supervisor, State Machines, Research Quarantine, Forecast Ensemble)
5. **Sprint 4**: Strategies + PAPER/SHADOW
6. **Sprint 5+**: Hardening, gates, micro-LIVE

---

## Files to Update (Priority Order)

1. `/src/pm/domain/src/index.ts` — Canonical domain contracts (HIGH)
2. `/src/pm/domain/src/constants.ts` — v1.1 risk params + new constants (HIGH)
3. `/migrations/0001_initial_schema.sql` — Add AutonomyCharter, asset_registry, wallets, graph, outbox, leases (HIGH)
4. `/migrations/0003_v11_extensions.sql` — New migration for v1.1 extensions (HIGH)
5. `/release_manifest.json` — v1.1 schema (MEDIUM)
6. `/docs/ARTEFAK/ADR-03_domain_schemas.md` through ADR-09 (HIGH)
7. `/package.json` — Rename to "PolyRoot", update @polymarket/client version (MEDIUM)
8. `/README.md` — Update to PolyRoot, v1.1 architecture (MEDIUM)
9. All workspace package.json — Update names/descriptions (LOW)
