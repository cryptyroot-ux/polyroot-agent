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
- `npm run test:contract` → **256 pass / 0 fail** (70 suites)
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
No requirement has full acceptance evidence. The 256 contract tests are mock-only internal tests; they exercise pure logic and in-memory adapters, not real venue/PostgreSQL/wallet/network.

## Changes made this session (Phase 13: Security + Egress)
1. **Fixed SecurityProxy** (`src/pm/security/src/security-proxy.ts`):
   - Removed the `mtlsCaCert` gate so valid service mTLS is accepted.
   - Added explicit malformed `Authorization` header handling.
   - Fixed session failure code propagation for CSRF/session expiry/invalid session paths.
   - Updated rate-limit contract tests to use authenticated requests.
2. **Fixed EgressFilter/EgressGuard ordering** (`src/pm/security/src/egress-filter.ts`, `src/pm/security/src/egress-guard.ts`):
   - EgressFilter now categorizes and applies policy before guard/allowlist checks.
   - EgressGuard accepts `skipDomainCheck` for EgressFilter's final allowlist safety net.
   - Added generic external API categorization and fixed QUARANTINE/BLOCK precedence tests.
3. **Fixed contract test type diagnostics** (`tests/pm/contracts/egress-filter.test.ts`):
   - Imported `EgressAuditEntry` and used non-null assertion after audit callback capture.
4. **Validation this session**:
   - `npm run typecheck` → **13/13 packages pass**
   - `npm run test:contract` → **256 pass / 0 fail** (70 suites)
   - `npm run test:property` → **12 pass / 0 fail** (5 suites)

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
The contract/property/typecheck suite remains green. Phase 13 adds the security/egress controls required by PR-SEC-03/04/07:
- `SecurityProxy` enforces mTLS, owner API-key auth, browser sessions, CSRF, and rate limiting.
- `EgressGuard` blocks SSRF/private/link-local/metadata destinations and validates redirect chains.
- `EgressFilter` adds category/policy decisions, audit logging with secret redaction, and final allowlist enforcement.
The contract tests now cover both security components and pass; deployment workflows (canary/blue-green) are now implemented.

## Changes made this session (Phase 13: Deployment workflows)
1. **Deployment workflow gates** (`src/pm/control/src/deployment.ts`, PR-OPS-07 / T-PR-OPS-07):
   - `validateSchemaCompatibility`: forward-only migration check; older schemas are refused (`INCOMPATIBLE_SCHEMA_ROLLBACK`).
   - `validateDeploymentCandidate`: validates release id, `sha256:<64>` image digest, migration hash, target slot, and owner approval for LIVE.
   - `planBlueGreenDeployment`: selects the inactive slot and validates the candidate against it.
   - `rollbackDeployment`: allows rollback only when the candidate schema equals the active schema and targets the inactive slot.
   - LIVE promotion requires explicit `ownerApproved`; PAPER canaries are validated automatically.
2. **PAPER canary deployment script** (`scripts/deploy-canary.mjs`): validates security/egress load, contract tests, typecheck, build, and PAPER-mode validation before promotion.
3. **Release manifest generator** (`scripts/generate-manifest.mjs`): produces `release_manifest.json` from git state, lockfile hash, migrations, and image digest; CI manifest job now works and the output validates against `release_manifest.schema.json`.
4. **PR-OPS-07 contract tests** (`tests/pm/contracts/deployment.test.ts`): 18 tests covering schema compatibility, candidate validation, blue-green slot selection, and rollback refusal.

## Honest assessment
The contract/property/typecheck suite remains green. Phase 13 now covers security, egress, and deployment:
- `SecurityProxy` enforces mTLS, owner API-key auth, browser sessions, CSRF, and rate limiting.
- `EgressGuard` blocks SSRF/private/link-local/metadata destinations and validates redirect chains.
- `EgressFilter` adds category/policy decisions, audit logging with secret redaction, and final allowlist enforcement.
- `deployment.ts` implements the blue-green promotion gate and incompatible-schema rollback refusal (PR-OPS-07).
- `deploy-canary.mjs` and `scripts/generate-manifest.mjs` complete the PAPER canary and manifest paths.
G5/G6/G7 remain NOT_RUN and are intentionally not fabricated.

## Next exact action
Continue the engineering loop on the outstanding gaps enumerated in `PHASE_COMPLETION_AUDIT.md`:
1. Re-run: `npm run test:contract`, `npm run test:property`, `npm run typecheck`, `npm run build`.
2. Proceed to Phase 14 (traceability/gate evidence) after Phase 13 is complete.