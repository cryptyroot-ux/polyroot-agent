# Audit Recommendations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute and remediate all 10 verified recommendations across runtime, strategy, data, security, signer, and risk packages with comprehensive tests.

**Architecture:** 
1. `runtime`: Wire production signer/venue in `cli.ts` from environment when in `MICRO_LIVE` / `LIVE` mode.
2. `strategy`: Ensure `socket.destroy()` on worker failure or buffer errors in `sandbox-supervisor.ts`. Cap maximum entries in `adaptive-tuner.ts`.
3. `data`: Implement max retry attempts and exponential backoff cap in `live-feed.ts`.
4. `security`: Harden IPv6-mapped IPv4 parsing in `egress-guard.ts`.
5. `signer`: Add runtime type validation for EIP-712 encoding. Add rate limiting / validation in credential auth.
6. `venue`: Support safe BigInt representations for epoch checks where applicable.
7. `risk`: Add strict validation in `levelAtLeast` for invalid `KillLevel` values.

**Tech Stack:** TypeScript, Node.js v24+, node:test, node:assert.

---

### Task 1: Fix CLI live mode signer/venue wiring in `cli.ts` and `main.ts`
- Write failing test in `src/pm/runtime/test/cli.test.ts` checking that `startAgent` in `MICRO_LIVE` mode attempts to initialize `createSignerFromEnv` and `PolymarketVenueAdapter`.
- Implement CLI resolution in `cli.ts`.
- Run tests and verify green.

### Task 2: Enhance sandbox-supervisor socket cleanup on error
- Write failing test in `src/pm/strategy/test/sandbox-supervisor-cleanup.test.ts`.
- Update `handleLine` / `handleConnection` in `sandbox-supervisor.ts`.
- Run tests and verify green.

### Task 3: Add max retry/backoff on live-feed reconnection
- Write failing test in `src/pm/data/test/live-feed-reconnect.test.ts`.
- Update `scheduleReconnect` in `live-feed.ts` with `maxReconnectRetries` and backoff.
- Run tests and verify green.

### Task 4: Harden egress-guard IP parsing and canonicalization
- Write failing test in `src/pm/security/test/egress-guard-ipv6.test.ts`.
- Update `ipToNumber` and `canonicalizeIP` in `egress-guard.ts`.
- Run tests and verify green.

### Task 5: Add runtime type validation in EIP712 signer serialization
- Write failing test in `src/pm/signer/test/eip712-validation.test.ts`.
- Implement validation in `encodeField` / `encodeData` in `eip712.ts`.
- Run tests and verify green.

### Task 6: Add max-entries cap in adaptive-tuner
- Write failing test in `src/pm/strategy/test/adaptive-tuner-cap.test.ts`.
- Update `applyAdaptation` / `AdaptiveTuner` in `adaptive-tuner.ts`.
- Run tests and verify green.

### Task 7: Validate KillLevel string in kill-switch
- Write failing test in `src/pm/risk/test/kill-switch-validation.test.ts`.
- Update `levelAtLeast` in `kill-switch.ts` to throw error on unrecognized kill level.
- Run tests and verify green.

### Task 8: Add rate limit / strict input check in credential-auth
- Write failing test in `src/pm/signer/test/credential-auth-ratelimit.test.ts`.
- Implement rate limiting / validation helper in `credential-auth.ts`.
- Run tests and verify green.

### Task 9: Run full test suite verification
- Execute `npm test` across the whole repository and verify 100% pass rate.
