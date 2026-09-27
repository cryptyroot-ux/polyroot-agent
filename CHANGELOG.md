# PolyRoot Agent Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

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