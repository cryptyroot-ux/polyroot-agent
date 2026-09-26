# Deep Analysis — Polymarket AI Trader (PolyRoot)

> Status: **PLAN / DISCUSSION MODE** — no code written yet
> Source documents: PRD v1.0 + Blueprint v1.0 (9 September 2026)
> Basis: CloddsBot fork at commit `715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8` (MIT)

---

## 1. PRODUCT SUMMARY

**PolyRoot** = a personal bot that:

- **Researches** Polymarket markets with AI (evidence-based, structured probabilities)
- **Executes** orders autonomously inside the owner's mandate
- Starts at **PAPER**, one wallet, one strategy (`evidence_directional_v1`)
- Financial ledger in **PostgreSQL**; the AI can only _propose intents_, never sign/submit

---

## 2. ARCHITECTURE (7 Core Components)

| Component               | Function                                                | Authority                                 |
| ----------------------- | ------------------------------------------------------- | ----------------------------------------- |
| **Control + Gateway**   | Owner session → commands, mandates, read model          | Holds NO trading keys                     |
| **Data Service**        | Metadata/book/evidence → MarketSnapshot, EvidenceItem   | Writes to research schema only            |
| **Intelligence**        | Market questions + evidence → validated Forecast        | Read-only network tools, no shell/signer  |
| **Strategy**            | Forecast + quote → TradeIntent or NO_TRADE              | Never assumes signal = fill               |
| **Risk + Executor**     | Intent + mandate → reservation, signed order, venue events | **Sole financial writer**              |
| **Reconciler**          | Venue orders/trades/balance → discrepancy, readiness    | Runs even when AI stops                   |
| **Ledger + Outbox**     | Append-only events → projections, jobs, audit           | Private DB; separated roles               |

**Key insight**: Only the **executor** touches trading credentials. A prompt/gateway compromise cannot sign orders.

---

## 3. REQUIREMENT STATISTICS

| Category                    | P0     | P1    | Total  |
| --------------------------- | ------ | ----- | ------ |
| GOV (Product control)       | 5      | 0     | 5      |
| DATA (Market identity)      | 6      | 0     | 6      |
| AI (Research & probability) | 5      | 1     | 6      |
| STR (Strategy & selection)  | 3      | 1     | 4      |
| RISK (Capital & risk)       | 4      | 0     | 4      |
| EXEC (Execution)            | 8      | 0     | 8      |
| LED (Ledger & reconcile)    | 6      | 0     | 6      |
| OPS (Security & ops)        | 8      | 0     | 8      |
| DASH (Dashboard)            | 3      | 1     | 4      |
| VAL (Verification)          | 1      | 1     | 2      |
| **TOTAL**                   | **49** | **4** | **53** |

---

## 4. OPERATING MODES

| Mode         | Financial I/O                          | Purpose                                |
| ------------ | -------------------------------------- | -------------------------------------- |
| **RESEARCH** | No orders                              | Gather evidence & forecasts            |
| **PAPER**    | Isolated execution simulation          | Test costs, sizing, failure behavior   |
| **SHADOW**   | No orders sent, prospective recording  | Measure forecast drift & edge availability |
| **LIVE**     | Real orders via executor + live mandate | Routine autonomy, micro-LIVE          |

Fresh installs are **always PAPER**. Restarts never escalate mode.

---

## 5. KEY FINANCIAL OBJECTS

### 5.1 Expected Value (EV)

```
EV = q_net × E[payout per share] − cash_debit − allocated_costs
edge_per_net_share = EV / q_net
```

### 5.2 Risk Limits (Policy Defaults)

- Order: 0.5% of cap
- Market: 2% of cap
- Event (correlated): 5% of cap
- Portfolio: 10% of cap
- Daily stop: 2%
- Drawdown: 5%
- Max 10 orders (including unknown)
- Min edge: 0.03/share
- Absolute slippage: 0.01

### 5.3 Lifecycle State Machine

```
Intent: CREATED → VALIDATED → RESERVED → [REJECTED/EXPIRED]
Submit: SUBMITTING → ACKNOWLEDGED / SUBMISSION_UNKNOWN
Order:  LIVE / PARTIAL / MATCHED
Cancel: CANCEL_REQUESTED → CANCELED / CANCEL_UNKNOWN
Trade:  MATCHED → MINED/RETRYING → CONFIRMED/FAILED
Position: pending → settled → redeemable → redeemed
```

---

## 6. STRATEGY v1: `evidence_directional_v1`

**Universe**: ordinary binary markets with modeled payout, clear rules

**Pipeline**:

1. Market discovery → rules & identity validation
2. Book snapshot/stream → gather evidence → deduplicate
3. Forecast → quote → intent
4. Scan every **120 seconds** (proposal parameter, not HFT)

