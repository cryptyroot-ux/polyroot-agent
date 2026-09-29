# PolyRoot Agent Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.4.0] - 2026-09-29

### ✨ Added — Comprehensive AI Provider Onboarding
- **30+ AI providers** in interactive onboarding: OpenAI, Qwen, xAI Grok, Xiaomi MiMo, Tencent Hy, NVIDIA NIM, GitHub Copilot ACP, Hugging Face, Google AI Studio, Google Vertex AI, DeepSeek, Z.AI/GLM, Kimi/Moonshot, StepFun, MiniMax, Ollama Cloud, Arcee AI, GMI Cloud, Kilo Code, OpenCode Go, AWS Bedrock, Azure Foundry, Vercel AI Gateway, Actual Computer, CommandCode (OpenAI-compatible), CommandCode (Anthropic), custom gateway, DeepInfra, Meta Muse Spark, Nebius Token Factory, Ramp Router, Upstage, Ollama (local)
- **Smart defaults per provider** — pre-filled base URLs, model lists, and default model selections
- **Special handling paths** for Ollama (local/stdio), Copilot (ACP stdio), Vertex AI (ADC), Bedrock (AWS IAM), Azure Foundry, and custom gateways
- **SHADOW mode now the onboarding default** — live data, simulated fills, $0 risk with configurable capital/loss caps

### 🔧 Fixed
- **TypeScript build** — corrected `specialHandling` type, `isSpecialHandling` type guard, and duplicate `copilot` case
- **Provider-label lookup** — menu labels carry descriptions in parentheses, config keys are short prefixes; lookup now matches longest-prefix so every one of the 33 providers resolves to its own base URL/models (previously only `custom` matched and all others silently fell through to the generic gateway prompt)
- **Onboarding E2E harness** — default markers updated for the 33-provider menu (`Select model`, `Paste your`); custom-gateway case selects entry 27
- **Version alignment** — all 14 workspace `package.json` bumped to 1.4.0 to match tag/CHANGELOG/README/landing

## [1.3.0] - 2026-09-28

### ✨ Added
- **Rich `run --once` transcript** — `--once` now prints a human-readable book → forecast → verdict transcript (same format as the landing-page terminal) before the machine-readable JSON line. Pure formatter, no trading-logic change; confidence figures are never fabricated.

## [1.2.0] - 2026-09-28

### ✨ Added — Beginner-friendly operator commands
- **`polyroot explain [--last N]`** — replays the latest AI decision chain (forecast → risk verdict → edge → action) from durable history
- **`polyroot halt [--cancel-orders]`** — emergency kill switch: engages the loss latch, cancels open orders, stops agents, exits(1) for supervisors
- **`polyroot health [--watch]`** — real-time probes: database, pipeline, RPC, venue, resources, with `--json` for monitoring
- **`polyroot insight [--market] [--heatmap]`** — transparent opportunity scoring (edge × confidence × liquidity), deep dives, risk heatmap
- **`polyroot backup/restore`** — AES-256-GCM encrypted state export with sha256 manifest; restore verifies checksums before `--apply`

### 🔧 Fixed — Pipeline persistence gap
- **Every G4 step now persists** (market snapshots, forecasts, paper/shadow decision logs) via a passive `emitStepComplete` observer — trading logic untouched
- **Exactly-once emission** moved to pipeline/loop choke points (early abstain returns previously never emitted)
- **Flush on `--once`/shutdown** so the last steps survive pool close
- **`polyroot mode` persists to `.env`** (previously DB-only, `run` kept reading stale mode)
- **Launcher no longer exports `NODE_ENV=production`** (it made `npm ci` prune devDependencies and break `update`)

### ✅ Verification
- 707 contract + 12 property tests passing, zero regressions; tsc/ESLint/Prettier clean
- Live-verified on reference VPS: SHADOW run → rows → `explain` shows the real chain

## [1.1.0] - 2026-09-27

### 🎉 Major Release — Production-Ready Core

This release marks the first production-ready version for self-hosted open-source deployment. All core safety guards, live trading pipeline, and operator tooling are stabilized.

### ✨ Added
- **Complete PAPER → SHADOW → MICRO_LIVE → LIVE pipeline** with fail-closed promotion gates
- **Live Market Universe** (`POLYROOT_MARKET_IDS`) — owner-curated CLOB token IDs, mock data refused outside PAPER
- **Encrypted Keystore** — `wallet seal` command creates scrypt + AES-256-GCM encrypted keystore; signer prefers keystore over raw hex
- **Autonomy Bounds** — owner-adjustable capital cap, daily loss cap (bps), max order size, max concurrent orders via `polyroot setup`
- **Strict LIVE Preflight** — `doctor --live` validates DB, wallet distinctness, loss cap, market universe, venue credentials, RPC
- **Executor Settlement in Cash Units** — atomic reservation + permit + claim receipt + wired accounting
- **DB-Backed Seen Store** — restart replay with durable idempotency log
- **Batch Reservation Expiry** — periodic job expires stranded ACTIVE reservations
- **Security Headers on Metrics Server** — HSTS, CSP, X-Frame-Options, Referrer-Policy
- **Single Shared Pool** — orchestrator-pg accepts injected pool, no leak on shutdown
- **Dynamic Mode Hot-Reload** — ModeWatcher polls DB, triggers callbacks, fail-closed to READ_ONLY after 3 failures
- **Autonomous LIVE Safety Design** — loss-cap latch, SHADOW baseline, reality-gap gate, G5 promotion pack
- **Full English Repo Audit** — all docs, CLI, guides translated to English; CLI greetings and onboarding in plain English
- **Lay-Friendly Onboarding** — `polyroot setup` interactive wizard with shared stdin session, sudo-style hidden secrets
- **Staging Deploy Guide** — auto-discovery, shadow-fund, console monitoring instructions

