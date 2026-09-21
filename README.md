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

# Mode: PAPER | SHADOW | MICRO_LIVE | LIVE
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

```bash
# Run once to create charter (adjust values as needed)
npx tsx scripts/commission-charter.ts \
  --wallet-id 0xYOUR_WALLET_ADDRESS \
  --capital-usd-cap 500 \
  --daily-loss-stop-pct 0.05 \
  --strategy-ids strat_001,strat_002 \
  --market-classes binary,crypto,sports \
  --expires-days 365 \
  --release-ref v0.1.0-stable \
  --output autonomy-charter.json
```

Store `autonomy-charter.json` securely and reference it in your process manager config.

### 7. Process Management (systemd)

Create `/etc/systemd/system/polyroot.service`:

```ini
[Unit]
Description=PolyRoot Autonomous Trading Agent
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=polyroot
WorkingDirectory=/opt/polyroot-agent
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/gateway/main.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=polyroot

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/polyroot-agent/logs

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now polyroot
sudo journalctl -u polyroot -f  # View logs
```

---

## Configuration Reference

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://user:pass@host:5432/db` |
| `WALLET_PRIVATE_KEY` | Private key for Deposit Wallet (Type 3) | `0xabc123...` |
| `WALLET_ADDRESS` | Wallet address (derived from key) | `0x1234...` |
| `RPC_URL` | Polygon RPC endpoint | `https://polygon-rpc.com` |
| `CHAIN_ID` | Polygon chain ID | `137` |

### Runtime Mode

| Mode | `RUNTIME_MODE` | Financial I/O | Use Case |
|------|----------------|---------------|----------|
| `PAPER` | `PAPER` | ❌ Simulated | Development, testing |
| `SHADOW` | `SHADOW` | ❌ Live data only | Validation, 30-day baseline |
| `MICRO_LIVE` | `MICRO_LIVE` | ✅ Capped real | Small capital live test |
| `LIVE` | `LIVE` | ✅ Full autonomy | Production (requires Charter) |

### G4 Pipeline Tuning

```env
# Capital caps
G4_MICRO_LIVE_CAP_USD=500           # Max USD for MICRO_LIVE
G4_MICRO_LIVE_CAP_BASE=100000000    # Base units (100M = $100 USDC)

# Risk thresholds
G4_MIN_EDGE_AFTER_COST=0.03         # 3% minimum edge after fees
G4_DAILY_LOSS_STOP_PCT=0.05         # 5% daily loss stop

# SHADOW gate criteria
G4_SHADOW_MIN_DAYS=30               # Minimum days of SHADOW operation
G4_SHADOW_MIN_CLUSTERS=100          # Minimum resolved independent clusters

# Paper simulator
G4_PAPER_CANCEL_PROBABILITY=0.05
G4_PAPER_PARTIAL_FRACTION=0.8
G4_PAPER_LATENCY_MS=50
```

---

## Usage Guide

### Mode Progression

```
PAPER (default) ──► SHADOW ──► MICRO_LIVE ──► LIVE
     │               │            │             │
     ▼               ▼            ▼             ▼
  Simulated     Live data,    Capped real    Full autonomy
  fills only    no money      capital        (Charter required)
```

### 1. PAPER Mode (Default)

```bash
RUNTIME_MODE=PAPER npm run dev
```

- Zero financial I/O
- Simulated fills via `paper-engine.ts`
- Full pipeline: Intelligence → Strategy → Risk → Order → Simulated Fill
- Metrics logged to console / Prometheus

### 2. SHADOW Mode (Validation)

```bash
RUNTIME_MODE=SHADOW npm run dev
```

- Consumes live Polymarket data
- **No financial I/O** — no orders submitted
- Records decisions to `shadow_log` table
- Tracks resolved clusters in `resolved_clusters`
- **Requirement for G5 gate:** 30 days + 100 resolved independent clusters

### 3. MICRO_LIVE Mode (Capped Live)

