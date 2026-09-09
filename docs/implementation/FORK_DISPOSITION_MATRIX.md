# FORK_DISPOSITION_MATRIX.md — Phase 1 (PolyRoot Execution)

Date: 2026-09-09 · Source-of-truth: spec pack 124 `PM-*` (canonical, locked by user).
Source table: `docs/spec_pack/.../Fork_Disposition_Matrix.json` (827 upstream blobs, hash-verified).

## 1. Summary

Upstream fork source: CloddsBot upstream `715fd4a6` (`@alsk1992/…`, release 1.9.0).
827 blobs inventoried with `git_blob_sha1` + `sha256` + byte/line count + semantic signals
(`signing`, `order_submit`, `fs_or_shell`, `network`, `dynamic_loading`).

| Disposition | Blobs | Meaning (admission gate) |
|---|---|---|
| QUARANTINE | 77 | Keep offline under `research/quarantine`; no production admission until review |
| RESEARCH-ONLY | 221 | Reference intent only; never compiled into PolyRoot |
| ADAPT | 134 | Reuse with hardening / renamed into our layout |
| REWRITE | 146 | Rebuild in `src/pm` with our contracts; upstream is reference only |
| KEEP | 1 | Adopt as-is (verified) |
| KEEP+HARDEN | 3 | Adopt, add defense-in-depth |
| REMOVE | 245 | Exclude (wrong protocol, unused surface, superseded) |
| **Total** | **827** | — |

`production_frozen=false`; all `production_admitted=false` until gates pass.

## 2. Financial signal filtering (182 files)

Signals `signing > 0` or `order_submit > 0` mark files touching the capital path.

| Disposition | Count |
|---|---|
| QUARANTINE | 14 |
| RESEARCH-ONLY | 58 |
| REWRITE | 26 |
| ADAPT | 14 |
| REMOVE | 70 |
| KEEP / KEEP+HARDEN | 0 |

Zero financial files are currently safe to carry into production as-is ⇒ **money path is
rebuilt in `src/pm`**, upstream only informs semantics.

Key REWRITE targets (order/signing surface) map to our workspaces:

| Upstream path (rewrite) | PolyRoot target |
|---|---|
| `src/utils/polymarket-order-signer.ts`, `tests/unit/polymarket-order-signer-v2.test.ts` | `src/pm/signer` (typed payload hash, permit, EIP-712) |
| `src/execution/{index,bracket,dca,trigger,twap,futures,auto-redeem,mev-protection}.ts` | `src/pm/executor` (order lifecycle, dedupe, permit enforcement) |
| `src/gateway/{index,server,api-routes,percolator-routes}.ts` | `src/pm/control` (Express + zod; Part A done) |
| `src/trading/{orchestrator,position-bridge,copy-trading}.ts`, `src/opportunity/executor.ts` | `src/pm/risk` + `src/pm/strategy` |
| `src/commands/registry.ts`, `src/bin/worker.ts`, `src/cron/index.ts` | `src/pm/data` (scheduled/Ingester surface) |
| `src/skills/bundled/trading-polymarket/index.ts` | `src/pm/strategy` (strategy plane adapter) |

ADAPT targets (reuse with hardening): `src/auth/google.ts`, `src/cli/commands/{doctor,index}.ts`,
`src/config/index.ts`, `src/feeds/{descriptors,index}.ts`, `src/identity/erc8004.ts`,
`src/portfolio/index.ts`, `src/queue/jobs/{producer,types,worker}.ts`, `src/signal-router/router.ts`,
`src/security/code-scanner.ts`.

QUARANTINE keep-locked (no compile, no npm run): `src/trading/orchestrator.ts`,
`src/skills/executor.ts`, `src/utils/polymarket-signer*`, `.env.example`, `src/types.ts`, etc.
(77 files).

REMOVE (245): all of `src/evm/*`, `src/solana/*`, `src/exchanges/{hyperliquid,lighter,opinion,predictfun}/`,
`src/bridge/*`, `src/channels/*`, `src/skills/bundled/{drift,copy-trading-solana,etc}/index.ts`,
`src/payments/x402/*`, `src/ledger/anchor.ts`, non-Poly market feeds.

## 3. Dependency disposition (89 packages)

`Dependency_Disposition.json` — 80 direct runtime + 9 dev (count per pack README).

| Disposition | Notes |
|---|---|
| ADAPT | Pin exact, verify integrity + license + transitive closure + lifecycle scripts before admission |
| REMOVE | agent/tokenizer, anchor/solana, all non-Poly venue SDKs |
| KEEP/HARDEN | minimal — evaluated in Phase 2 G0 |

Canonical Poly SDKs frozen in Phase 2 (G0): `@polymarket/client`, `@polymarket/types`,
`@polymarket/bindings` (present in monorepo lockfile).

## 4. Disposition rules applied across all gates

1. No file enters production with `production_admitted=false`.
2. `KEEP`/`KEEP+HARDEN` require fresh security review + hash-pin in `release_manifest`.
3. `ADAPT` requires a new PolyRoot path + its own pass through gates.
4. `REWRITE` never copies upstream code; upstream is behavioral reference only.
5. `QUARANTINE` never compiled or executed.
6. Every admission records blob SHA1/SHA256 + disposition + gate result in the matrix.

## 5. Outcomes for automation

- No bulk copy of upstream source into `src/pm` (REWRITE course).
- Financial path lives entirely in our 11 workspaces; upstream contributes tests + behavioral
  semantics only.
- Release manifest must pin upstream `715fd4a6` + published SDK hashes before G0 closes.