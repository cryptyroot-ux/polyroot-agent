# MONEY_PATH.md — Money path correctness evidence (Phase 6)

Date: 2026-09-09 · Baseline: spec pack 124 `PM-*` · Owner: Risk / Signer / Control / Venue

## 1. Money Kernel (PM-RISK-01..08, PM-LED-02)
`src/pm/risk/src/money-kernel.ts` — the ONLY place that commits funds.
Reservation + ExecutionPermit created atomically; single-use, versioned, TTL-bound.

**Hard guards (never loosened by tier, PM-RISK-05):** CAP_SHARES · CAP_CASH · POLICY_HASH ·
RESERVATION_LIMIT · PERMIT_TTL · INSUFFICIENT_FUNDS · CASH_OVER_BUDGET · PERMIT_INVALID.

**Fixes in this phase (money-creation hole):**
- New **PRICE_RANGE** guard: `perSharePriceBase` must be in `(0, 1e6]` base units.
  Previously a negative price produced `cashNeeded < 0`, passed the availability
  checks, and `commit(+|cash|)` credited the balance — money creation. Now refused
  before any commitment (zero funds touched, no event emitted).
- New **VENUE_MODE** guard: permit refuses a non-canonical `VenueMode` (PM-VENUE-01).
  (Legacy `RESTARTING` no longer mintable.)

## 2. Signer Vault (PM-WALLET-07, TABLE 8)
`src/pm/signer/src/index.ts` pre-sign invariants: ACTION_NOT_ALLOWED · PERMIT_INVALID ·
CLOCK_SKEW (bounded) · PERMIT_EXPIRED · PERMIT_REUSED · IDENTITY_CONFLICT
(signer ≠ funder) · AMOUNT_EXCEEDS_PERMIT (share quota, never cash cap) · payload
fingerprint dedupe. `decimalToBase` clamps NaN/negative → 0 (drifts upstream into
PRICE_RANGE at the kernel).

## 3. Order Builder (PM-EXE-02)
`src/pm/control/src/order-builder.ts`: SIZE_REQUIRED · SIZE_ZERO (post-clamp collapse) ·
permit maxQty/maxCash clamps; exact base-unit math via `cashNeededFor`.

## 4. Venue mode gate (PM-VENUE-01, TABLE 17)
`src/pm/venue/src/index.ts` `MODE_MATRIX` (fail-closed): NORMAL/POST_ONLY submit+cancel ·
CANCEL_ONLY cancel · READ_ONLY read-only · UNAVAILABLE no-op · UNKNOWN deny all.

## 5. Executor (PM-EXE-03..06)
`src/pm/executor/src/index.ts`: order lifecycle `orderLifecycleNext` (no-blind-retry,
SUBMISSION_UNKNOWN never resubmits); idempotency; permit consumption.

## 6. Verification (fresh, this phase)
```
npx turbo run build typecheck lint --force   → 33 tasks, exit 0
npm run test:unit                            → contract 77 + property 12, fail 0
```
New tests: negative/out-of-range price sweep refusing PRICE_RANGE with zero commits;
non-canonical venue mode refused (VENUE_MODE); exact-integer-truncation property grid
over adversarial price inputs (PM-LED-02).