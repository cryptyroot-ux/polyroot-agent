# Risk Engine & Kill Switch — Phase 7

Date: 2026-09-09 · Root: `/root/projects/Polyroot` · Baseline: spec pack **124 `PM-*`**

## Coverage audit (before this phase)

| Req | Title | Status before | Where |
|-----|-------|--------------|-------|
| PM-RISK-01 | Batas eksposur | ✅ implemented | `control/risk-gate.ts` (order/market/portfolio % with `current*ExposureUsd`) |
| PM-RISK-02 | Reservasi atomik | ✅ implemented | `risk/money-kernel.ts` (`reserve` + permit, PM-RISK-03 ref on kernel) |
| PM-RISK-03 | Batas kerugian | ⚠️ **gap** — only schema fields | new `risk/loss-floor.ts` |
| PM-RISK-04 | Likuiditas dan ukuran | ✅ implemented | money-kernel `PRICE_RANGE`/`VENUE_MODE` guards (Phase 6) |
| PM-RISK-05 | Kill switch | ❌ **gap** — no implementation | new `risk/kill-switch.ts` |
| PM-RISK-06 | Jalur pengurangan risiko | ❌ **gap** | new `risk/kill-switch.ts` reduce checks |
| PM-SEC-08 | Key compromise response | ❌ **gap** | new `risk/key-compromise.ts` |

`risk/index.ts` previously exported only placeholder interfaces + Money Kernel.

## Implemented

### `kill-switch.ts` (PM-RISK-05/06)
- Monotonic lattice `NONE < PAUSE_ENTRIES < CANCEL_OPEN < FLATTEN` via
  `levelAtLeast`. Guarantees escape is only down the lattice by caller action,
  never by market-state derivation.
- `blockNewEntry`: PAUSE_ENTRIES+ blocks queued intents and new worker
  submissions (`ENTRIES_PAUSED`); NONE is passthrough.
- `planCancelOpen` + `recordCancelOutcome`: CANCEL_OPEN plans every open order;
  each order is independently observed. `allCanceled` is only true on a
  **definitive** `CANCELED` result per order — a `CANCEL_FAILED`/`CANCEL_UNKNOWN`
  is surfaced and never reported as success (TEST PM-RISK-05).
- `planFlatten`: FLATTEN is a *separate* action sized from **actual verified
  positions** with its own price cap. Positions whose avg price exceeds the cap
  are pushed to `skipped` (never force-sold above cap); invalid/out-of-range
  caps produce zero reduce orders (no bad exit orders minted).
- Reduce path (PM-RISK-06): `sellableShares` = verified delta + **definitive**
  cancel only; a pending/uncertain cancel frees nothing. `checkReduceAllowed`
  rejects SELL over free shares (`REDUCE_OVERDRAWN`), never opens a short, and
  never assumes a native reduce-only order type exists.

### `loss-floor.ts` (PM-RISK-03)
- Pure decision: a persisted `sealedBreach` blocks **until owner resume** and
  survives restart (deposits do not erase an accrued loss — the accumulator
  uses the loss side of `realized_pnl_24h` only, never mints deposits back as
  recovered loss).
- Daily-loss and drawdown stops are checked against conservative equity basis.

### `key-compromise.ts` (PM-SEC-08)
- Deterministic escalation order: `KILL_SIGNING → FREEZE_ENTRIES → RECONCILE →
  CANCEL_OPEN (if still possible) → REVOKE/ROTATE (per class) → OWNER_ASSET_RESCUE`.
- L1 signer → rotate; L2/relayer → revoke at provider; owner session → revoke
  + re-auth; unknown → full exposure, owner review before any unlock.
- Asset rescue is always owner-only (audit-logged).

## Verification (fresh, this phase)

- `npx turbo run build typecheck lint --force` → **33 tasks successful**.
- `npm run test:unit` → **105 pass / 0 fail** (93 contract incl. new
  `kill-switch.test.ts` 16 tests; 12 property) — previous baseline 89.
- `node scripts/check-traceability.mjs` → **124/124 one-to-one, 0 failures**.

## Delta / notes
- `kill-switch.test.ts` (16 cases): lattice monotonicity, entry blocking at each
  level, cancel observation discipline, flatten separates action+cap vs
  CANCEL_OPEN, reduce overdraft/short-refusal, PM-SEC-08 ordering, PM-RISK-03
  persistence/deposit-neutrality.
- Kill-switch *activation* state and the breach seal must be persisted by the
  caller (supervisor/ledger); this module stays pure & restart-carrying via the
  `sealedBreach` input — wiring lands with Phase 11 supervisor / Phase 9
  executor harness.