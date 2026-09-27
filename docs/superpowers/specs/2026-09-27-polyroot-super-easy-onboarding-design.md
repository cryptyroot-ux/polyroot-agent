# Super-Easy Onboarding for Open-Source Users Design

> **PolyRoot is self-hosted open-source software: every user brings their own AI provider key, wallet, RPC, and infrastructure — the repo must never ship a maintainer-owned gateway URL, key, or endpoint as a default. This design rebuilds `polyroot onboard` into a 3-step wizard an awam investor/community member can finish in under 5 minutes: mandatory AI key (Hermes-style generic provider, no owner defaults) + mandatory wallet (plain language, same sealed keystore) + PAPER-by-default mode, ending with automatic migrate + doctor and an offered one-step PAPER demo.**

**Goal:** Any non-technical user can go from `curl ... install.sh | bash` to a working PAPER setup by answering 3 friendly prompts, supplying only their own AI key and wallet — with a one-step demo trade offered when infra is up. Zero jargon on screen, zero owner-owned defaults in code, zero changes to live-trading guards.

**Approach:** Narrowly refactor `runOnboarding` + `writeEnv` in `src/pm/runtime/src/cli.ts`: provider step becomes Hermes-style generic (named choice, user-typed base URL, no baked-in gateway); wallet step keeps the existing `sealPrivateKey` mechanism with rewritten awam copy; mode step keeps PAPER default with explicit LIVE confirmation; append auto-migrate + auto-doctor. `runSetupFlow`, `assertRuntimeEnv`, and all live guards stay untouched.

---

## Open-Source Constraints (non-negotiable)

