# PolyRoot Autonomous LIVE Safety Architecture

**Status**: Approved  
**Date**: 2026-09-25  
**Related PR**: #38 (Critical Trading Chain Audit Fixes)  
**Target**: Production Live Rollout with Full AI Autonomy

---

## 1. Scope & Success Criteria

| Requirement | Specification |
|-------------|---------------|
| **Autonomy Level** | AI proposes & executes orders end-to-end without human-in-the-loop per order |
| **Human Authority** | Config changes (capital cap, loss latch, venue) + emergency kill-switch only |
| **Capital Hard Cap** | Fixed at deployment; AI cannot modify (e.g., $1,000 USDC) |
| **Daily Loss Latch** | Hard stop at -2% equity/day; auto-halt, manual owner reset required |
| **Venue Pin** | Polymarket CLOB (CTF v2) only; zero fallback |
| **Config Immutability** | All bounds encoded in constants/deployment, not runtime env |
| **Safety Gates** | All must pass before every order submission |

**Success = 629/629 tests pass + zero critical audit findings + live gate checklist complete.**

---

## 2. Architectural Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│                    PolyRoot Runtime Daemon                  │
│                                                             │
│  [Market Stream] ──> [Forecast & Arbiter]                   │
│                             │                               │
│                      Trade Proposal                         │
│                             ▼                               │
│     ┌─────────────────────────────────────────────────┐     │
│     │               Money Kernel Gate                 │     │
│     │  - HARD Capital Cap: $1,000 USD (Non-AI mutable)│     │
│     │  - HARD Daily Loss Latch: -2% (Auto-Halt)       │     │
│     │  - HARD Venue Pin: Polymarket CLOB CTF v2 only  │     │
│     └─────────────────────────────────────────────────┘     │
│                             │ (Permit Issued)               │
│                             ▼                               │
│     ┌─────────────────────────────────────────────────┐     │
│     │        Execution Engine (Single Pool)           │     │
│     │  - Claim Permit & In-Flight Record (Atomic)     │     │
│     │  - Cryptographic Signing (Isolated Vault)       │     │
│     │  - Venue Submission & Lifecycle Tracking        │     │
│     └─────────────────────────────────────────────────┘     │
│                             │                               │
│                             ▼                               │
│  [Background Jobs: Expiry Cron + Reconciler (Every 30s)]    │
└─────────────────────────────────────────────────────────────┘
```

**Execution Invariant**: Zero orders submitted without an unexpired, unconsumed, valid `ExecutionPermit` checked against shared DB state.  
**Single Connection Pool**: `createPgStores` and `createOrchestratorPg` share the single initialized `pg.Pool` instance to avoid pool exhaustion and isolation anomalies.

---

## 3. Remediation Items (Test-First)

| ID | Blocker | Test | Fix |
|----|---------|------|-----|
| R1 | Missing background reservation expiry | `reservation-expiry-job.test.ts` | Add 30s interval cron in `Supervisor` calling `ReservationManager.expire()` |
| R2 | Post-crash order reconciler not wired | `restart-reconciliation.test.ts` | Replay unconfirmed orders from `seen_orders` + `recovery_ledger` on startup before new intents |
| R3 | HTTP auth & security headers missing | `auth-middleware.test.ts` | Add token validation middleware for exposed REST/metrics endpoints |
| R4 | Hard-coded safe guardrails | `autonomy-bounds.test.ts` | Define strict constants: `MAX_ORDER_USD`, `DAILY_LOSS_CAP_BPS`, `ALLOWED_VENUE` in runtime constants |
| R5 | Duplicate `pg.Pool` instances | `single-pool.test.ts` | Ensure single pool passed to both `createPgStores` and orchestrator |

---

## 4. Data Flow & Invariants

### 4.1 Order Submission Pipeline
```
Forecast → Arbiter → Intent → MoneyKernel.reserve() → ExecutionPermit
    │
    ▼
Executor.submit(permit, intent)
    │
    ├─▶ claimPermitAndRecordSubmission() [ATOMIC TX]
    │     ├─ UPDATE execution_permits SET used_at=now(), claimed_order_id=$order
    │     ├─ INSERT INTO recovery_ledger (order_id, permit_id, state='SUBMITTING')
    │     └─ COMMIT
    │
    ├─▶ SignerVault.sign(permit, payload_hash) [TABLE 8 invariants]
    │
    ├─▶ VenueAdapter.placeOrder(signed_order)
    │
    └─▶ Background: reconciler polls every 30s → recovery_ledger → venue status
