# REPOSITORY_AUDIT.md — Phase 0 (PolyRoot Execution)

Date: 2026-09-09 · Operator: opencode (big-pickle) · Evidence: freshly executed commands this session

## 1. Identity

| Field | Value | Evidence |
|---|---|---|
| Working directory | `/root/projects/Polyroot` | `pwd` |
| Git root | `/root/projects/Polyroot` | `git rev-parse --show-toplevel` |
| Branch | `main` | `git branch --show-current` |
| HEAD | `9316175ed67b1ecbcf07504a902e99878220d537` | `git rev-parse HEAD` |
| Remote origin | `https://github.com/cryptyroot-ux/polyroot-agent.git` | `git remote -v` |
| Remote upstream | `https://github.com/alsk1992/CloddsBot.git` (commit `715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8` = upstream HEAD) | `git remote -v` + `git ls-remote upstream HEAD` |
| Package manager | npm 11.16.0, npm workspaces + turbo | `package.json` |
| Node runtime | v24.18.0 (engine `>=24.0.0`) | `node -v`, `package.json` |
| Python (tests/scripts aux) | 3.12.3 | `python3 -V` |
| Docker | 29.7.2 (running unrelated containers only: hyperoom, 9router) | `docker --version`, `docker ps` |
| PostgreSQL | local cluster 16, port 5432, `online`/`accepting connections` | `pg_lsclusters`, `pg_isready` |

## 2. Repository state

- `git status`: 1 modified doc (`docs/ANALISA_MENDALAM_V2.md`), 10 staged deletions (`docs/PRD*.txt`, `docs/BLUEPRINT*.txt`, `docs/PolyRoot_*.docx`, `docs/Polymarket_AI_Trader_*_v1.0.docx`) — executed deletion of all PRD/Blueprint docs per earlier user mandate; deletions staged but **not committed**.
- Untracked: `PolyRoot_PRD_v1.1.docx`, `PolyRoot_Technical_Blueprint_v1.1.docx` (repo root, mtime 22:12 — NEW uploads, hashes `a40ce3ab…`/`f939d605…`), `docs/spec_pack/` (the 124-requirement specification pack).
- 91 tracked files (`git ls-files | wc -l`).
- `.env` present but empty of content (key/value lines — `sed` produced no output → file effectively blank/whitespace; no secrets present).

## 3. URL/DB/deployment detection

- Local Postgres 16 `main` online on 5432 (system cluster) AND docker `postgres:16-alpine` on host 5433 (hyperoom-postgres, unrelated project). No PolyRoot DB detected running.
- Deployment artifacts present: `Dockerfile`, `docker-compose.yml`, `release_manifest.example.json`, `release_manifest.schema.json`, `.github/`, `.husky/`.
- `migrations/`: `0001_initial_schema.sql`, `0002_pm_domain.sql`, `0003_v11_charter_assets_graph_permits.sql` (18 KB). Migrate runner: `scripts/migrate.ts`.

## 4. Runtime verification (fresh, this session)

| Check | Command | Result | Evidence |
|---|---|---|---|
| typecheck | `npx turbo run typecheck --force` | 11/11 PASS, 18.18s | task summary |
| lint | `npx turbo run lint --force` | 11/11 PASS, exit 0 | task summary |
| build | `npx turbo run build --force` | 11/11 PASS, exit 0 | task summary |
| test:contract | `npm run test:unit` | 69 pass / 0 fail | node:test summary |
| test:property | `npm run test:unit` | 11 pass / 0 fail | node:test summary |
| traceability | `node scripts/check-traceability.mjs` | **FAIL** — `ENOENT docs/PRD_v1.1_clean.txt` at line 38 | raw error |

Traceability failure is an expected consequence of the deletion mandate: `scripts/check-traceability.mjs` hardcodes reads of `docs/PRD_v1.1_clean.txt` / `docs/BLUEPRINT_v1.1_clean.txt`. It must be migrated to the adopted baseline (124 `PM-*` requirements or the newly uploaded docs once source-of-truth is locked).

## 5. Source-of-truth conflict (BLOCKING for G0)

Two authoritative candidates disagree:

- **Newly uploaded docs** (`PolyRoot_PRD_v1.1.docx` = `a40ce3ab…`, `PolyRoot_Technical_Blueprint_v1.1.docx` = `f939d605…`, mtime 22:12, untracked): self-describe as "Version 1.1 · Correction & Completion Release · 9 September 2026" and state **96 traceable requirements (86 P0 + 10 P1)**, IDs in the `PR-*` scheme (`PR-GOV-01` …). Exactly 80 unique `PR-*` IDs recovered from text extraction (71 P0 + 9 P1 shown in extraction; doc claims 96 — table extraction may under-read).
- **Specification pack** (`docs/spec_pack/.../Requirements_v1.1.json`): **124 requirements (116 P0 + 8 P1)**, IDs in the `PM-*` scheme (`PM-GOV-01` …). `Validation_Report.json` claims docx hashes `707df2fda…`/`a54ae8a7…` — which do **not** match the newly uploaded docs. The pack is internally consistent and is the baseline currently used by `check-traceability.mjs` migration target and prior analysis.

Code and tests in the repo use **both** conventions lightly: 14 unique `PR-*` IDs and 0 `PM-*` IDs in `src/`+`tests/` (34 total references, e.g. `PR-LED-02`, `PR-WAL-*`). No `PM-*` references yet.

**Decision required before G0 freeze:** adopt (a) newly uploaded 96-`PR-*` docs as source of truth, (b) 124-`PM-*` spec pack as source of truth, or (c) reconcile both into one canonical numbering. The master execution prompt (§Phase 0) requires flagging this to the user rather than silently picking.

## 6. Component inventory (workspaces)

| Workspace | Path | Notes |
|---|---|---|
| control (gateway) | `src/pm/control/src/index.ts` | Express + zod + pino; ControlServer, OwnerAuth, CommandHandlers, AuditLogger (Part A implemented) |
| data | `src/pm/data/src/index.ts` | — |
| domain | `src/pm/domain/src/index.ts` | 91 exported schema objects (grep count), canonical contracts 19fd56c |
| executor | `src/pm/executor/src/index.ts` | order dedupe/order-vs-permit enforcement |
| intelligence | `src/pm/intelligence/src/index.ts` | — |
| ledger | `src/pm/ledger/src/index.ts` | — |
| observability | `src/pm/observability/src/index.ts` | — |
| risk | `src/pm/risk/src/index.ts`, `money-kernel.ts` | deterministic money kernel, reservation mgmt |
| signer | `src/pm/signer/src/index.ts` | permit/typed hash signing |
| strategy | `src/pm/strategy/src/index.ts` | — |
| venue | `src/pm/venue/src/index.ts` | CLOB adapter gate |

Tests: 10 contract suites under `tests/pm/contracts/*`, 2 property suites under `tests/pm/property/*`; helpers `tests/helpers/test-setup.ts`.

## 7. Financial-effect paths (economic code)

Économic surface identified for deep audit (Phase 0 note; detailed call-graph mapping follows in FORK_DISPOSITION_MATRIX):
- `src/pm/risk/src/money-kernel.ts` (capital math, reservations, EV/sizing)
- `src/pm/signer/src/index.ts` (permit signing, typed payload hash)
- `src/pm/executor/src/index.ts` (order lifecycle, dedupe, permit enforcement)
- `src/pm/venue/src/index.ts` (CLOB adapter, venue modes, rate governor)
- `src/pm/control/src/orchestrator.ts` + `order-builder.ts` + `risk-gate.ts` (Part A wiring, signal edge)
- `src/pm/ledger/src/index.ts` (journal/postings — pending PG readiness)

## 8. Gaps / flags

1. **BLOCKING G0:** source-of-truth conflict (see §5).
2. `check-traceability.mjs` broken (hardcoded deleted file paths) — must be migrated.
3. `docs/ANALISA_MENDALAM_V2.md` modified, uncommitted — likely a user-side change; leave untouched.
4. Staged deletions not committed — intentional (cleanup of PRD/Blueprint docs only, pack retained).
5. `release_manifest` upstream pinned `715fd4a6…` (1.9.0) matches live upstream HEAD — good, but lockfile hash placeholder (`TBD` / zeros) still pending G0.