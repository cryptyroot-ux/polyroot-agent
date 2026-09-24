# PolyRoot Agent

**Autonomous AI trading agent for Polymarket** — a fork of
[CloddsBot](https://github.com/alsk1992/CloddsBot) built with a **controlled
autonomy** architecture: the AI proposes intents only, while a separate
deterministic **Executor** signs and submits orders. The AI never holds private
keys.

> **Status: v1.1-stable — PAPER → SHADOW → MICRO_LIVE → LIVE pipeline ready**
> Production-ready with G4 autonomous pipeline, G5 infrastructure, and 365 passing tests.
> Default mode is `PAPER`. Live trading requires explicit Autonomy Charter commissioning.

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

---

## Quick Start (Development)

### Prerequisites

- **Node.js ≥ 24.0.0**
- **PostgreSQL 15+** (local or Docker)
- **npm 11+** (comes with Node.js 24)

### 1. Clone & Install

```bash
git clone https://github.com/cryptyroot-ux/polyroot-agent.git
cd polyroot-agent
npm ci
```

### 2. Start Database

```bash
# Option A: Docker (recommended)
docker compose up -d postgres

# Option B: Local PostgreSQL
# Ensure DATABASE_URL in .env points to your instance
```

### 3. Configure Environment

```bash
cp .env.example .env
# Edit .env with your settings (see Configuration section below)
```

### 4. Run Migrations

```bash
npm run migrate:latest
```

### 5. Build & Run (PAPER Mode)

```bash
npm run build
npm run dev          # Starts gateway + executor in PAPER mode
```

### 6. Verify Installation

```bash
npm run test:unit        # 341 contract + 12 property + 12 unit = 365 tests
npm run traceability     # 96/96 structural traceability
npm run build            # 13/13 packages pass
npm run lint && npm run typecheck
```

---

## Production Installation

### 1. Server Requirements

- **OS:** Linux (Ubuntu 22.04+ / Debian 12+)
- **RAM:** ≥ 4 GB (8 GB recommended for SHADOW mode)
- **Disk:** ≥ 20 GB SSD (PostgreSQL + logs)
- **Network:** Stable connection to Polygon RPC + Polymarket API

### 2. Install Dependencies

```bash
# Install Node.js 24 (via nvm or binary)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PostgreSQL 15
sudo apt-get install -y postgresql-15 postgresql-client-15

# Install pnpm (optional, faster than npm)
npm install -g pnpm
```

### 3. Database Setup

```bash
sudo -u postgres createuser --superuser polyroot
sudo -u postgres createdb -O polyroot polyroot
sudo -u postgres psql -c "ALTER USER polyroot WITH PASSWORD 'secure_password';"
```

### 4. Application Deploy

```bash
# Clone to deployment directory
cd /opt
git clone https://github.com/cryptyroot-ux/polyroot-agent.git
cd polyroot-agent

# Install production dependencies
npm ci --omit=dev

# Build all packages
npm run build
```

### 5. Production Configuration

Create `/opt/polyroot-agent/.env`:

```env
# Database
DATABASE_URL=postgresql://polyroot:secure_password@localhost:5432/polyroot

# Wallet (Deposit Wallet / Type 3 for Polymarket)
WALLET_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
WALLET_ADDRESS=0xYOUR_WALLET_ADDRESS
CHAIN_ID=137

# RPC (Polygon Mainnet)
RPC_URL=https://polygon-rpc.com
# Or use Alchemy/Infura for reliability:
# RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY

# Runtime
NODE_ENV=production
LOG_LEVEL=info
# START WITH PAPER FOR VERIFICATION
RUNTIME_MODE=PAPER

# G4 Pipeline Config
G4_MICRO_LIVE_CAP_USD=500
G4_MIN_EDGE_AFTER_COST=0.03
G4_SHADOW_MIN_DAYS=30
G4_SHADOW_MIN_CLUSTERS=100

# Observability
METRICS_PORT=9090
HEALTH_PORT=8080
```

### 6. Run Migrations

```bash
npm run migrate:latest
```

### 6. Commission Autonomy Charter (Required for LIVE Mode)

---

## Troubleshooting

| Symptom                         | Likely Cause                          | Fix                                                                                        |
| ------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run ci` fails on typecheck | Strict TS config                      | Ensure `verbatimModuleSyntax: true`, `exactOptionalPropertyTypes: true` in `tsconfig.json` |
| Database connection refused     | Postgres not running or wrong URL     | Verify `docker compose ps` or local service, check `DATABASE_URL` in `.env`                |
| Wallet errors: invalid key      | Incorrect private key format          | Must be 0x-prefixed 64 hex bytes (32 bytes)                                                |
| RPC timeout/failure             | Network or endpoint issue             | Test RPC URL with curl, verify Polygon Mainnet reachable                                   |
| Gateway fails to start          | Port already in use                   | Kill existing process on 3000/8080/9090 or change ports                                    |
| MICRO_LIVE rejects orders       | Capital cap exceeded                  | Reduce intent size or increase `G4_MICRO_LIVE_CAP_USD`                                     |
| SHADOW→MICRO promotion blocked  | Reality gap or slippage bias too high | Wait for more evidence, adjust tolerances                                                  |
| Gitleaks detects secrets        | Accidental credential in code/logs    | Remove secrets, run `git reset --hard`, add to `.gitleaksignore` if false positive         |
| Observability metrics missing   | Metrics server not started            | Ensure `METRICS_PORT` and `HEALTH_PORT` are set and not firewalled                         |

### Common Commands

```bash
# Full CI locally
npm run ci

# Run only unit tests
npm run test:unit

# Run contract tests
npm run test:contract

# Run property tests
npm run test:property

# Check formatting
npx prettier --check .

# Fix formatting
npx prettier --write .

# Traceability gate (PRD↔Blueprint)
npm run traceability

# Generate release manifest
node scripts/generate-manifest.mjs

# Run Gitleaks scan
gitleaks detect --source . --no-git --baseline-path .gitleaks_baseline.json --verbose

# Build Docker image
docker build -t polyroot/trader:dev .

# Start PostgreSQL via Docker
docker run -d --name postgres -e POSTGRES_USER=polyroot -e POSTGRES_PASSWORD=secure_password -e POSTGRES_DB=polyroot -p 5432:5432 postgres:16-alpine
```

---

## Configuration Reference

See [`docs/PUBLIC_API.md`](docs/PUBLIC_API.md) for full API reference, runtime modes, observability, and integration examples.

### Environment Variables (`.env`)

| Variable                 | Description                                   | Example                                                         |
| ------------------------ | --------------------------------------------- | --------------------------------------------------------------- |
| `DATABASE_URL`           | PostgreSQL connection string                  | `postgresql://polyroot:secure_password@localhost:5432/polyroot` |
| `WALLET_PRIVATE_KEY`     | Deposit wallet private key (0x-prefixed)      | `0xa1b2c3d4...`                                                 |
| `WALLET_ADDRESS`         | Derived wallet address (0x-prefixed)          | `0xAbCdEf12...`                                                 |
| `CHAIN_ID`               | Polygon = 137                                 | `137`                                                           |
| `RPC_URL`                | Polygon RPC endpoint (HTTPS)                  | `https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY`             |
| `NODE_ENV`               | `development` \| `production`                 | `production`                                                    |
| `LOG_LEVEL`              | `debug` \| `info` \| `warn` \| `error`        | `info`                                                          |
| `RUNTIME_MODE`           | `PAPER` \| `SHADOW` \| `MICRO_LIVE` \| `LIVE` | `PAPER`                                                         |
| `G4_MICRO_LIVE_CAP_USD`  | Max capital in MICRO_LIVE (USDC)              | `500`                                                           |
| `G4_MIN_EDGE_AFTER_COST` | Min probability edge after fees               | `0.03`                                                          |
| `G4_SHADOW_MIN_DAYS`     | Min SHADOW baseline days                      | `30`                                                            |
| `G4_SHADOW_MIN_CLUSTERS` | Min resolved clusters for SHADOW              | `100`                                                           |
| `METRICS_PORT`           | Prometheus metrics port                       | `9090`                                                          |
| `HEALTH_PORT`            | Health check port                             | `8080`                                                          |

---

## License

MIT License with upstream CloddsBot attribution. See [`LICENSE`](LICENSE).

---

_Status: Production-ready. Live deployment requires Autonomy Charter sign-off and G5 promotion gates passing._