*   **No maintainer-owned defaults:** No personal gateway URL, API key, RPC endpoint, or token list may appear as a default, placeholder, or example anywhere in the onboarding path. The existing default `Base URL = https://files.pango.fun/v1` for the 9Router choice is removed; the field ships empty and requires user input.
*   **Public URLs are fine:** Well-known public endpoints (`https://api.openai.com/v1`, `http://localhost:11434/v1`, `https://polygon-rpc.com`) may remain as defaults because they belong to no maintainer.
*   **User-owned secrets only:** Keys are pasted once by the user, stored exclusively in `~/.polyroot/.env` (mode 0600) and `~/.polyroot/keystore.json` (mode 0600), referenced via env vars Hermes-style. Nothing is printed, logged, or transmitted.
*   **No phone-home:** Onboarding performs no network call except an optional provider `GET /models` ping to validate the user's own key, and the existing market-browser fetch the user explicitly requests. No telemetry.
*   **English-only copy:** All wizard text is plain English (repo is English-only since PR #40). No jargon words on screen: keystore, hex, seal, CLOB, caps, latch. Internal code identifiers are unchanged.

---

## Step 1 — AI Brain (mandatory, Hermes-style generic provider)

**File:** `src/pm/runtime/src/cli.ts`, `runOnboarding` provider block (`cli.ts:397-444`, replaced).

Choices (default = OpenAI, the only choice with a public base URL):

1. `OpenAI` — ask model (choice: `gpt-4o-mini` default, `gpt-4o`, `gpt-4-turbo`) + paste API key (required, validated non-empty, hidden input).
2. `My own OpenAI-compatible gateway` — ask base URL (**empty, no default**, must parse as `http(s)://`), model name (required, free text), paste API key (required, hidden input). Help line names examples the user may already have (their own 9Router/NewAPI/OpenRouter account, company gateway) without endorsing any.
3. `Ollama (runs on this machine)` — ask model (default `llama3.1`) + base URL (default `http://localhost:11434/v1`); key is the `ollama` placeholder as today.

Validation is live per prompt: bad URL or empty key/model re-asks with one example line, never a stack trace. Optional `GET {baseUrl}/models` ping with the pasted key when network is available; failure is a warning ("could not reach it — continue anyway? y/n"), never a hard block, because corporate gateways may block the models endpoint while allowing completions.

Stored: `POLYROOT_FORECAST_PROVIDER=openai` for all three choices (the forecaster speaks OpenAI protocol to any compatible gateway — see `.env.example` "Any OpenAI-compatible endpoint"), `POLYROOT_FORECAST_MODEL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` (choice's base URL in every case).

---

## Step 2 — Wallet (mandatory, same vault, plain words)

**File:** `src/pm/runtime/src/cli.ts`, `runOnboarding` wallet block (`cli.ts:446-492`) + `promptWalletSetup` copy only.

Mechanism is unchanged: `sealPrivateKey(privateKey, passphrase)` (scrypt + AES-256-GCM) → `~/.polyroot/keystore.json` (0600) + `WALLET_ADDRESS` derived via `deriveAddressFromPrivateKey` into `.env`. What changes is only the screen copy and inline validation:

*   Create path: "vault password" + "repeat vault password" (mismatch re-asks), then `0x + randomBytes(32)` generation with address shown once and a "write this address down" line.
*   Import path: hidden input, regex `/^(0x)?[0-9a-fA-F]{64}$/` re-asks with "that does not look like a wallet secret key — it is 64 letters/numbers, starting with 0x" (no mention of hex).
*   Ctrl-C at any prompt throws the existing `OnboardingCancelled` → "Cancelled, nothing changed. Run `polyroot onboard` any time." (existing behavior, kept).

---

## Step 3 — Mode (PAPER default, explicit LIVE gate)

**File:** `src/pm/runtime/src/cli.ts`, `runOnboarding` mode block (`cli.ts:494-545`, kept with copy tweaks).

Choices remain exactly two: `PAPER — Safe simulation, mock data, no real money` (default, Enter) and `LIVE — Real trading on Polymarket (requires capital, API keys)`. LIVE still requires typing `LIVE`, then capital USD (default `AUTONOMY_BOUNDS.CAPITAL_CAP_USD`) and loss bps (default `AUTONOMY_BOUNDS.DAILY_LOSS_CAP_BPS`), echoed back as `capital $X, stop-loss $Y/day`. SHADOW and MICRO_LIVE stay exclusive to `polyroot setup` (unchanged `runSetupFlow`).

---

## Finish — Automatic migrate + doctor + live demo

**File:** `src/pm/runtime/src/cli.ts`, `runOnboardingFlow` (`cli.ts:600-621`, extended) + `writeEnv` (`cli.ts:561-598`, keystore fields kept, owner-gateway default removed).

After `writeEnv` writes `~/.polyroot/.env` (0600):

1. Run `migrate:latest` programmatically (same `scripts/migrate.ts` path) — fresh installs have no schema otherwise, and awam users must never run a second command to fix `missing tables`.
2. Run `runDoctor()` (non-live) and print its PASS/FAIL lines verbatim.
3. If migrate + doctor both succeeded, offer `Watch a 1-step demo trade now? (y/n)` (default y): on yes run one mock-market pass (`startAgent` PAPER `once:true`, non-blocking, exit 0) so the user's first sight is the agent working. On no, or when infra is missing, print `formatNextSteps(PAPER)` cheat-sheet and exit 0 — never auto-start a blocking loop inside onboarding.

Any failure in migrate/doctor prints the existing actionable message plus exactly one next command (`polyroot docker-fix` for DB, `polyroot setup` for config) — never a stack trace.

---

## Explicitly Out of Scope (not touched)

*   `assertRuntimeEnv`, `REFUSE_LIVE_WITH_STUBS`, WAL-03 checks, loss-cap latch, `runLivePreflight` (9 gates), `runSetupFlow`, `ModeWatcher`, executor/signer/venue packages.
*   Hermes-style `fallback_providers` chain — recorded backlog, separate spec.
*   GUI/web onboarding — terminal wizard only.
*   `docker compose up` automation — `doctor` already tells the user the one command; auto-starting Docker is a new failure surface.

---

## Testing

*   New contract test `onboarding-super-easy.test.ts`: (a) walkthrough with OpenAI choice writes valid PAPER `.env` + keystore file at 0600 with no wallet/venue live fields required; (b) custom-gateway choice with empty base URL re-asks and never writes; (c) repo-wide grep asserts zero occurrences of maintainer gateway URLs in the onboarding path (`cli.ts` onboarding functions + `writeEnv` + `.env.example` discovery/provider comments).
*   Existing suites must stay green unchanged: `runtime-live-guard`, `signer-keystore`, `signer-vault`, `wallet-verify`, `live-preflight`, `setup-guide`, `setup-stdin` — proving live guards are zero-touch.
*   Verification: `npm run test:contract`, `npm run build`, `npm run traceability` (no new requirements, 96/96 unchanged).

---

## Acceptance Criteria

1. Fresh `~/.polyroot` + `polyroot onboard` finishes in 3 steps (AI key, wallet, mode Enter); with infra up the user is offered (default y) a one-step PAPER demo trade, otherwise lands at shell with the next-steps cheat-sheet — exit 0 either way.
2. No maintainer-owned URL/key/endpoint appears as a default or example anywhere in the onboarding screens, `writeEnv` output, or `.env.example` provider/discovery comments.
3. Skipped wallet is impossible: onboarding without a sealed keystore cannot complete (wallet + API key mandatory per owner decision).
4. All pre-existing live-guard, keystore, and preflight tests pass unmodified.
