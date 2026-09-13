# P0 Correction Baseline

**Date:** $(date -u +"%Y-%m-%dT%H:%M:%SZ")
**Repository:** https://github.com/cryptyroot-ux/polyroot-agent
**Local Root:** /root/projects/Polyroot

## Current State

### Repository State
- **HEAD:** ce8f1d37e71f6d2998301925a94af2bcaca6cb97
- **Remote main HEAD:** ce8f1d37e71f6d2998301925a94af2bcaca6cb97 (matches)
- **Branch:** feature/phase13-security-deployment (local), main (remote)
- **Worktree Status:** 1 modified file (src/pm/risk/src/money-kernel.ts - local reorder of balance check)

### Current CI State (Local)
- **npm ci:** ✅ PASS
- **npm run lint:** ✅ PASS (12 warnings in control, 2 warnings in ledger)
- **npm run typecheck:** ✅ PASS (cached)
- **npm run build:all:** ✅ PASS
- **npm run traceability:** ✅ PASS (96/96)
- **npm run test:** ✅ PASS (274 contract + 12 property = 286 tests)

### Migration Status
- Migrations 0001-0007: ✅ PASS on fresh PostgreSQL
- Migration 0007: Applied successfully

### G0-G7 Gate Status (Current)
| Gate | Status | Notes |
|------|--------|-------|
| G0 Research & Source Freeze | PARTIAL | SDK freeze not complete |
| G1 Domain & Contract | PASS | 96/96 traceability |
| G2 Fault & Money Safety | PARTIAL | Atomic reservation+permit WIP |
| G3 Security & Recovery | PARTIAL | Signer isolation incomplete |
| G4 PAPER | PARTIAL | PAPER loop exists but not fully verified |
| G5 Prospective SHADOW | NOT_RUN | Not yet implemented |
| G6 micro-LIVE | NOT_RUN | Blocked by G5 |
| G7 autonomous-LIVE 24/7 | NOT_RUN | Blocked by G6 |

### Current Failing Commands (Clean Checkout)
- `npm run typecheck` on fresh checkout: **FAILS** - Cannot find module '@polyroot/domain' (dist not built)
- CI Pipeline: Validate runs before Build, causing typecheck to fail on clean checkout

### Current P0 Blockers
1. **P0-A:** Clean CI - typecheck runs before build in CI (architectural cycle)
2. **P0-B:** Canonical IDs - Mixed ULID/UUID in domain vs DB
3. **P0-C:** Atomic Money Authority - Not yet implemented as single PG transaction
4. **P0-D:** Permit/Claim/Recovery/Fencing - Partial (permit claim implemented, fencing incomplete)
4. **P0-E:** Ledger Correctness - Event ID idempotency, sequence, checkpoints need fixes
5. **P0-F:** Real Risk Engine - Placeholder implementations
6. **P0-G:** Strategy Economic Correctness - p > 0.5 logic is wrong

### Modified Files (Working Tree)
- M migrations/0007_permit_order_binding.sql
- M src/pm/risk/src/money-kernel.ts

### Untracked Files
- docs/implementation/AUDIT_ULANG_96_REQ.md
- docs/implementation/GAP_CLOSURE_EVIDENCE.md
- src/pm/venue/src/types.ts
