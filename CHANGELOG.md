# PolyRoot Agent Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.7.0] - 2026-09-29

### ✨ Added — the learning loop closes (resolutions → calibration)
- **Resolution recorder** (`venue/resolution-recorder.ts`) — polls Gamma `closed=true`, converts final `outcomePrices` into per-token win/loss facts (exactly-one-side->0.5 rule; splits/voids skipped, never guessed), idempotent sha256-clustered inserts into `resolved_clusters`
- **Training from resolutions** — `trainFromResolvedClusters()` joins forecasts ⨝ resolutions per (model, horizon); under-sampled groups keep their old map, never force-trained
- **Calibrate wired fail-open into the live forecast path** — identity until the first real map lands (zero behavior change today; proven by the suite: trained maps lift winners and shrink losers)
- **Resolution sync scheduler** (`runtime/resolution-sync.ts`) — hourly tick + boot tick, started/stopped with the agent (`POLYROOT_RESOLUTION_SYNC=0` disables); every stage fail-open, trading never blocks on learning
- **Multi-outcome arb detector** (`strategy/multi-outcome-arb.ts`) — BUY_ALL_YES / BUY_ALL_NO baskets with per-leg Θ fees; pure + tested (live entry wiring pending shadow validation — detection only, no fills)

## [1.6.0] - 2026-09-29

### ✨ Added — live mode hot-reload (no restart)
- **ModeWatcher wired into `G4Pipeline`** — the loop re-reads `live_guard_state` every pass: `polyroot mode X` takes effect live. Invalid jumps refused (stay + warn, transition table enforced); DB loss degrades to READ_ONLY (entries halt, fail-closed); watcher lifecycle owned by the pipeline (start on run, stop on shutdown)
- **`polyroot status` shows supervisor state** — active/enabled, missing unit, or manual-mode (hermetic via `POLYROOT_NO_SYSTEMD=1`)

### 🔧 Fixed — strategy correctness
- **QuoteEngine priced its own token side** — BUY/YES intents were edged against `no_price` (every sign inverted); bare BUY/SELL without a token side is now invalid (fail-closed); size scales down to resting depth (no book-walking)
- **Real isotonic calibration** — `train()` fits pool-adjacent-violators from resolved samples (refuses <20: noise dressed as math); `calibrate()` interpolates the stored map, identity when untrained. Replaces the fabricated `p*0.9` shrink. Live wiring waits on the resolution feed (`resolved_clusters` unwired) — noted, not faked
- **Float-hardened regime gate** — exact 2¢ spreads (0.52−0.50) no longer slip the TIGHT_CONSENSUS block via float dust

## [1.5.0] - 2026-09-29

### ✨ Added — 24/7 systemd supervisor (automatic)
- **`scripts/polyroot.service.template`** — unit runs the trading loop (`cli.js run`, never the bare console) with `Restart=always`, journal logging, `WantedBy=multi-user.target`; zero secrets, zero hardcoded paths, no brittle `Requires=` on distro postgres units
- **`scripts/install-systemd.sh`** — renders the template (`--home/--user/--node`, `--print` for inspection, `SYSTEMD_DIR` override for tests); real installs do `daemon-reload` + `reset-failed` (clears stale crash-loops) + `enable`, and only auto-start when `.env` exists (never boot-loop an un-onboarded box); skips gracefully without PID-1 systemd
- **`install.sh` wiring** — every fresh install gets the service best-effort; `polyroot restart` now prints `systemctl restart polyroot` when the unit is loaded (nohup remains the fallback)

### 🔧 Fixed
- Replaces ad-hoc units pointing at wrong paths/entrypoints (`dist/control/src/index.js`) that crash-looped tens of thousands of times
- **`polyroot update` now delivers everything alone** — auto-migrate (idempotent, manual command stays as fallback) + supervisor unit refresh + `try-restart` of a running service, so operators only ever run one command

### 📈 Strategy upgrades — research-backed (audit P0/P1)
- **CLOB Θ fee model** — taker fee now `Θ·p·(1−p)` per share (Θ=0.05, CFTC filing 2026) instead of flat 200bps: mid-price books price their true cost; explicit flat overrides still win (backward compatible)
- **Regime enforcement** — `DUST`/`TIGHT_CONSENSUS` books now abstain in `executeG4Step` (classifier was display-only); taker flow can never clear cost on ≤2¢ spreads. Spread comparison hardened against float dust (0.52−0.50)
- **Favorite-longshot guard** — +2pp edge premium under 10¢ / over 90¢ (measured ~19.3¢/$ longshot loss on Polymarket, Cardozo & Rivero-Wildemauwe 2026)
- **Expiry guards** — Gamma `endDate` plumbed through discovery; near-expiry gambles rejected (`POLYROOT_DISCOVERY_MIN_HOURS_TO_EXPIRY`, default 2h) + distant-expiry edge premium (+0.5pp 7–30d, +1pp >30d, Page 2013)
- **Wash/depth filter** — touch sizes from the CLOB book feed depth-notional + volume/depth churn gates (`POLYROOT_DISCOVERY_MIN_TOUCH_DEPTH_USD` $25, `POLYROOT_DISCOVERY_MAX_CHURN_RATIO` 2000); price-only touches keep legacy spread verdict
- **Fractional-Kelly sizing** — quarter-Kelly on the touch price, hard-capped at the legacy 100 shares (entries can only shrink, never grow); $100 bankroll stakes dollars
- **Ensemble honesty** — both PG stores count real distinct families instead of hardcoded 1
- **Latent fix (found by the suite)** — `parseArgs` SHADOW default had silently disabled `RUNTIME_MODE` validation; explicit `--mode` now wins, set-but-invalid env throws

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