# Critical Trading Chain Fixes Implementation Plan

**Goal:** Implement fixes for critical trading chain safety gaps.

## Global Constraints
- **Atomic transactions required** for balance/reservation/ledger changes.
- **Lease epoch must be strictly enforced** in all DB interactions.
- **No private keys logged.**
- **Restart idempotency** depends on DB persistence.

---

### Task 1: Reservation Manager Integration (Wiring)
**Files:**
- Modify: `src/pm/executor/src/executor.ts`
- Modify: `src/pm/risk/src/reservation-manager.ts`

- [ ] Wire `consume()` call in `Executor` upon successful fill reconciliation/acknowledgement.
- [ ] Wire `release()` call in `Executor` upon definitive reject or cancel.

### Task 2: Payload Hash Persistence
**Files:**
- Modify: `src/pm/venue/src/permit-store.ts`

- [ ] Add `payload_hash` parameter to `claimPermitAndRecordSubmission`.
- [ ] Persist `payload_hash` in `recovery_ledger` table.

### Task 3: Lease Management & Cleanup
**Files:**
- Modify: `src/pm/executor/src/executor.ts`

- [ ] Ensure `releaseExecutorLease` is called in all `DEFINITELY_NOT_SENT` and `REJECT` branches.

### Task 4: Idempotency Persistence
**Files:**
- Modify: `src/pm/executor/src/executor.ts`
- Modify: `src/pm/ledger/src/pg-projection-engine.ts`

- [ ] Add `seen_orders` table (migration required).
- [ ] Persist `seenMap` states to `seen_orders` DB table in `Executor` to survive restart.

### Task 5: Verification
- [ ] Run full test suite.
