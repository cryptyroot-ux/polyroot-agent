# RE-AUDIT — 96 PRD v1.1 REQUIREMENTS ↔ REAL CODE

Date: 2026-09-11
Source: `PolyRoot_PRD_v1.1.docx` (96 reqs: 86 P0 + 10 P1, 12 groups × 8)
Method: read code per package (not claims), verify real exports & wiring.

## Honest summary

| Status | Meaning |
|--------|------|
| ✅ CODED | Real logic exists + tested (may be pure in-memory) |
| 🟡 INTERFACE ONLY | Only `interface`/`type` — contract without implementation |
| ⛔ PLACEHOLDER | Only "to be implemented" comments |
| ❌ MISSING | No code |

---

## Per group (96 reqs)

### PR-GOV-01..08 (Governance)
| Req | Status | Evidence |
|-----|--------|-------|
| GOV-01 release manifest | 🟡 Partial | `release_manifest.schema.json` exists; no compliance logic |
| GOV-02 Polymarket-first | ❌ | No venue-restriction code |
| GOV-03 Autonomy Charter | 🟡 | DB table `autonomy_charters` exists (migration 0003); no runtime enforcer |
| GOV-04 zero per-trade approval | ❌ | No authorization flow code |
| GOV-05 hard policy cannot weaken | 🟡 | `loss-floor.ts` / `kill-switch.ts` exist; no envelope |
| GOV-06 access/compliance state | ❌ | `BLOCKED`/`CLOSE_ONLY` missing from VenueMode |
| GOV-07 owner governance | ❌ | No owner-auth/audit runtime |
| GOV-08 licensing | ❌ | None |

**GOV: 0 fully implemented. 2 partial, 6 missing.**

### PR-AUT-01..08 (Autonomy)
| Req | Status | Evidence |
|-----|--------|-------|
| AUT-01 24/7 supervisor | 🟡 | `Supervisor.startPeriodicReconciliation()` exists, but no worker crash-restart |
| AUT-02 closed loop | ⛔ | `runPaperLoop` does NOT call the real orchestrator/pipeline |
| AUT-03 autonomous recovery | 🟡 | `Executor.reconcile` exists (mock); no RECOVERING state on startup yet |
| AUT-04 provider fallback | ❌ | No fallback routing |
| AUT-05 strategy arbitration | ❌ | None |
| AUT-06 protective tiers | ❌ | No NORMAL/CAUTIOUS/PROTECTIVE |
| AUT-07 bounded adaptive params | ❌ | None |
| AUT-08 autonomous learning | 🟡 | `ExperimentRegistry` exists; no auto-hypothesis yet |

**AUT: 0 full. 3 partial, 5 missing.**

### PR-WAL-01..08 (Wallet & Credentials)
| Req | Status | Evidence |
|-----|--------|-------|
| WAL-01 SDK contract | ❌ | No Polymarket SDK implementation |
| WAL-02 Deposit Wallet | 🟡 | `wallets` table exists; no contract verification |
| WAL-03 signer-wallet-funder | ✅ | Separate domain `wallet_type`; tests exist |
| WAL-04 credential lifecycle | 🟡 | `credentials` table exists; secrets unmanaged |
| WAL-05 relayer/builder | ❌ | None |
| WAL-06 asset registry | 🟡 | `asset_registry` table exists; no spendability |
| WAL-07 Signer Vault | ✅ | Real `SignerVault` + allowlist + permit (tested) |
| WAL-08 funding/break-glass | ❌ | None |

**WAL: 2 full, 3 partial, 3 missing.**

### PR-DATA-01..08
| Req | Status | Evidence |
|-----|--------|-------|
| DATA-01 market identity | 🟡 | `markets` table + schemas; asset parser exists |
| DATA-02 versioned rules | ✅ | `SettlementRulesRegistry` exists |
| DATA-03 orderbook integrity | ✅ | `OrderBook` resync exists (reconnect/delta) |
| DATA-04 venue capability | 🟡 | `MarketFeeSettings` + fee gate; no heartbeat |
| DATA-05 native graph | 🟡 | `graph_edges` table exists; provenance enum exists |
| DATA-06 inferred graph | 🟡 | Inferred relations in enum; no validation |
| DATA-07 full universe log | 🟡 | `paper_log` table exists; no eligibility decisions yet |
| DATA-08 tiered retention | ❌ | None |

