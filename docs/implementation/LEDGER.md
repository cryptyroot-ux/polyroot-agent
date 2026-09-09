# LEDGER.md — PostgreSQL ledger baseline (Phase 5)

Date: 2026-09-09 · Postgres 16.15 (local) · DB `polyroot_dev` (role `polyroot`, CREATEDB),
isolated from `rootlabs`. Credentials only in `/root/projects/Polyroot/.env` (root-only).

## Migration runner
`scripts/migrate.ts` (`npx tsx scripts/migrate.ts [latest|status]`) — forward-only,
transactional per-file, `schema_migrations` bookkeeping. Rollback refused (T-PM-OPS-07).
No secrets in code; `.env` loaded by the shell.

## Applied migrations
| # | File | Content |
|---|---|---|
| 0001 | `0001_initial_schema.sql` | ledger_events, outbox, evidence_items, forecasts, trade_intents, risk_decisions, reservations, orders, positions, portfolio_snapshots, risk_policy (bootstrap row), audit_log |
| 0002 | `0002_pm_domain.sql` | events, markets, market_snapshots, funding_rates, views (active_markets_latest, portfolio_summary), refresh_portfolio_snapshot() |
| 0003 | `0003_v11_charter_assets_graph_permits.sql` | mandates(build), wallets, credentials, asset_registry, approvals, graph_edges, market/evidence/forecast/intent/decision/permit columns, execution_permits, executor_leases, outbox_jobs, inbox_events, venue_trades, settlements, operating_costs, gate_reports, ledger corrections, position/order/risk-policy v1.1 columns |
| **0004** | `0004_mandate_rename_constraints.sql` | **R1** `autonomy_charters`→`mandates` (+`mandate_id`, idx/constr rename). **R2** `wallets.wallet_type` CHECK aligned to 8-value `WalletTypeSchema` (PM-WALLET-01). **R3** `risk_policy.execution_mode` CHECK = `RESEARCH/PAPER/SHADOW/LIVE` (PM-GOV-02). **R4** `mandates.schema_version='1.0.0'` |

## Canonical constraint alignment (verified via pg_constraint)
- `wallets_wallet_type_check`: `DEPOSIT_WALLET, EOA, POLY_PROXY, GNOSIS_SAFE, POLY_1271, LEGACY_PROXY, SAFE, UNKNOWN`
- `risk_policy_execution_mode_check`: `RESEARCH, PAPER, SHADOW, LIVE` (bootstrap default `PAPER`)
- `mandates` pkey on `mandate_id`; table `autonomy_charters` removed.

## Domain code aligned
`src/pm/domain/src/index.ts`: `CharterId→MandateId`, `AutonomyCharterSchema→MandateSchema`,
`charter_id→mandate_id` (PM-GOV-03 terminology). No stale `autonomy_charter` refs remain.

## Verification
```
npx turbo run build typecheck lint --force    → 33 tasks, 0 cached, exit 0
npm run test:unit                             → 75 contract + 11 property, 0 fail
node scripts/check-traceability.mjs           → 124/124 PASS
npx tsx scripts/migrate.ts status             → 0001..0004 APPLIED
```
Baseline tables empty (0 rows) — ready for Phase 6 money-path writes.