**Evidence Gate**: minimum 2 relevant independent sources (1 authoritative primary resolution source may qualify as an exception)

**NO_TRADE Reason Codes**:
`RULES_CHANGED`, `DATA_STALE`, `FEE_UNKNOWN`, `NO_EDGE`, `MIN_SIZE_EXCEEDS_CAP`, `BUDGET_EXHAUSTED`, `POLICY_EXPIRED`, `MODEL_UNCALIBRATED`, `ACCESS_BLOCKED`, `RECONCILIATION_REQUIRED`

---

## 7. RISK ENGINE CHECKLIST (6 Layers)

1. **Mode + Authority** — LIVE + active mandate + eligible strategy/market
2. **Data + Price** — rules_hash match, valid quote, known fee, healthy clock
3. **Economics + Sizing** — EV clears buffer, all-in cost under cap
4. **Portfolio + Loss** — positions + open + reservations gapless; loss latch passes
5. **DB Transaction** — row lock, re-validate, atomic reservation write
6. **Pre-Submit** — risk permit TTL 1s, intent TTL 30s, re-checked

---

## 8. SECURITY & BOUNDARIES

### Actor/Capability Matrix

| Actor        | Can                                        | Cannot                                         |
| ------------ | ------------------------------------------ | ---------------------------------------------- |
| Owner        | Create mandates, pause/cancel, export audit | Alter historical events, bypass validation    |
| Gateway      | Write command inbox                        | Trading keys, sign, write ledger               |
| LLM/Strategy | Read evidence, propose forecast/intent     | Shell, secrets, sign, withdraw, enable LIVE    |
| Executor     | Validate, reserve, sign, submit, cancel    | Arbitrary transfers, browsing tools            |

### Prompt Injection Defense

- Web content = data, not instructions
- Signer has no browser/shell tools
- Secret canary tested in prompt/log/export
- Output validation & capability allowlist = primary controls

---

## 9. DEPLOYMENT & INFRA

| Component     | Specification                                        |
| ------------- | ---------------------------------------------------- |
| Initial target | 1 Linux VPS: 4 vCPU, 8 GiB RAM, 40 GiB SSD          |
| Runtime       | Node 24 LTS + PostgreSQL 17                          |
| Backup        | RPO 15 min, RTO 60 min, encrypted off-host           |
| TLS           | Gateway behind TLS, DB/executor private              |
| Image         | Immutable, SBOM, secret scan, schema migration check |

---

## 10. RESEARCH PLAN

### Early Observation Gate

- ≥30 days + ≥100 independent resolved events
- 95% CI lower bound of net edge > 0 after costs
- No repeated peeking (stop at the first favorable result)

### Forecast Metrics

- Brier score, log loss, calibration diagram, sharpness, abstention/coverage
- Benchmark = market probability at forecast time

### Trading Metrics

- Net PnL, drawdown, turnover, fill/cancel ratio, capacity/depth
- LLM/infra cost, event count, concentration
- Cost/latency sensitivity

---

## 11. RISKS & CAVEATS

| Risk                                       | Level  | Mitigation                                          |
| ------------------------------------------ | ------ | --------------------------------------------------- |
| Upstream CloddsBot unproven profitability  | High   | PAPER/SHADOW first, strict gates before LIVE        |
| AI hallucination → wrong forecast          | High   | Conservative probability, calibrator, evidence gate |
| Order race conditions                      | Medium | Dedupe key, fencing epoch, atomic reservation       |
| Prompt injection via news                  | Medium | Content = data, isolated signer, tool allowlist     |
| Sudden fee/rule changes                    | Medium | rules_hash tracking, invalidate old forecasts       |
| LLM cost overrun                           | Low    | Token/cost/duration budget, abstain when exhausted  |

---

## 12. IMPLEMENTATION ORDER

1. **G0: Foundation** — fork CloddsBot, setup PostgreSQL, release manifest, schema migration
2. **G1: Data Layer** — market-data adapter, contract identity, fee metadata, order book
3. **G1: Intelligence** — provider adapter, forecast schema, evidence pipeline
4. **G2: Risk + Executor** — 6-layer risk engine, isolated signer, order lifecycle
5. **G2: Ledger** — append-only events, posting, reconciliation
6. **G3: Strategy + PAPER** — evidence_directional_v1, paper engine, scoring
7. **G3: Dashboard** — overview, markets, orders, experiments, settings
8. **G4: SHADOW** — prospective decision recording, drift measurement
9. **G5: LIVE** — mandate, micro-LIVE gate, owner resume protocol
10. **Ops** — monitoring, backup, runbook, observability

---

_This document is a study and discussion record. No implementation code yet._