**DATA: 2 full, 5 partial, 1 missing.**

### PR-INT-01..08 (Intelligence)
| Req | Status | Evidence |
|-----|--------|-------|
| INT-01 structured forecast | ✅ | `ForecastSchema` + `gateForecast` |
| INT-02 market benchmark | ❌ | None |
| INT-03 counter-search | 🟡 | `SourceRegistry` exists; no retrieval cutoff yet |
| INT-04 source family | ✅ | Syndication fold exists |
| INT-05 forecast ensemble | ✅ | `ensembleForecast` exists |
| INT-06 calibration by segment | ❌ | No training/eval calibration |
| INT-07 lineage/temporal | ✅ | `ModelLineage` exists |
| INT-08 budget abstention | ✅ | `ResearchBudget` exists |

**INT: 5 full, 1 partial, 2 missing.**

### PR-STR-01..08 (Strategy)
| Req | Status | Evidence |
|-----|--------|-------|
| STR-01 sandboxed strategy | 🟡 | `generateIntent` exists; no sandbox |
| STR-02 evidence_directional_v2 | 🟡 | `adjustQuote`/`scaleIntent` primitives; no whole strategy |
| STR-03 market_graph_relative_value | ❌ | None |
| STR-04 maker_liquidity_v1 | ❌ | None |
| STR-05 smart_money_consensus | ❌ | None |
| STR-06 multi-strategy arbiter | ❌ | None |
| STR-07 exit/reallocation | ❌ | None |
| STR-08 immutable versions | 🟡 | `ExperimentRegistry` version exists; no LIVE gate |

**STR: 0 full. 3 partial, 5 missing.**

### PR-RISK-01..08
| Req | Status | Evidence |
|-----|--------|-------|
| RISK-01 hierarchical caps | 🟡 | `validateAndReserve` caps; no cluster/inferred |
| RISK-02 graph-aware risk | ❌ | None |
| RISK-03 atomic reservation+permit | ✅ | `MoneyKernel.reserve` atomic (tested) |
| RISK-04 robust sizing | 🟡 | `SizingEngine` (property test); Kelly without empirics |
| RISK-05 liquidity/price safety | 🟡 | `FeeGate` + OrderBook; no VWAP |
| RISK-06 loss/drawdown | ✅ | `lossFloor` sealed breach (tested) |
| RISK-07 kill-switch semantics | ✅ | `kill-switch.ts` NONE→PAUSE→CANCEL→FLATTEN |
| RISK-08 unknown obligations | 🟡 | `RECONCILE_REQUIRED`; capacity hold in paper |

**RISK: 4 full, 4 partial.**

### PR-EXE-01..08 (Execution)
| Req | Status | Evidence |
|-----|--------|-------|
| EXE-01 single money path | ✅ | TradeIntent→Risk→Build→Submit; test |
| EXE-02 VenueAdapter contract | 🟡 | Interface exists; **no Polymarket implementation** |
| EXE-03 pre-network durability | ✅ | Permit binding + payloadHash |
| EXE-04 no blind retry | ✅ | `SUBMISSION_UNKNOWN` reconcile-only |
| EXE-05 cancel/replace | ✅ | Per-order `cancel`, reconcile |
| EXE-06 lifecycle/heartbeat | 🟡 | Lifecycle exists; no heartbeat |
| EXE-07 rate governor/modes | ✅ | Venue mode gate + budgets |
| EXE-08 execution economics/reality gap | 🟡 | Fee model in `simulateFill`; no live calibration |

**EXE: 5 full, 3 partial. CRITICAL PR note: no real VenueAdapter implementation.**

### PR-LED-01..08 (Ledger)
| Req | Status | Evidence |
|-----|--------|-------|
| LED-01 double-entry | 🟡 | `generateEntriesForIntent` + `projectBalance`; no full double balance |
| LED-02 exact numerics | ✅ | bigint base units (money-kernel) |
| LED-03 projection versioning | 🟡 | `balance_projections` table + checkpoint; no rebuild engine |
| LED-04 reconciliation | ✅ | `RecoveryLedger` + compare |
| LED-05 external/manual | ❌ | None |
| LED-06 net economic PnL | 🟡 | `computeEconomicMetrics` exists; no cost allocation |
| LED-07 corrections/reorg | ❌ | None |
| LED-08 audit export/retention | ❌ | None |

**LED: 2 full, 3 partial, 3 missing.**

