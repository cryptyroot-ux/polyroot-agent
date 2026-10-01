# PolyRoot Agent Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### ✨ Added

- **PM-OBS-01 Telegram agent stream** — every G4 loop stage (research ingest, evidence weight, universe scan, forecast, reasoning, risk gate, order submit/fill, no-trade, errors) is pushed in real time to the owner's Telegram DM via a `G4CoreObservability` fan-out in `bootstrapAgent`. Fire-and-forget with failure backoff, 30/min rate cap, HTML-escaped fields, and outbound secret redaction — a dead Bot API never touches the trading loop

### ✨ Changed

- **Telegram agent stream v2 (PM-OBS-01 refinement)** — per-pass digest with real market names and scanned/evaluated/deferred counts; per-market reports (question, book, AI probability + verbatim reasoning, decision + reason, money at stake) in full English; NO_TRADE reported once per reason; `--once` runs stay silent

## [1.14.2] - 2026-09-30

### 🔧 Fixed

- **Onboarding preserves unmanaged `.env` keys** — re-running onboarding no longer wipes integrations configured afterwards (Telegram token/owners, custom RPC). Managed keys are rewritten, everything else is carried over under a marked section

## [1.14.1] - 2026-09-30

### 🔧 Fixed (critical — found via a real exposed-key incident)

