# TEST TAXONOMY AUDIT — PolyRoot v1.1

## 1. Test Execution Summary (Clean Build)

```bash
cd /root/projects/Polyroot
npm run test:unit 2>&1 | grep -E "ℹ (pass|fail|tests|suites)"
```

**Output**:
```
ℹ tests 152
ℹ suites 51
ℹ pass 152
ℹ fail 0
ℹ tests 12
ℹ suites 5
ℹ pass 12
ℹ fail 0
```

**Total**: 164 tests (152 contract + 12 property), 0 failures, exit code 0

## 2. Test Taxonomy Classification

| Category | Count | Files | Real vs Mock |
|----------|-------|-------|--------------|
| **Unit (Pure Logic)** | 89 | money-kernel, kill-switch, loss-floor, key-compromise, signal, order-builder, risk-gate, sizing, EVCalculator, SizingEngine, ReservationManager | 100% Mock/In-Memory |
| **Contract (Integration)** | 63 | orchestrator, executor, risk-gate, order-builder, signal, venue-policy, venue-gate, fault-harness, executor-lifecycle, money-kernel, signer-vault, domain-baseline, tool-allowlist | 100% Mock Adapters / Fixtures |
| **Property (Generative)** | 12 | money-kernel-property, risk-engine | 100% In-Memory / Fast-Check |
| **Fault Injection** | 16 | fault-harness (16 scenarios) | 100% Mock Executor/Venue |
| **Property (Risk Engine)** | 12 | risk-engine (EV, Sizing, Reservation) | 100% In-Memory |
| **Supervisor/Reconciler** | 3 | supervisor-reconciler | 100% In-Memory |
| **Data/Intel Plane** | 29 | data-intel-plane | 100% In-Memory |

**Total**: 164 test functions across 17 test files

## 3. Real vs Mock Breakdown

| Dimension | Real | Mock/Fixture | Notes |
|-----------|------|--------------|-------|
| **Polymarket API** | 0 | 100% | All venue calls via mock `VenueAdapter` |
| **PostgreSQL** | 0 | 100% | All persistence via `InMemoryPersistence` / `Map` |
| **Live Wallet/Signer** | 0 | 100% | `CryptoSigner` injected as mock function |
| **Live Wallet/Account** | 0 | 100% | `WalletIdentity` fixtures only |
| **Real Fills** | 0 | 100% | `OrderResult` fixtures / mock `SubmitOutcome` |
| **Real Settlements** | 0 | 100% | No settlement logic exercised |
| **Real Calendar Time** | 0 | 100% | `now: () => Date` injected, controlled in tests |
| **Actual Network** | 0 | 100% | No HTTP/WebSocket calls |
| **Real CLOB V2 Contracts** | 0 | 100% | Mock `VenueAdapter` only |
| **Restart/Failure** | 0 | 100% | In-memory state only; no process restart tests |
| **Concurrency** | 0 | 100% | Single-threaded test execution |
| **Property Tests** | 12 | 0 | Fast-check style, pure functions |

**VERDICT**: **100% mock/fixture-based**. Zero real external dependencies exercised.

## 4. Test ID Mapping to Requirements

| Requirement Category | Required Test IDs (T-PM-*) | Actual Test Functions | Mapping |
|----------------------|---------------------------|----------------------|---------|
| GOV (5) | T-PM-GOV-01..05 | 2 (PM-GOV-01, PM-GOV-02) | 40% |
| DATA (6) | T-PM-DATA-01..06 | 0 | 0% |
| AI (6) | T-PM-AI-01..06 | 0 | 0% |
| STR (4) | T-PM-STR-01..04 | 0 | 0% |
| RISK (7) | T-PM-RISK-01..07 | 0 | 0% |
| EXE (8) | T-PM-EXE-01..08 | 0 | 0% |
| LED (5) | T-PM-LED-01..05 | 0 (comment only) | 0% |
| OPS (7) | T-PM-OPS-01..07 | 0 | 0% |
| VAL (5) | T-PM-VAL-01..05 | 0 | 0% |
| WALLET (10) | T-PM-WALLET-01..10 | 1 (PM-WALLET-01) | 10% |
| KONTRAK (6) | T-PM-KONTRAK-01..06 | 0 | 0% |
| INTEL (10) | T-PM-INTEL-01..10 | 0 | 0% |
| GRAPH (6) | T-PM-GRAPH-01..06 | 0 | 0% |
| SIZING (5) | T-PM-SIZING-01..05 | 0 | 0% |
| ECON (5) | T-PM-ECON-01..05 | 0 | 0% |
| MODE (6) | T-PM-MODE-01..06 | 0 | 0% |
| SECURITY (9) | T-PM-SECURITY-01..09 | 0 | 0% |
| EXP (9) | T-PM-EXP-01..09 | 0 | 0% |

**Total Mapped**: **4 / 124 = 3.2%**

**Traceability Script Result**: 124/124 structural mapping only — **NOT actual test coverage**.

## 5. Missing Test Categories

| Required by Spec | Implemented? | Evidence |
|-------------------|--------------|----------|
| Real PostgreSQL backup/restore | ❌ | No DB tests |
| Real CLOB V2 contract calls | ❌ | Mock adapter only |
| Live wallet signing (HSM/HSM) | ❌ | Mock `CryptoSigner` only |
| Live fills/settlements | ❌ | Fixture `OrderResult` only |
| Paper trading runtime | ❌ | No runtime |
| Shadow trading runtime | ❌ | No runtime |
| 24/7 supervisor crash/recovery | ❌ | No process tests |
| Wallet crash recovery | ❌ | No process tests |
| Database reconnect/rebuild | ❌ | In-memory only |
| Disk failure / full disk | ❌ | No persistence tests |
| Lease/fencing test | ❌ | No lease tests |
| Rollback test | ❌ | No rollback tests |
| Partial fill / fee posting | ❌ | Fixture only |
| External/manual trade | ❌ | Not tested |
| Real calendar days (G5) | ❌ | No SHADOW runtime |
| Real fills (G6) | ❌ | No micro-LIVE |
| Prospective alpha (G7) | ❌ | No autonomous-LIVE |

## 6. Conclusion

**164 passing tests ≠ 96 requirements compliance**. The test suite exercises internal pure logic and mock integrations only. Zero requirements have actual acceptance evidence. The traceability gate passes structurally but does NOT verify implementation or acceptance.