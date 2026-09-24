# Market Universe + Encrypted Keystore Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Live/SHADOW loops trade an explicit owner-curated market universe instead of mock data. (2) Private key at rest encrypted (scrypt + AES-256-GCM, no new deps) instead of raw hex in `.env`.

**Architecture:** `readMarketUniverse(env)` (pure, fail-closed) + `collectLiveInputs(source)` (pure-ish, skips priceless markets) + `marketSource` dep wired from the venue adapter in `bootstrapAgent`. Keystore module in `@polyroot/signer` with `seal`/`open`; signer factory prefers keystore when configured.

## Global Constraints

- Node.js `>=24.0.0`; gates `npm run ci` + secret scan. No network in unit tests.

---

### Task 1: Market universe (TDD)

**Files:** create `src/pm/venue/src/market-universe.ts`; export from venue index; modify `g4-core.ts` (dep + `collectLiveInputs`), `g4-pipeline.ts` + `g4-loop.ts` (runContinuous), `main.ts` (wire + startup require); test `tests/pm/contracts/market-universe.test.ts` (new).

- [ ] Test RED: `readMarketUniverse({})` throws MARKET_UNIVERSE_MISSING; invalid ids throw MARKET_UNIVERSE_INVALID; `collectLiveInputs` maps snapshots to inputs and skips nulls; runContinuous never uses mock in non-PAPER (via collectLiveInputs unit + startup require).
- [ ] Implement:
  - `readMarketUniverse(env: {POLYROOT_MARKET_IDS?}): string[]` — split comma, trim, drop empties; each must match asset-id pattern (export `isClobAssetId` from order-translation.ts and reuse); empty → MARKET_UNIVERSE_MISSING; bad entry → MARKET_UNIVERSE_INVALID naming it.
  - `MarketSource = { universe(): string[]; snapshot(id): Promise<{bid:number;ask:number}|null> }`; `collectLiveInputs(source)`: for each id, snapshot; skip null/non-finite; return inputs.
  - `G4CoreDeps.marketSource?`; both `runContinuous`: PAPER → mock (unchanged); else require marketSource (throw LIVE_LOOP_UNWIRED) and iterate `collectLiveInputs` (empty pass → log + sleep, never mock).
  - `main.ts bootstrapAgent`: mode !== PAPER → `readMarketUniverse(process.env)` (throws before start); build marketSource from `venueAdapter.getOrderBook` (bid=yes_price, ask=no_price; null when either undefined); pass into pipeline deps.
- [ ] GREEN: build + focused tests + full suite.

### Task 2: Encrypted keystore (TDD)

**Files:** create `src/pm/signer/src/keystore.ts`; export from signer index; modify `createSignerFromEnv` precedence (keystore first); CLI `wallet seal` command; test `tests/pm/contracts/signer-keystore.test.ts` (new).

- [ ] Test RED: seal→open round-trip; wrong passphrase refuses; tampered ciphertext refuses; factory prefers keystore env over raw key.
- [ ] Implement: scrypt(passphrase, random salt) → AES-256-GCM; JSON envelope `{v:1, salt, iv, ct}` base64; env `POLYROOT_KEYSTORE_JSON` (or `POLYROOT_KEYSTORE_FILE`) + `POLYROOT_KEYSTORE_PASSPHRASE`; `wallet seal` writes envelope from `PRIVATE_KEY_HEX` (never prints key).
- [ ] GREEN + docs (`.env.example`, runbook key section, PUBLIC_API row).

### Task 3: Verify

- [ ] `npm run ci` exit 0; prettier; `git diff --check`; gitleaks.