### PR-SEC-01..08 (Security)
| Req | Status | Evidence |
|-----|--------|-------|
| SEC-01 untrusted content | ✅ | `UNTRUSTED_CONTENT_BOUNDARY` |
| SEC-02 research quarantine | ❌ | No separate process |
| SEC-03 SSRF/egress | ❌ | None |
| SEC-04 secret isolation | 🟡 | Secrets out of prompts (signer boundary); no canary |
| SEC-05 plugin sandbox | ❌ | None |
| SEC-06 supply chain | 🟡 | `release_manifest.schema`; no SBOM |
| SEC-07 authenticated API | ❌ | No dashboard/express |
| SEC-08 adversarial fixtures | ❌ | No red-team CI |

**SEC: 1 full, 2 partial, 5 missing.**

### PR-OPS-01..08 (Operations)
| Req | Status | Evidence |
|-----|--------|-------|
| OPS-01 deployment roles | ❌ | Dockerfile exists; no network-separation roles |
| OPS-02 lease/fencing | 🟡 | `executor_leases` table; no watchdog |
| OPS-03 RECOVERING startup | 🟡 | reconcile exists; no startup gate |
| OPS-04 backup/PITR | ❌ | None |
| OPS-05 observability | ⛔ | `observability` = pure placeholder |
| OPS-06 resource/clock | ❌ | None |
| OPS-07 immutable release | 🟡 | schema manifest; no rollback test |
| OPS-08 cost metering | ❌ | None |

**OPS: 0 full. 3 partial, 4 missing, 1 placeholder.**

### PR-VAL-01..08 (Quality/Verification)
| Req | Status | Evidence |
|-----|--------|-------|
| VAL-01 contract checks | 🟡 | Domain-baseline fixtures; no live API |
| VAL-02 property tests | ✅ | 12 property tests |
| VAL-03 fault harness | ✅ | 16 fault tests |
| VAL-04 paper simulator | ✅ | `simulateFill` + metrics |
| VAL-05 SHADOW | 🟡 | `evaluateShadowCandidate` + `shadow_baseline`; calendar NOT running yet |
| VAL-06 prob metrics | ✅ | `computeProbQuality` (Brier/logLoss/calib) |
| VAL-07 economic discipline | ✅ | `computeEconomicMetrics` + `ExperimentRegistry` |
| VAL-08 staged promotion | 🟡 | Gate enum exists; no promotion engine |

**VAL: 5 full, 3 partial.**

---

## Honest total (of 96)

| Status | Count |
|--------|--------|
| ✅ Fully CODED | ~28 |
| 🟡 Partial/interface | ~34 |
| ⛔ Placeholder | 1 (observability block + risk index interfaces) |
| ❌ Missing | ~33 |

## Re-audit conclusions (honest)

1. **No valid "done" claim.** About 28/96 (≈29%) are truly fully coded. Most of the rest are partial/interface/missing.
2. **CRITICAL GAP #1 — VenueAdapter:** no real Polymarket CLOB V2 implementation. The whole pipeline only makes sense up to mocks. G3/EXE-02 cannot PASS in the real world.
3. **CRITICAL GAP #2 — autonomous loop unwired:** `runPaperLoop` does not call `orchestrate` → never passes Money Kernel/Executor/Signer. So "PAPER closed-loop" is not really closed.
4. **CRITICAL GAP #3 — observability placeholder:** OPS-05 (metrics/alerts) and most monitoring do not exist.
5. **CRITICAL GAP #4 — security/sandbox/api missing:** SEC-02/03/05/07, OPS-01/04/06/08 do not exist.
6. **CRITICAL GAP #5 — G5/G6/G7 cannot PASS:** 30-day SHADOW has not run; micro-LIVE has never happened. This **must not be fabricated**.
7. **124/124 traceability is a structural check** (ID ↔ test_id mapping in JSON), not implementation proof. All 124 CSV rows are `implemented=False`, `acceptance_status=NOT_RUN`.

## What must be done (honest)

- Build a real Polymarket VenueAdapter implementation (pinned SDK).
- Wire `runPaperLoop` → `orchestrate` (real pipeline) so PAPER is truly closed-loop.
- Replace the observability placeholder with real metrics/health/alerts.
- Implement SEC-02/03/05/07, OPS-01/04/06/08.
- Run G5 (30 days) & G6 (micro-LIVE) as calendar/real evidence — fabrication forbidden.
