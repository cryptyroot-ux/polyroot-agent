# Critical Trading Chain Fixes Design Spec

**Goal:** Fix high-severity and critical issues found in PolyRoot trading chains (MoneyKernel/Reservation leak, unconsumed fills, missing payload_hash, ephemeral seenMap loss on restart, and missing lease release on certain error branches).

## Architecture & Components

1. **Reservation & Fill Wiring (`@polyroot/executor` & `@polyroot/risk`)**:
   - Ensure `ReservationManager.consume()` is invoked whenever an order receives a fill or acknowledgement from the venue.
   - Ensure `ReservationManager.release()` is invoked when an order is rejected, definitively cancelled, or expired without fill.

2. **Permit Payload Hash (`@polyroot/venue`)**:
   - Add `payload_hash` parameter to `PgPermitStore.claimPermitAndRecordSubmission` so signed order payloads are cryptographically bound at the storage layer upon claim.

3. **Lease & State Integrity (`@polyroot/executor`)**:
   - Ensure lease release on `DEFINITELY_NOT_SENT` and all reject branches.
   - Persist `seenMap` (idempotency state) to PostgreSQL table (`seen_orders` or `recovery_ledger` state column) so restart does not lose in-flight idempotency memory.

## Error Handling & Edge Cases
- DB transaction failure during `consume()` / `release()` must roll back safely and retry or flag for reconciliation.
- Expired permits block `consume()` with `PERMIT_EXPIRED`.