- **Arrow menu accepts piped/scripted input**: raw-mode Enter arrives as LF (`linefeed`), not CR — previously any piped menu selection hung to EOF and aborted setup. Multi-digit choices now buffer fast digit runs ("28" → #28). Proven over a real pty
- **Credential handling rule**: secrets must never travel through piped stdin in automation — pty echo can surface them in logs. Onboarding keeps interactive secret entry; automation uses files with 600 perms

## [1.14.0] - 2026-09-30

### ✨ Added — guided Telegram setup (zero file editing)

- **`polyroot telegram setup` wizard** (Hermes-style: detect, don't dictate) — BotFather walkthrough → paste token → verified live via `getMe` (wrong tokens re-ask, offline fails gracefully) → owner auto-detect by DMing the bot anything (numeric ID only, usernames refused) with manual-entry fallback → writes `.env` (600) → offers immediate service restart
- No `.env` hand-editing anywhere in the flow; token never printed or logged

## [1.13.0] - 2026-09-30

### ✨ Added — Telegram remote (read-first control)

- **Transport**: Bot API long-polling over native fetch (zero new deps), offset-tracked, stale queue dropped on boot, 4096-char chunking, `/` menu registered
- **Pairing**: strangers get ID + 8-char code (sha256 stored, 1h expiry, deduped); owner approves via `polyroot telegram approve <CODE>`; numeric IDs only (CVE-2026-28480 class), groups silently dropped, per-user rate limit
- **Command tiers**: read (`status explain insight health markets logs help`) free · confirm-on-YA (`halt restart update mode model provider`) · refused with terminal instructions (`setup`, keys, guard, `run`, mode-UP)
- **Safety specifics**: mode-DOWN blocked with open exposure; mode-UP never via chat; provider switch only to credentialed options; secrets refused inbound + scrubbed outbound; every command audited to DB (migration `0025_telegram`)
- **Ops**: `polyroot telegram <approve|list|revoke|allow|status>`; auto-starts with the loop when configured, fail-open otherwise; `POLYROOT_NO_SYSTEMD`-style escape via unset token

## [1.12.0] - 2026-09-30

### ✨ Added — ChatGPT subscription login (Codex OAuth, no API key)

- **Provider #2 `OpenAI (ChatGPT login via Codex OAuth)`** — spends the owner's ChatGPT Plus/Pro/Team subscription instead of metered credit. Reuses the Codex CLI login read-only, refreshes short-lived tokens automatically (persisted back for `codex` too), speaks the Codex Responses backend
- **Hermes-aligned model discovery** — live per-account catalog from `{base}/models` with a curated fallback of only backend-accepted slugs (dead `-pro`/retired slugs never reach the picker); **same pattern applied to OpenAI API keys** (option #1 renamed `OpenAI API key`, key asked first, models auto-listed)
- Onboarding asks credentials before catalog in both paths; `.env` writes `POLYROOT_FORECAST_PROVIDER=codex` with no API key line

## [1.12.0] - 2026-09-30

### ✨ Added — ChatGPT subscription login (Codex OAuth, no API key)

- **New provider `OpenAI (ChatGPT login via Codex OAuth)` at menu #2** — spends the owner's ChatGPT Plus/Pro/Team subscription instead of metered API credit. Reuses the Codex CLI login read-only (`~/.codex/auth.json`), refreshes short-lived tokens automatically (persisted back for `codex` too), speaks the Codex Responses backend (`/responses`) with Bearer + account headers
- **Honest boundaries**: API-key-shaped Codex logins are rerouted (not misfired as OAuth); missing/expired logins print exact `codex login` / `--device-auth` guidance; unofficial-for-third-party status documented in code
- **Onboarding**: login detection + status display, model slug + backend URL prompts (both overridable), reachability probe with continue-anyway, `.env` writes `POLYROOT_FORECAST_PROVIDER=codex` and never an API key

## [1.11.5] - 2026-09-30

### 🔧 Fixed (root-caused, not masked)

- **`--help` works before setup and never truncates** — two stacked bugs: (1) on machines without `~/.polyroot/.env` the flag fell into first-run onboarding instead of printing help (the suite never caught it because the dev machine happened to have an install); (2) `console.log` + `process.exit(0)` can cut piped stdout under load. Help is now extracted to `printHelp()`, intercepted first in `main()`, and written with one synchronous fd write
- **Hermetic CLI spawn tests** — restart/explain harnesses now use temp HOME + stub `.env`, so the suite is green with or without an ambient install (proven: full 850 green on a box with no `~/.polyroot`)

## [1.11.5] - 2026-09-30

### ✨ Changed

- **New GitHub landing**: centered banner with badges, tagline and quick links; upstream fork branding removed from all user-facing surfaces (README, package description). Provenance + MIT attribution stay intact where they belong: `LICENSE`, `Blueprint_v1.1.md`, `docs/implementation/`, spec pack

## [1.11.4] - 2026-09-30

### 🔧 Fixed (found in a live operator session)

- **Console tolerates `polyroot …` prefix** — retyping the binary inside its own console (`polyroot logs --follow`) now works instead of erroring
- **`logs` reads the journal on supervised installs** — file logs don't exist under systemd, so `logs`/`logs --follow` falls back to `journalctl -u polyroot` (graceful message when neither exists)

## [1.11.3] - 2026-09-30

### 🔧 Fixed

- **`polyroot explain` shows the last 5 decisions by default** (was 1 — operators saw a single row and assumed the agent was idle). `--last N` override and 20-cap unchanged
- Timestamps are UTC (`…Z`); WIB = UTC+7. A row stamped `22:52Z` is 05:52 WIB — fresh, not stale

## [1.11.2] - 2026-09-30

### 🔧 Fixed (critical — the brain was silently dead)

- **SSE-streaming gateways**: several OpenAI-compatible gateways emit `data:` chunks even when `stream` was not requested; `res.json()` on that body threw on every forecast, so the AI abstained on 100% of markets. Responses are now read as text and stitched from either shape (chunked deltas or full JSON)
- **Thinking-prose JSON extraction**: reasoning models wrap answers in prose — the parser now takes the first balanced `{...}` (string-aware) instead of requiring a bare object. Proven live: real `p` + rationale + factors from the production gateway

## [1.11.1] - 2026-09-30

### 🔧 Fixed (found in a live user session)

- **Unknown commands no longer boot the trading loop** — typos like `polyroot market` fell through to `startAgent`. Now: `Unknown command` + did-you-mean suggestion + exit 2, before any side effects. Legacy flag style (`polyroot --once`) still passes through
- **Console `run` refusal stays at the prompt** — pre-flights the single-instance guard before handing the terminal to the loop, so a supervised agent yields advice instead of killing your console session
- **New top-level `polyroot logs [--follow]`** — watch agent logs without entering the console (answers "how do I monitor it" alongside `status`, `journalctl -f`, `health`, `explain`)

## [1.11.0] - 2026-09-30

### 🔧 Fixed — forensic audit findings (verified, then fixed with proof)

- **Migration resequencing** — duplicate `0015_*` prefix eliminated (`0015_market_event_graph` → `0016`, cascade to `0024_arb_observations`). Upgrade safety proven by simulation: old applied-set + new runner applies renamed files as harmless no-ops, zero errors (all statements idempotent)
- **Dependency hygiene** — pruned 8 unused workspace declarations (ledger×2, strategy, security, data, domain, type-only data/intelligence → devDependencies), regenerated the drifted lockfile (it still pinned 0.1.x versions), `npm ci` clean
- **Zero circular imports** — 3 real runtime cycles broken by leaf extraction (signer `payload-hash`, intelligence `api-url`, data `book-primitives`; API-stable via re-exports); 3 ledger + 2 intelligence madge hits proven type-only and converted to explicit `import type`; removed an `export *` barrel in live-feed. madge: 13/13 packages clean
- **Dead code removed** — unreferenced `src/pm/auth`, `src/pm/budget` (the latter imported nonexistent `@polyroot/types`) plus its orphan test; adopted 2 orphaned live-code tests (`supervisor-reconciler`, `live-feed-reconnect`) into the contracts suite
- **Audit correction** — the "RiskEngine/PositionSizer coverage gap" does not exist under those names; risk-gate, MoneyKernel and guards all carry dedicated contract tests (verified, no action)

## [1.10.4] - 2026-09-30

### 🔧 Fixed (found by final audit)

- **Resolution recency filter** — Gamma serves oldest-closed first, so the recorder kept archiving 2021 markets no live forecast can join against (calibration would starve forever). `fetchClosedEvents` now keeps only closures within 30 days (0 disables); the trainer finally has a chance to meet live forecasts

## [1.10.3] - 2026-09-30

### 🔧 Fixed (critical — crash-looped supervised agents)

- **Single-instance guard excluded everyone including itself**: the systemd unit read back as `activating` on boot and refused its own startup into a restart loop. The guard now refuses only `ActiveState=active` with a foreign MainPID (self-PID proceeds); the port probe + metrics bind stay as backstops. Regression test: own boot (activating and self-PID) never refuses

## [1.10.2] - 2026-09-30

### 🔧 Fixed

- **Second `polyroot run` no longer dies on raw `EADDRINUSE`** — a single-instance guard refuses first (systemd-active check with PID + management hints, then metrics-port probe), and the metrics bind itself translates leftovers into the same friendly refusal. No more split-brain loops, no more cryptic bind errors

## [1.10.1] - 2026-09-30

### 🔧 Fixed

- **Arb observation dedup** — same event+direction observed within the hour is skipped instead of re-inserted every scan (the table was growing one row per scan per event)

## [1.10.0] - 2026-09-30

### ✨ Added — modern interactive CLI

- **Console UI kit** (`runtime/console-ui.ts`) — one visual language: theme (auto-disabled off-TTY/`NO_COLOR`/dumb), banners, steppers, panels, aligned kv/tables, progress bars, pills, spinners (silent off-TTY). Two iron rules: ANSI never splits a machine-tested phrase; piped stdin/tests/systemd always get the classic rendering
- **Arrow-key menus** — ↑/↓·jk navigate, Enter selects, 1-9 jumps, Esc cancels with shared-session semantics. Raw mode suspends/restores the readline session; any failure falls back to numbered input. Proven on a real pty: cursor moves, selection echoes, terminal restores clean
- **Resurfaced everywhere** — onboarding stepper, setup banner, status dashboard, grouped `--help`, console banner + prompt, markets table + spinner, doctor banner, boxed setup/update completion

## [1.9.0] - 2026-09-29

### ✨ Added — the agent sizes and counts by itself (autonomy inside walls)

- **Portfolio allocator** (`strategy/portfolio-allocator.ts`) — the loop now decides HOW MANY markets per pass (rank by previous-pass score, top-K evaluated, rest deferred with a log line; warmup evaluates all; unknown markets score neutral so nothing starves) and HOW MUCH per trade (Kelly on live equity: cap + session P&L, floored at zero — wins compound, losses shrink, ruin sizes to zero)
- **Position tracker + portfolio-full gate** — fills accumulate open notional; `resolved_clusters` frees it back; exposure ≥ cap skips the pass until settlements land. Owner walls: `POLYROOT_MAX_CONCURRENT_ORDERS` (default 3), capital cap, loss latch — the agent decides everything beneath them, never above

## [1.8.0] - 2026-09-29

### ✨ Added — smart-money contradiction guard (live)

- **Watchlist flow feed** (`venue/smart-money-feed.ts`) — reads public Data API activity for owner-curated wallets (max 20, `POLYROOT_SMART_WALLETS`; empty disables), reduced to per-token net flows with distinct-wallet corroboration and lookback expiry
- **One-way contradiction guard** — strong/fresh/corroborated opposing flow adds +2pp to the edge floor; aligned/thin/stale flow changes nothing (photocopied conviction is not edge). Recorded in lineage assumptions
- **Background sync** (15min, first tick at boot) owned by the agent lifecycle, fail-open

### ✨ Added — arb observation base + maker primitive

- **Arb scan job** (`venue/arb-scan.ts`, migration `0023_arb_observations`) — groups active events, reads touches (bounded), evaluates baskets, persists VALID verdicts as research evidence. Observation only: non-atomic legs are real-money risk, entries stay unwired pending shadow validation
- **Maker quoter** (`QuoteEngine.makerQuote`) — post-only quotes that improve-or-join without ever crossing (1-tick spreads join = safe direction). Primitive validated in tests; live rollout pending shadow A/B fill measurement

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