### 🔧 Changed
- **Wallet Verification** — `polyroot wallet verify` validates key, address, account/funder distinctness (WAL-03), keystore support
- **Onboarding Prompts** — Hermes-style UX, trader-aware defaults, hidden secret input
- **Documentation Truthfulness** — public `/healthz` without metrics key; honest HTTP docs
- **Gitleaks Baseline** — clean baseline, deduped ignore entries

### 🛡️ Security
- **REFUSE_LIVE_WITH_STUBS** — MICRO_LIVE/LIVE requires explicit `cryptoSigner` + `venueAdapter`
- **Lease Release Guarantee** — executor releases lease on all validation failure paths
- **Critical Trading Chain Audit Fixes** — reservation leak, permit integrity, lease safety, idempotency
- **Socket Hardening** — buffer cap, writeLine guard, timeout enforcement

### 🧪 Testing
- 597 contract tests (679 total after v1.1)
- 12 property tests (Money Kernel exact arithmetic, Risk Engine properties)
- 96/96 structural traceability (PRD ↔ Blueprint ↔ Code ↔ Tests)
- Adversarial red-team findings on own gates (Phase 28)

### 📚 Documentation
- Updated `README.md` with one-line installer, console UX, true test counts (675+12)
- Updated `.env.example` with polyroot invocations, working RPC default, discovery vars
- Updated `RUNBOOK_SHADOW_MICROLIVE.md` with auto-discovery, shadow-fund, console monitoring
- Updated `STAGING_DEPLOY.md` with production deployment instructions
- Updated `CONTRIBUTING.md` with test database setup and troubleshooting

---

## [0.1.6] - 2026-09-24

### Added
- Live market universe iteration (`POLYROOT_MARKET_IDS`)
- Encrypted keystore with scrypt + AES-256-GCM (`wallet seal`)
- Live enforcement: exposure cap, durable loss latch, SHADOW-baseline startup gate

---

## [0.1.5] - 2026-09-24

### Added
- Live guard wiring: capital cap, loss-cap latch, SHADOW-baseline startup gate

---

## [0.1.4] - 2026-09-24

### Added
- CLOB order translation + SHADOW public reads + runbook

---

## [0.1.3] - 2026-09-24

### Added
- Authenticated secure venue client + CLOB-shape guard

---

## [0.1.2] - 2026-09-24

### Fixed
- Public `/healthz` without metrics key
- Truthful HTTP documentation

---

## [0.1.1] - 2026-09-24

### Added
- Production readiness: observability hooks, security audit script, charter commissioning

---

## [0.1.0-stable] - 2026-09-23

### Added
- Initial stable release with core architecture:
  - AI/Executor separation (controlled autonomy)
  - Money Kernel with exact integer arithmetic
  - Risk Engine: EV Calculator, SizingEngine (Kelly), ReservationManager
  - Executor: idempotency, no blind retry, permit TTL, lease fencing
  - Ledger: recovery ledger, catalyst bus with watermark
  - Intelligence: source registry, evidence weighting, forecast ensemble, model lineage
  - Untrusted content boundary (PM-AI-04)
  - Venue adapter capability contract
  - Strategy sandbox process isolation

---

## [Unreleased]

### Upcoming (Post v1.1.0 Roadmap)
- Multi-market intent / hedge orders
- GUI dashboard (metrics + control)
- Strategy marketplace / plugin system
- Better reality-gap visualization
- Mobile/Telegram notifications
- Portfolio rebalancing automation
- Legacy CTF V1 support (if needed)

---

## Release Verification Checklist (v1.1.0)

- [x] All package.json versions bumped to 1.1.0
- [x] CHANGELOG.md updated with all releases
- [x] PR #40 merged (English repo audit, CLI sync)
- [x] Build: `npm run build` → 13/13 packages
- [x] Tests: `npm run test` → 597/597 pass
- [x] TypeCheck: `npm run typecheck` → clean
- [x] Lint: `npm run lint` → clean
- [x] Traceability: `npm run traceability` → 96/96
- [x] Gitleaks: `gitleaks detect` → no leaks
- [x] Tag created: `v1.1.0`

---

**Note for Users**: This is **self-hosted open-source software**. You bring your own keys, wallet, RPC, and infrastructure. No custodial service. No guaranteed returns. Test thoroughly in PAPER/SHADOW before MICRO_LIVE/LIVE. Audit the code. Understand the risks. Use at your own risk.