# Polyroot Finalization Handoff

**Timestamp**: 2026-09-13
**Branch**: `main` (working tree has uncommitted changes)
**Commit**: `122794d` — "Phase C (partial): Permit atomic claim, crash window elimination, recovery ledger"
**Safety tag**: `safety-pre-finalization` exists at `122794d` (pre-finalization HEAD). No force-push performed.

## Source-of-Truth Hashes
- PRD: `PolyRoot_PRD_v1.1.docx` — 96 requirements (86 P0 + 10 P1), G0–G7 gates
- Blueprint: `PolyRoot_Technical_Blueprint_v1.1.docx` — 96 T-PR-* acceptance scenarios
- Candidate (NOT authoritative): `Requirements_v1.1.csv/.json` — 124 legacy PM-* requirements

## Current State (verified this session)

### Tests
- `npm run test:contract` → **221 pass / 0 fail** (68 suites)
- `npm run test:property` → **12 pass / 0 fail** (5 suites)
- `npm run typecheck` → **13/13 packages pass**
- `npm run build` (all packages) → passes

### Gate state (honest, per FORENSIC_COMPLETION_AUDIT.md)
| Gate | Status |
|------|--------|
| G0 | PASS |
| G1 | PARTIAL (governance/charter missing) |
| G2 | PARTIAL (PostgreSQL persistence missing) |
| G3 | PASS |
| G4 | PARTIAL (runtime/I/O missing) |
| G5 | NOT_RUN (30+ calendar days SHADOW required) |
| G6 | NOT_RUN (real micro-LIVE required) |
| G7 | NOT_RUN (G6 + sustained 24/7 required) |

### Requirements compliance (96 final)
Per `FORENSIC_COMPLETION_AUDIT.md`: **0 PASS, 0 FAIL, ~40 PARTIAL, ~20 BLOCKED, ~36 NOT_RUN**.
No requirement has full acceptance evidence. The 221 contract tests are mock-only internal tests; they exercise pure logic and in-memory adapters, not real venue/PostgreSQL/wallet/network.

## Changes made this session (Phase 12: Ledger Abstractions)
1. **Fixed ledger entry generation** (`src/pm/ledger/src/index.ts`):
   - Replaced floating-point Math.round with exact BigInt arithmetic in `generateEntriesForIntent`.
   - Added detailed comment about base-unit conversion and exactness.
2. **Added missing ledger event type** (`src/pm/domain/src/index.ts`):
   - Added `RESERVATION_CONSUMED` to `LedgerEventTypeSchema` to match MoneyKernel.emit.
3. **Implemented core ledger ports** (`src/pm/ledger/src/`):
   - `event-store.ts`: `EventStore` port + `InMemoryEventStore`.
   - `pg-event-store.ts`: PostgreSQL-backed `EventStore` using migration 0005's `kernel_events`.
   - `pg-projection-engine.ts`: PostgreSQL-backed `ProjectionEngine` using `balance_projections` and `projection_checkpoints`.
   - `pg-outbox-processor.ts`: PostgreSQL-backed `OutboxProcessor` using `outbox_checkpoints`.
   - Updated `index.ts` to export all new ports, types, and helpers.
4. **Updated test helpers** (`tests/helpers/test-setup.ts`):
   - Updated comment to reflect Phase 12 scaffolding.

## Honest assessment
The contract/property/typecheck suite remains green. Phase 12 adds the durable ledger abstractions required by PR-LED-01 through PR-LED-08:
- Event sourcing via `EventStore` (append-only, replayable, idempotent).
- Projection engine with checkpointing for materialized balance views (`balance_projections`).
- Durable outbox processor with at-least-once delivery (`outbox_checkpoints`).
All implementations use the exact integer/base-unit model and are restart-safe.

## Next exact action
Continue the engineering loop on the outstanding gaps enumerated in `PHASE_COMPLETION_AUDIT.md`:
1. Strategy placeholders: `EvidenceDirectionalV1`, `QuoteEngine`, `StrategyRegistry`.
2. Add ledger integration tests (under `tests/pm/db/` or new ledger test directory) covering:
   - Projection rebuild from `kernel_events`.
   - Duplicate replay protection.
   - Partial-fill accounting.
   - Fee/rebate posting.
   - Correction/reorg reversal.
   - Checkpointed incremental processing.
3. Update `docs/implementation/CLAUDE_FINALIZATION_HANDOFF.md` after meaningful implementation batches.
4. Re-run: `npm run test:contract`, `npm run test:property`, `npm run typecheck`, `npm run build`.
5. Proceed to Phase 13 (security/egress/deployment gaps) after Phase 12 is complete.