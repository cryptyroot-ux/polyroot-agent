# PolyRoot Agent

**Autonomous AI trading agent for Polymarket** — a fork of
[CloddsBot](https://github.com/alsk1992/CloddsBot) built with a **controlled
autonomy** architecture: the AI proposes intents only, while a separate
deterministic **Executor** signs and submits orders. The AI never holds private
keys.

> **Status: v1.1 (Phase 0–14 complete) — PAPER mode by default, Debug/Verification phase.**
> No live trading. Default mode is `PAPER`.

---

## What it is

PolyRoot is an open, auditable prediction-market trading agent. It watches the
Polymarket order book, feeds evidence into an LLM that proposes trading
intents, and routes those intents through a risk-gated, deterministic executor.
Separation of **reasoning** (AI) from **execution** (code) is the core safety
property that distinguishes PolyRoot from "ChatGPT-trades-my-wallet" bots.

## Architecture overview

```
┌───────────────────────┐      proposes only      ┌───────────────────┐
│    Intelligence (AI)  │ ──────────────────────► │    Risk Engine    │
│                       │   TradeIntent (no keys) │     reservations  │
└───────────────────────┘                         └────────┬──────────┘
                                                           │ accepted intents
                                                           ▼
┌───────────────────────┐                            ┌───────────────────┐
│  Market Data Adapter  │◄── feeds/evidence ───────── │   EXECUTOR (deterministic) │
│  (Polymarket + SDK)   │                            │ signs & submits    │
└───────────────────────┘                            │ holds the keys     │
                                                     └────────┬──────────┘
                                                              ▼
                                                     ┌───────────────────┐
                                                     │      Ledger       │
                                                     │  events + outbox  │
                                                     └───────────────────┘
```

Key invariants:

- **AI never holds private keys** — it can only _propose_ intents.
- **Every intent passes the same validator** — read / learn / propose only.
- **Executor is deterministic + auditable** — every order is a signed,
  logged, recoverable ledger event.
- **Risk engine reserves capital** — no intent can size itself beyond policy.

## Specification & Status

| Metric | Value |
|--------|-------|
| **Spec version** | v1.1 (Correction & Completion Release, 9 Sep 2026) |
| **Requirements** | **96** traceable (86 P0 + 10 P1) — [PRD_v1.1.docx](PolyRoot_PRD_v1.1.docx) |
| **Gates** | G0–G7 (G0–G3 verified, G4–G7 pending economic evidence) |
| **Traceability** | 124/124 structural mapping (124 PM-* requirement IDs ↔ test IDs) |
| **Tests** | 170 contract + 12 property = **183 passing** |
| **Build** | 36/36 packages (monorepo, turbo) |
| **Lint / Typecheck** | Clean |

| Gate | Status | Evidence |
|------|--------|----------|
| G0 — Fresh install | ✅ PASS | Contract tests |
| G1 — PAPER / Governance | ✅ PASS | Governance, wallet modes, venue modes |
| G2 — Risk / Capital | ✅ PASS | Money kernel, kill-switch, loss-floor, key-compromise |
| G3 — Execution / Venue | ✅ PASS | Lifecycle, venue modes, reconciler |
| G4 — PAPER | 🟡 READY | Paper engine, simulator, metrics, registry (not yet run) |
| G5 — SHADOW | ⏳ PENDING | Requires 30d baseline, 100+ resolved clusters |
| G6 — micro-LIVE | ⏳ PENDING | Bounded capital, real wallet/fill/settlement |
| G7 — autonomous-LIVE 24/7 | ⏳ PENDING | Sustained micro-LIVE + prospective edge |

## Repository layout

```
src/
├── pm/                    # PolyRoot domain packages (12 packages)
│   ├── control/           # Orchestrator, supervisor, reconciler, risk-gate, order-builder, signal
│   ├── data/              # Asset identity, settlement rules, order book, fee gate, evidence
│   ├── domain/            # Entities: EvidenceItem, MarketSnapshot, Forecast, TradeIntent, ...
│   ├── executor/          # Order lifecycle, signing (holds keys)
│   ├── intelligence/      # LLM provider adapters + forecast service
│   ├── ledger/            # Events, projections, outbox
│   ├── observability/     # Metrics, logging, alerts (placeholder)
│   ├── risk/              # EV, sizing, reservations, policy, kill-switch, loss-floor, money kernel
│   ├── runtime/           # Paper engine, metrics, experiment registry (G4)
│   ├── signer/            # Signer vault, signer allowlist, typed requests
│   ├── strategy/          # Strategy/quote engines
│   └── venue/             # Polymarket CLOB V2 adapter (pinned)
migrations/                # SQL migration files (managed, 0001-0005)
tests/pm/                  # Contract / property / DB integration tests
docs/                      # Spec pack (PRD, Blueprint, GAP, Audit, implementation)
scripts/                   # Migration runner, traceability checker
```

## Documentation

- `PolyRoot_PRD_v1.1.docx` — Product Requirements (96 traceable requirements: 86 P0 + 10 P1)
- `PolyRoot_Technical_Blueprint_v1.1.docx` — Technical design, architecture, risk/ledger/execution
- `GAP_ANALYSIS_v1.1.md` — Gap analysis v1.1
- `docs/implementation/` — Forensic audit, gate status, phase completion, reconciliation, test taxonomy

## Getting started (dev)

```bash
npm ci
docker compose up -d postgres
npm run migrate:latest
npm run dev          # starts gateway + executor in PAPER mode
```

### Test & verify

```bash
npm run test:unit        # 170 contract + 12 property = 183 tests
npm run traceability     # 124/124 structural traceability
npm run build            # 36/36 packages pass
npm run lint && npm run typecheck
```

## Implementation audit

- `docs/implementation/FORENSIC_COMPLETION_AUDIT.md` — Forensic completion audit
- `docs/implementation/GATE_STATUS.md` — Gate G0–G7 status
- `docs/implementation/PHASE_COMPLETION_AUDIT.md` — Phase completion audit
- `docs/implementation/REQUIREMENT_RECONCILIATION.md` — 124→96 requirement reconciliation
- `docs/implementation/SOURCE_OF_TRUTH_AUDIT.md` — Source-of-truth audit
- `docs/implementation/TEST_TAXONOMY_AUDIT.md` — Test taxonomy audit

## License

MIT — see [`LICENSE`](LICENSE). Original work from CloddsBot
(c) 2026 alsk1992, plus PolyRoot modifications (c) 2026 Crypty Root.