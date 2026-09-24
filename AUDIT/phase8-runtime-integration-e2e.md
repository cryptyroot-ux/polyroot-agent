# Phase 8: Runtime Integration & E2E Testing Audit

## Overview

This audit verifies the complete runtime integration pipeline (G4: PAPER → SHADOW → MICRO_LIVE → LIVE) and end-to-end test coverage across all modes.

---

## G4 Pipeline Architecture

### Core Components Integration

| Layer        | Component                                                      | Interface               | Status   |
| ------------ | -------------------------------------------------------------- | ----------------------- | -------- |
| Intelligence | `forecast(market) → Promise<number \| null>`                   | `G4CoreDeps.forecast`   | ✅ Wired |
| Strategy     | `sizeIntent(market, p) → number`                               | `G4CoreDeps.sizeIntent` | ✅ Wired |
| Risk Gate    | `validateAndReserve(intent, policy, wallet, ...) → GateResult` | `@polyroot/control`     | ✅ Wired |
| Money Kernel | `MoneyKernel.reserve(req) → ReserveResult`                     | `@polyroot/risk`        | ✅ Wired |
| Signer       | `SignerVault.sign(order, permit) → SignedOrder`                | `@polyroot/signer`      | ✅ Wired |
| Executor     | `Executor.submit(order, permit) → SubmitOutcome`               | `@polyroot/executor`    | ✅ Wired |
| Venue        | `VenueAdapter.placeOrder/cancelOrder/getOrderStatus`           | `@polyroot/venue`       | ✅ Wired |
| Recovery     | `RecoveryLedger` + `Reconciler`                                | `@polyroot/control`     | ✅ Wired |
| Metrics      | `G4PipelineMetrics`                                            | `@polyroot/runtime`     | ✅ Wired |

### Mode Transition Matrix (Enforced)

| From → To           | Allowed | Validation                  |
| ------------------- | ------- | --------------------------- |
| PAPER → SHADOW      | ✅      | `isValidModeTransition`     |
| SHADOW → MICRO_LIVE | ✅      | `isValidModeTransition`     |
| SHADOW → PAPER      | ✅      | `isValidModeTransition`     |
| MICRO_LIVE → LIVE   | ✅      | `isValidModeTransition`     |
| MICRO_LIVE → SHADOW | ✅      | `isValidModeTransition`     |
| LIVE → SHADOW       | ✅      | `isValidModeTransition`     |
| All others          | ❌      | **REJECTED** (throws Error) |

**Enforced at**: `G4Pipeline.setMode()` + `G4Core.isValidModeTransition()`

### Financial Gate Logic (computeFinancialGate)

| Mode       | Venue Mode                    | minEdgeAfterCost | Result              |
| ---------- | ----------------------------- | ---------------- | ------------------- |
| PAPER      | any                           | any              | `ALLOW`             |
| SHADOW     | UNAVAILABLE/UNKNOWN/READ_ONLY | any              | `ENTRY_BLOCKED`     |
| SHADOW     | other                         | > 0.5            | `FINANCIAL_BLOCKED` |
| SHADOW     | other                         | ≤ 0.5            | `ALLOW`             |
| MICRO_LIVE | UNAVAILABLE/UNKNOWN/READ_ONLY | any              | `ENTRY_BLOCKED`     |
| MICRO_LIVE | other                         | > 0.5            | `FINANCIAL_BLOCKED` |
| MICRO_LIVE | other                         | ≤ 0.5            | `ALLOW`             |
| LIVE       | any                           | any              | `FINANCIAL_BLOCKED` |

**Note**: LIVE mode **always** returns `FINANCIAL_BLOCKED` — requires Autonomy Charter gate (out of band).

---

## Integration Test Coverage

### Existing E2E Tests

| Test File                                     | Mode Tested         | Coverage   |
| --------------------------------------------- | ------------------- | ---------- |
| `tests/pm/contracts/runtime-loop.test.ts`     | PAPER               | ✅ 3 tests |
| `tests/pm/contracts/runtime-e2e.test.ts`      | PAPER (in-memory)   | ✅ 3 tests |
| `tests/pm/contracts/micro-live-guard.test.ts` | MICRO_LIVE / LIVE   | ✅ 6 tests |
| `tests/pm/contracts/release.test.ts`          | All modes (verdict) | ✅ 5 tests |

### PAPER Loop Tests (runtime-loop.test.ts)

| Test                                                  | Verifies                                     |
| ----------------------------------------------------- | -------------------------------------------- |
| `routes every tradable decision through orchestrator` | Single money path, all markets → orchestrate |
| `gate ENTRY_BLOCKED skips submits`                    | Only ALLOW markets reach orchestrator        |
| `FINANCIAL_BLOCKED blocks all submits`                | Zero financial orders regardless of edge     |

### Runtime E2E Tests (runtime-e2e.test.ts)

| Test                                                 | Verifies                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| `tradable market produces decision + fill + metrics` | Full pipeline: forecast → edge → risk → signer → executor → fill |
| `uncertain forecast abstains with NO_TRADE`          | Forecast p ∈ (0.48, 0.52) → NO_TRADE                             |
| `exposure above capital cap refused`                 | `currentPortfolioExposureUsd > capital_usd_cap` → NO_TRADE       |

### MICRO_LIVE / LIVE Guards (micro-live-guard.test.ts)

