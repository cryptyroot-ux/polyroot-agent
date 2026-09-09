# DOMAIN_SCHEMAS.md — Canonical domain schemas (Phase 4)

Date: 2026-09-09 · Baseline: spec pack 124 `PM-*` · Owner: Domain (PM-DATA-* / PM-WALLET-*

All canonical schemas live in `src/pm/domain/src/index.ts` (zod). This file is a
mapping, not a duplicate: every schema below is anchored to its requirement ID.

## 1. Orthogonal state axes

| Axis | Schema | Values | Bind |
|---|---|---|---|
| Operation mode | `OperationModeSchema` | `RESEARCH`, `PAPER`, `SHADOW`, `LIVE` | PM-GOV-02 — only LIVE sends financial orders |
| Runtime state | `RuntimeStateSchema` | `STOPPED`, `BOOTSTRAPPING`, `RECOVERING`, `ACTIVE`, `DEGRADED`, `PROTECTIVE_PAUSE`, `ACCESS_BLOCKED`, `EMERGENCY_HALT` | PM-OPS-* |
| Venue mode | `VenueModeSchema` | `NORMAL`, `POST_ONLY`, `CANCEL_ONLY`, `READ_ONLY`, `UNAVAILABLE`, `UNKNOWN` | PM-VENUE-01 — orthogonal to SystemHealth/AccountMode |
| Risk tier | `RiskTierSchema` | `NORMAL`, `CAUTIOUS`, `PROTECTIVE` | PM-RISK-* |

### G0 deltas applied (this phase)
- `OperationModeSchema` gained `RESEARCH` (PM-GOV-02).
- `VenueModeSchema` replaced legacy `RESTARTING` with `READ_ONLY` per PM-VENUE-01;
  restart behavior is modeled via observed contract/capability (PM-VENUE-03), not a fixed mode.

## 2. Lifecycle enums

| Enum | Values | Anchor |
|---|---|---|
| `IntentStatusSchema` | `CREATED VALIDATED RESERVED DISPATCHED REJECTED EXPIRED` | PM-STR-* |
| `SubmitStatusSchema` | `SUBMITTING ACKNOWLEDGED SUBMISSION_UNKNOWN DEFINITIVE_REJECT` | PM-EXE-03 |
| `OrderStatusSchema` | `LIVE PARTIAL MATCHED CANCELED EXPIRED REJECTED UNKNOWN` | PM-EXE-04 |
| `CancelStatusSchema` | `CANCEL_REQUESTED CANCELED CANCEL_UNKNOWN NOT_CANCELED` | PM-EXE-06 |
| `TradeStatusSchema` | `MATCHED MINED RETRYING CONFIRMED FAILED` | PM-LED-03 / FT-33 |
| `PositionStatusSchema` | `PENDING SETTLED REDEEMABLE REDEEMED DISPUTED` | PM-DATA-* / FT-33 |
| `ResolutionStatusSchema` | `OPEN PROPOSED CHALLENGED DISPUTED FINAL` | PM-DATA-* |
| `IntentPurposeSchema` | `ENTRY REDUCE EXIT REBALANCE` | PM-STR-* |

## 3. Wallet / asset taxonomy

- `WalletTypeSchema` (PM-WALLET-01): `DEPOSIT_WALLET EOA POLY_PROXY GNOSIS_SAFE POLY_1271 LEGACY_PROXY SAFE UNKNOWN`.
  New-install default is full CLOB V2 **POLY_1271 Deposit Wallet**; existing EOA / POLY_PROXY /
  GNOSIS_SAFE are discovered explicitly, never silently downgraded.
- `WalletIdentitySchema` (PM-WALLET-03): wallet / signer / funder are distinct verified identifiers.
- `AssetKindSchema` + `AssetRecordSchema` (PM-WALLET-06, PM-DATA-01): pUSD, USDC, USDC.e and
  outcome tokens are distinct; never assume every asset_id is a CTF integer.

## 4. Governance & permission

- `AutonomyCharterSchema` (PM-GOV-03): commissioning artifact — wallet, strategy, market class,
  allowed actions, capital cap, risk limits, policy hash, validity period. Immutable once issued;
  expired/superseded charters block new risk but never cancel.
- `ExecutionPermitSchema` (PM-EXE-02): permit_id, decision_id, intent_id, ledger/policy version,
  policy_hash, quote_id, lease_epoch, reservation_ids, max_qty, max_cash, allowed_order_style,
  **venue_mode**, expiry. (`money-kernel.ts` issues single-use permits; executor consumes them.)
- `SignRequest` (PM-WALLET-*, `src/pm/signer`): distinct from execution permit; carries the
  exact order payload to sign, never an opaque blob.

## 5. Schema-version discipline (PM-GOV-01)

- `SCHEMA_VERSION` is pinned in `domain/src/constants.ts`.
- `schema_version` defaults on every journaled schema; `data_migrations` in the ledger enforce
  forward-only upgrades (see `migrations/0001..000N_*.sql`, run by `scripts/migrate.ts`).

## 6. Verification (this phase)

```
npx turbo run build typecheck lint --force            → 33 tasks, 0 cached, exit 0
npm run test:unit                                     → 75 contract + 11 property, 0 fail
node scripts/check-traceability.mjs                   → 124/124 PASS
tests/pm/contracts/domain-baseline.test.ts            → asserts canonical enums vs pack
```

## 7. Open delta → Phase 5

- `AutonomyCharter` naming: schema/table rename to the mandate term (`mandate`) is queued in
  Phase 5 with the forward-only migration 0003 (`autonomy_charters` → `mandates`).
- Pack `schemas/*.schema.json` (18 draft files, only 1 present & empty in today's copy):
  not used by the runtime (zod is the validator). Any CI that globs `schemas/*.json`
  must tolerate the empty file or we re-export zod→JSON schemas with `zod2json` at gate G1.