```bash
RUNTIME_MODE=MICRO_LIVE G4_MICRO_LIVE_CAP_USD=100 npm run dev
```

- Real wallet, real fills
- **Hard capital cap** enforced by G4 pipeline (`microLiveCapUsd`)
- Real settlement, real PnL
- Use for small-cap validation before LIVE

### 4. LIVE Mode (Full Autonomy)

**Prerequisites:**
- ✅ Autonomy Charter commissioned (`autonomy-charter.json` exists)
- ✅ 30-day SHADOW baseline complete (100+ resolved clusters)
- ✅ MICRO_LIVE validation successful
- ✅ Owner explicit approval

```bash
RUNTIME_MODE=LIVE npm run dev
```

- Full autonomy within Charter bounds
- Charter enforces: capital cap, qualified strategies, market classes, expiry
- Governance actions (raise capital, change signer, extend) require owner intervention

---

## Monitoring & Observability

### Health Checks

```bash
# HTTP health endpoint
curl http://localhost:8080/health

# Response:
# {"status":"healthy","mode":"PAPER","uptime_sec":3600,"db":"connected"}
```

### Metrics (Prometheus)

```bash
# Metrics endpoint
curl http://localhost:9090/metrics

# Key metrics:
# polyroot_g4_total_orders
# polyroot_g4_filled_orders
# polyroot_g4_total_pnl_usd
# polyroot_g4_current_exposure_usd
# polyroot_g4_max_drawdown_pct
# polyroot_g4_financial_gate_status (0=ALLOW, 1=ENTRY_BLOCKED, 2=FINANCIAL_BLOCKED)
```

### Logs

```bash
# Structured JSON logs (stdout)
# Levels: debug, info, warn, error
# Fields: timestamp, level, component, message, context

# Filter G4 decisions:
journalctl -u polyroot -f | jq 'select(.component=="g4-loop")'
```

---

## Key Commands Reference

| Command | Description |
|---------|-------------|
| `npm run build` | Build all 13 packages (TypeScript → dist/) |
| `npm run dev` | Start gateway + executor (PAPER mode) |
| `npm run dev:gateway` | Start only gateway (control plane) |
| `npm run dev:executor` | Start only executor |
| `npm run test:unit` | Run 365 contract + property tests |
| `npm run test:contract` | Run contract tests only |
| `npm run test:property` | Run property-based tests only |
| `npm run test:migration` | Run DB migration integration tests |
| `npm run migrate:latest` | Apply all pending migrations |
| `npm run migrate:status` | Show migration status |
| `npm run migrate <name>` | Run specific migration |
| `npm run lint` | ESLint across all packages |
| `npm run typecheck` | TypeScript strict check |
| `npm run traceability` | Verify 96/96 requirement traceability |
| `npm run ci` | Full CI pipeline (typecheck + lint + test + build) |

---

## G4 Pipeline Modes — Technical Details

### G4AutonomousLoop (Runtime)

```typescript
// src/pm/runtime/src/g4-loop.ts
const loop = createG4Loop({
  config: { mode: "SHADOW", minEdgeAfterCost: 0.03 },
  kernel: moneyKernel,
  signer: signerVault,
  executor: polymarketExecutor,
  wallet: walletIdentity,
  policy: riskPolicy,
  policyHash: "sha256...",
  venueMode: () => venueAdapter.getMode(),
  leaseEpoch: () => currentEpoch,
  now: () => new Date(),
  forecast: intelligence.forecast,
  sizeIntent: strategy.sizeIntent
});

// Run single market step
const result = await loop.step({
  market_id: "0x123...",
  bid: 0.45,
  ask: 0.48
});

// Or batch
const results = await loop.runPass(markets);
```

### G4Pipeline (Orchestration)

