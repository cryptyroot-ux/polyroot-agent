# ADR: Canonical Identifiers for Financial Objects

## Status
Accepted

## Context
PolyRoot requires globally unique, collision-resistant identifiers for financial objects such as reservations, permits, and quotes. Previously, ULID was used for all identifiers, including financial ones. However, ULID is not a standard UUID and may cause confusion in systems expecting UUIDs (e.g., PostgreSQL UUID columns). Additionally, the financial authority requires identifiers that are compatible with the PostgreSQL UUID type and adhere to industry standards for financial transaction IDs.

## Decision
We will standardize on UUID (RFC 4122) version 4 for all financial identifiers:
- Reservation ID
- Permit ID
- Quote ID
- Decision ID (when generated internally)
- Intent ID (when generated internally)

Non-financial identifiers (e.g., event IDs, order IDs, strategy IDs) may continue to use ULID where appropriate, but financial identifiers must be UUID.

## Consequences
### Positive
- Financial identifiers are now standard UUIDs, compatible with PostgreSQL UUID columns.
- Eliminates confusion between ULID and UUID in financial contexts.
- Aligns with industry practices for financial transaction IDs.

### Negative
- Slight increase in identifier length (UUID: 36 characters vs ULID: 26 characters).
- Requires changes to ID generation in the Money Kernel and any other financial ID generators.
- Existing ULID-based financial identifiers in the database will remain; new identifiers will be UUID.

## Implementation
- Replace `ulid()` calls with `crypto.randomUUID()` for financial IDs in `src/pm/risk/src/money-kernel.ts`.
- Remove prefixes (`res_`, `quote_`) from generated financial IDs to produce plain UUID strings.
- Ensure that the branded types (ReservationId, PermitId, QuoteId) accept UUID strings.
- Update any tests or mocks that rely on the old ULID format or prefixes.

## Related
- P0-B: Canonical Domain/Database Identifiers
- Migration 0007: Permit→order durable binding (uses UUID for permit_id and claimed_order_id)
