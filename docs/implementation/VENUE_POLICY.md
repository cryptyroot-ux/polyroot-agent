# Venue Adapter Policy — Phase 8

Date: 2026-09-09 · Root: `/root/projects/Polyroot` · Baseline: spec pack **124 `PM-*`**

## Coverage audit (before this phase)

| Req | Title | Status before | Where |
|-----|-------|--------------|-------|
| PM-VENUE-01 | VenueMode ortogonal | ✅ implemented | `venueActionGate` MODE_MATRIX (TABLE 17) |
| PM-VENUE-02 | Capability intersection | ❌ **gap** | new `policy.ts: capabilityIntersection` |
| PM-VENUE-03 | Restart behavior | ❌ **gap** | new `policy.ts: RecoveryLedger` |
| PM-VENUE-04 | Error taxonomy | ❌ **gap** | new `policy.ts: normalizeVenueError` |
| PM-VENUE-05 | Client throttling | ❌ **gap** | new `policy.ts: RateGovernor` |
| PM-VENUE-06 | In-flight uncertainty | ❌ **gap** | new `policy.ts: RecoveryLedger` |

`venue/index.ts` previously exported only the mode gate + `VenueAdapter` interface.

## Implemented (source of truth moved to `venue/policy.ts`, re-exported)

### Mode gate (PM-VENUE-01) — moved unchanged, fail-closed.
- `NORMAL/POST_ONLY` permit submit+cancel; `CANCEL_ONLY` cancel+read; `READ_ONLY` read only; `UNAVAILABLE` read only; `UNKNOWN` even read refused. Orthonormal to account/system modes (new domain `AccountModeSchema`, `SystemHealthSchema`).

### Capability intersection (PM-VENUE-02)
- `capabilityIntersection(action, input)`: final permission = venue mode ∧ account mode ∧ protocol capability ∧ mandate ∧ freshness ∧ risk state.
- `account CLOSE_ONLY` at `venue NORMAL` only passes when `requiredStyle === "REDUCE_ONLY"` — verified-inventory reduce only (TEST).
- `REDUCE_ONLY` requires observed `VenueCapability.supports_reduce_only` (no assumption of native reduce-only).
- Cancel is **remedial**: never blocked by mandate/freshness/risk-close, but blocked by `SUSPENDED`/`ACCESS_BLOCKED` account status.

### Error taxonomy (PM-VENUE-04)
- `normalizeVenueError(raw,{arrivedPendingStore,orderType})` → 9 kinds.
- Unknown 5xx after POST → `RECONCILE_REQUIRED` (not auto-retry). FAK/IOC `NO_MATCH` → `PERMANENT_REJECT` terminal zero-fill.
- 429 **and** server queue-delay hints (`queuedDelayMs`/busy headers) → `RETRYABLE`; auth/balance/policy/stale map to dedicated kinds; raw status+code preserved for triage.

### Client throttling (PM-VENUE-05)
- `RateGovernor`: deadline-aware per-class buckets (submit/cancel/read/heartbeat), honors server-queue hints beyond HTTP 429, drops intents whose queue fit exceeds deadline (`INTENT_EXPIRED`) before submit; `canCancel()` guards against cancel/heartbeat starvation behind order batches.

### In-flight & restart recovery (PM-VENUE-03/06)
- `RecoveryLedger`: `SUBMITTED_UNKNOWN → (CANCEL_UNKNOWN) → CANCEL_CERTAIN`. Only a venue-sourced result resolves; restart never reports cancel-certain and never re-submits a late-accepted POST as a new order (`needsReconcile`).
- First-party bookkeeping alone cannot grant cancel certainty.

## Verification (fresh, this phase)
- `npx turbo run build typecheck lint --force` → **33 tasks successful**.
- `npm run test:unit` → **119 pass / 0 fail** (107 contract incl. `venue-policy.test.ts` 14; 12 property) — previous 105.
- `node scripts/check-traceability.mjs` → **124/124 one-to-one, 0 failures**.

## Notes
- New domain primitives: `AccountModeSchema` (ACTIVE/CLOSE_ONLY/RESTRICTED/SUSPENDED/ACCESS_BLOCKED), `SystemHealthSchema`, `VenueCapabilitySchema` (observed-only protocol capability with `observed_at`).
- Wired network adapter (placeOrder/cancelOrder against the frozen `@polymarket/client@0.9.0`) lands in Phase 9 executor harness; these policy modules are the deterministic gates it must pass through.