```typescript
// src/pm/runtime/src/g4-pipeline.ts
const pipeline = createG4Pipeline({
  config: { mode: "MICRO_LIVE", microLiveCapUsd: 100 },
  // ... same deps as loop
});

const result = await pipeline.processMarket({
  market_id: "0x123...",
  bid: 0.45,
  ask: 0.48,
  currentMarketExposureUsd: 50,
  currentPortfolioExposureUsd: 200
});
```

### Financial Gate

```typescript
// Automatic enforcement in G4 core
const gate = computeFinancialGate(mode, venueMode, minEdgeAfterCost);
// Returns: "ALLOW" | "ENTRY_BLOCKED" | "FINANCIAL_BLOCKED"

// Blocks:
// - LIVE mode without Charter
// - SHADOW/MICRO_LIVE when venue is UNAVAILABLE/UNKNOWN/READ_ONLY
// - Edge below minEdgeAfterCost
```

---

## Autonomy Charter — Governance

### Charter Fields

```json
{
  "charter_id": "uuid-v4",
  "wallet_id": "0x1234...",
  "capital_usd_cap": 500,
  "daily_loss_stop_pct": 0.05,
  "qualified_strategy_ids": ["strat_001", "strat_002"],
  "market_class_allowlist": ["binary", "crypto", "sports"],
  "expires_at": "2027-09-22T00:00:00.000Z",
  "release_ref": "v0.1.0-stable",
  "commissioned_at": "2026-09-22T00:00:00.000Z"
}
```

### Enforcement

| Action | Allowed in Routine Autonomy? |
|--------|------------------------------|
| SUBMIT, CANCEL, REDUCE, EXIT, REDEEM | ✅ Yes (within Charter bounds) |
| PROMOTE_STRATEGY | ❌ Owner governance only |
| INCREASE_CAPITAL | ❌ Owner governance only |
| CHANGE_SIGNER | ❌ Owner governance only |
| EXTEND_CHARTER | ❌ Owner governance only |

**Hard policy CANNOT self-weaken** — no strategy/LLM/plugin can bypass Charter bounds.

---

## Troubleshooting

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Financial gate: ENTRY_BLOCKED` | Venue mode ≠ NORMAL | Check `venueAdapter.getMode()` |
| `Financial gate: FINANCIAL_BLOCKED` | LIVE without Charter / Edge too low | Commission Charter or check edge |
| `CHARTER_EXPIRED` | `expires_at` passed | Commission new Charter |
| `STRATEGY_NOT_QUALIFIED` | Strategy ID not in Charter | Add to `qualified_strategy_ids` |
| `CAPITAL_CAP_EXCEEDED` | Exposure > `capital_usd_cap` | Reduce position or increase cap |
| `MIGRATION_FAILED` | DB schema mismatch | Run `npm run migrate:status` then `npm run migrate:latest` |
| `DATABASE_URL` connection refused | PostgreSQL not running / wrong creds | Check `systemctl status postgresql` |

### Debug Mode

```bash
LOG_LEVEL=debug RUNTIME_MODE=PAPER npm run dev
```

---

## Security Notes

- **Private keys never leave Signer Vault** — Executor is the only component with key access
- **AI/Intelligence runs in isolated sandbox** — no network, DB, or shell access
- **All financial actions require valid Permit** — issued by Risk Gate after reservation
- **Permits are single-use, immutable, and bound to reservation** — replay impossible
- **SSRF/Egress protection** — Research boundary blocks private IPs, metadata endpoints
- **Rate limiting & CSRF** — Security proxy on all ingress

---

## License

MIT — see [`LICENSE`](LICENSE). Original work from CloddsBot
(c) 2026 alsk1992, plus PolyRoot modifications (c) 2026 Crypty Root.

---

## Support & Contributing

- **Issues:** [GitHub Issues](https://github.com/cryptyroot-ux/polyroot-agent/issues)
- **Discussions:** [GitHub Discussions](https://github.com/cryptyroot-ux/polyroot-agent/discussions)
- **Security:** Report vulnerabilities to security@polyroot.fun

**PolyRoot is production-ready software. Deploy responsibly. Trade at your own risk.**