# Polyroot Agent

**Autonomous AI trading agent for Polymarket** — a fork of
[CloddsBot](https://github.com/alsk1992/CloddsBot) built with a **controlled
autonomy** architecture: the AI proposes intents only, while a separate
deterministic **Executor** signs and submits orders. The AI never holds private
keys.

> ⚠️ **Status: Phase 1 (Foundation) — under active construction.**
> No live trading. Default mode is `PAPER`.

---

## What it is

Polyroot is an open, auditable prediction-market trading agent. It watches the
Polymarket order book, feeds evidence into an LLM that proposes trading
intents, and routes those intents through a risk-gated, deterministic executor.
Separation of *reasoning* (AI) from *execution* (code) is the core safety
property that distinguishes Polyroot from "ChatGPT-trades-my-wallet" bots.

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
- **AI never holds private keys** — it can only *propose* intents.
- **Every intent passes the same validator** — read / learn / propose only.
- **Executor is deterministic + auditable** — every order is a signed,
  logged, recoverable ledger event.
- **Risk engine reserves capital** — no intent can size itself beyond policy.

## Requirements

| # | Decision | Value |
|---|----------|-------|
| 1 | Upstream baseline | `alsk1992/CloddsBot` @ `715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8` (MIT, v1.9.0) |
| 2 | Runtime | Node.js **24 LTS** + TypeScript (strict) |
| 3 | Ledger DB | PostgreSQL (dev 16 / prod 17) |
| 4 | Build | npm workspaces (monorepo), Docker multi-stage, non-root |
| 5 | LLM providers | Anthropic + OpenAI (adapter-compatible) |
| 6 | Execution mode | `PAPER` by default; `LIVE` only after G4+ owner mandate |

## Documentation

- `docs/PRD_v1.0.md` — Product Requirements (53 reqs: 49 P0 + 4 P1; 9 groups)
- `docs/Blueprint_v1.0.md` — Technical design, architecture, risk/ledger/execution
- `docs/ARTEFAK/` — Architecture Decision Records (ADR-01 … ADR-06)

## Getting started (dev)

```bash
npm ci
docker compose up -d postgres
npm run migrate:latest
npm run dev          # starts gateway + executor in PAPER mode
```

## Repository layout

```
src/
├── cloddybot/          # pinned upstream fork (patch base)
└── pm/                 # Polyroot domain code
    ├── domain/         # entities: EvidenceItem, MarketSnapshot, Forecast, TradeIntent, ...
    ├── data/           # Postgres models + market-data/provider adapters
    ├── intelligence/   # LLM provider adapters + forecast service
    ├── strategy/       # strategy/quote engines
    ├── risk/           # EV, sizing, reservations, policy
    ├── executor/       # order lifecycle, signing (holds keys)
    ├── venue/          # @polymarket/client adapter (pinned)
    ├── ledger/         # events, projections, outbox
    ├── control/        # API routes, owner auth, commands
    └── observability/  # metrics, logging, alerts
migrations/             # SQL migration files (managed)
tests/pm/               # contracts / property / fixtures
```

## License

MIT — see [`LICENSE`](LICENSE). Original work from CloddsBot
(c) 2026 alsk1992, plus Polyroot modifications (c) 2026 Crypty Root.