```

### 4.2 Critical Invariants (Zero-Tolerance)
| Invariant | Enforcement Point | Failure = Reject |
|-----------|-------------------|------------------|
| `permit.used_at IS NULL` | `claimPermitAndRecordSubmission` | `PERMIT_USED` |
| `permit.expires_at > now()` | `MoneyKernel.reserve` + `claim` | `PERMIT_EXPIRED` |
| `permit.lease_epoch == current_epoch` | `PermitStore.validatePermit` | `LEASE_EPOCH_MISMATCH` |
| `permit.policy_hash == active_policy_hash` | `MoneyKernel.reserve` | `POLICY_HASH_MISMATCH` |
| `payload_hash binds to permit` | `SignerVault.preSignCheck` | `PAYLOAD_HASH_MISMATCH` |
| `exposure + notional ≤ capital_cap` | `PgLiveGuardStore.check` | `CAP_EXCEEDED` |
| `daily_loss < loss_cap_bps` | `PgLiveGuardStore.check` | `LOSS_LATCH_ENGAGED` |

---

## 5. Background Jobs

| Job | Interval | Action |
|-----|----------|--------|
| `ReservationExpiryJob` | 30s | `ReservationManager.expire()` → release stranded committed funds to available |
| `OrderReconciler` | 30s | Query `recovery_ledger WHERE state IN ('SUBMITTING','PENDING')` → venue lookup → finalize |
| `HealthMetrics` | 10s | Emit Prometheus: `permits_issued`, `permits_claimed`, `reservations_active`, `loss_latch_state` |

---

## 6. Configuration Constants (Deployment-Time Immutable)

```typescript
// src/pm/runtime/src/constants.ts
export const AUTONOMY_BOUNDS = {
  CAPITAL_CAP_USD: 1000,           // Hard cap, non-AI mutable
  DAILY_LOSS_CAP_BPS: 200,         // -2% = 200 bps
  ALLOWED_VENUE: "POLYMARKET_CLOB_CTF_V2",
  MAX_ORDER_USD: 100,              // Per-order ceiling
  MAX_CONCURRENT_ORDERS: 3,        // Concurrency limit
} as const;
```

---

## 7. Testing Strategy

| Layer | Coverage |
|-------|----------|
| Unit | All new functions (`expire`, `reconcile`, `auth`, bounds checks) |
| Integration | Full pipeline: Market→Permit→Sign→Venue→Recovery (PAPER/SHADOW) |
| Property | `ReservationManager` never exceeds capital; `expire` idempotent |
| Chaos | Kill `-9` mid-submit → restart → reconciler finalizes exactly once |
| Adversarial | Red-team: forged permits, stale epochs, loss-latch bypass attempts |

---

## 8. Rollout Gate Checklist (All Must Pass)

- [ ] 629/629 unit/integration tests pass
- [ ] 12/12 property tests pass
- [ ] R1–R5 remediation tests added & passing
- [ ] Zero `TODO`/`FIXME` in critical path files
- [ ] `npm run build` clean (13/13 packages)
- [ ] Shadow run 48h with live data, zero financial I/O, zero critical alerts
- [ ] Owner signed promotion artifact with Merkle root of deployed code

---

## 9. Rollback Plan

If any gate fails or anomaly detected in live:
1. **Immediate**: Kill-switch → `FLATTEN` all positions via signed reduction-only orders
2. **Forensic**: Export `recovery_ledger`, `seen_orders`, `ledger_events` for analysis
3. **Redeploy**: Previous verified SHA with same config constants

---

## 10. References

- PR #38: Critical Trading Chain Audit Fixes
- `src/pm/risk/src/reservation-manager.ts` – consume/release/expire
- `src/pm/venue/src/permit-store.ts` – atomic claim + recovery ledger
- `src/pm/executor/src/index.ts` – lease release on all paths
- `src/pm/control/src/reconciler.ts` – post-crash replay
- `src/pm/ledger/src/pg-live-guard-store.ts` – loss latch persistence