| Test                                             | Verifies                 |
| ------------------------------------------------ | ------------------------ |
| `parseArgs rejects invalid --mode`               | CLI validation           |
| `parseArgs rejects invalid RUNTIME_MODE`         | Env validation           |
| `bootstrapAgent PAPER succeeds on placeholders`  | No network I/O in PAPER  |
| `bootstrapAgent MICRO_LIVE without deps REFUSES` | `REFUSE_LIVE_WITH_STUBS` |
| `bootstrapAgent LIVE without deps REFUSES`       | `REFUSE_LIVE_WITH_STUBS` |
| `bootstrapAgent MICRO_LIVE with deps PROCEEDS`   | Real deps pass guard     |

---

## Fail-Closed Integration Verification

| Property                                 | Verified | Evidence                                            |
| ---------------------------------------- | -------- | --------------------------------------------------- |
| Invalid mode transitions rejected        | ✅       | `isValidModeTransition` throws on invalid           |
| LIVE mode always FINANCIAL_BLOCKED       | ✅       | `computeFinancialGate` hard-coded                   |
| No financial I/O in PAPER                | ✅       | Simulator fills only (`simulateFill`)               |
| No financial I/O in SHADOW               | ✅       | `executor.submit` never called                      |
| MICRO_LIVE requires explicit cap         | ✅       | `microLiveCapUsd` required in config                |
| Bootstrap refuses stub deps in LIVE      | ✅       | `bootstrapAgent` returns `REFUSE_LIVE_WITH_STUBS`   |
| Permit bound to exact policy/quote/lease | ✅       | `validateAndReserve` + `buildSignedOrder`           |
| Single money path (no bypass)            | ✅       | All orders through `orchestrate` callback           |
| Gate runs before every entry             | ✅       | `computeFinancialGate` at step 1 of `executeG4Step` |

---

## Gaps Identified

### Gap 8.1: No SHADOW Mode Integration Test

- **Impact**: MEDIUM — SHADOW mode has no dedicated integration test
- **Needed**: Test live data ingestion + no financial I/O + gate ENTRY_BLOCKED on bad venue mode

### Gap 8.2: No MICRO_LIVE Mode Integration Test

- **Impact**: HIGH — MICRO_LIVE is the first mode with real financial I/O
- **Needed**: Test with real wallet signer + real venue adapter + explicit cap enforcement

### Gap 8.3: No LIVE Mode Integration Test (Expected)

- **Impact**: N/A — LIVE requires Autonomy Charter, tested via release verdict only
- **Status**: Intentionally blocked by `FINANCIAL_BLOCKED` gate

### Gap 8.4: Mode Transition Tests Missing

- **Impact**: MEDIUM — No tests for runtime mode transitions (PAPER→SHADOW→MICRO_LIVE)
- **Needed**: Test `setMode()` transitions, state preservation, gate re-evaluation

### Gap 8.5: Continuous Run Test Missing

- **Impact**: LOW — `runContinuous()` has no integration test
- **Needed**: Test loop execution, error handling, graceful stop

### Gap 8.6: Metrics Integration Not Tested

- **Impact**: LOW — `G4PipelineMetrics` accumulation not verified in integration
- **Needed**: Test `totalOrders`, `filledOrders`, `totalPnl`, `fillRatio` across multiple markets

### Gap 8.7: Observability Hooks Not Tested

- **Impact**: LOW — `G4CoreObservability` hooks (emitStepStart, emitFinancialGate, etc.) not tested
- **Needed**: Test observability callbacks fire correctly

---

## Test Coverage Summary

| Category                    | Tests  | Status          |
| --------------------------- | ------ | --------------- |
| PAPER Loop                  | 3      | ✅ PASS         |
| PAPER E2E (in-memory)       | 3      | ✅ PASS         |
| MICRO_LIVE / LIVE Guards    | 6      | ✅ PASS         |
| Release Verdict (all modes) | 5      | ✅ PASS         |
| **Total Integration Tests** | **17** | **✅ ALL PASS** |

### Missing Integration Tests

| Missing Test                              | Priority | Effort    |
| ----------------------------------------- | -------- | --------- |
| SHADOW mode integration                   | MEDIUM   | 2-3 tests |
| MICRO_LIVE integration                    | HIGH     | 4-5 tests |
| Mode transition (PAPER→SHADOW→MICRO_LIVE) | MEDIUM   | 2-3 tests |
| Continuous run / error handling           | LOW      | 2-3 tests |
| Metrics accumulation                      | LOW      | 1-2 tests |
| Observability hooks                       | LOW      | 2-3 tests |

---

## Verification Evidence

All CI gates pass:

- ✅ `npm run build` — 13/13 packages
- ✅ `npm run test` — 548 unit + 12 property = 560 tests PASS
- ✅ `npm run lint` — 0 errors
- ✅ `npm run traceability` — 96/96 requirements mapped
- ✅ `npm run ci` — Full pipeline clean

---

## Recommendations

### Immediate (Before MICRO_LIVE)

1. **Add SHADOW integration test** — Verify live data path, no financial I/O, ENTRY_BLOCKED on bad venue
2. **Add MICRO_LIVE integration test** — Real wallet + venue + cap enforcement (with fake venue for CI)
3. **Add mode transition tests** — Validate `setMode()` state preservation and gate re-evaluation

### Short-term

4. Add continuous run test with error injection
5. Add metrics accumulation test
6. Add observability hooks test

### Documentation

7. Keep this audit updated with new integration tests
8. Document mode transition rules in operational runbook
