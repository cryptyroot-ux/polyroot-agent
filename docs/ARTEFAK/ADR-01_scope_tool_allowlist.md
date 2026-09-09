# ADR-01: Fork Reduction, Dependency Allowlist and Production Tool/Capability Model

**Status:** Accepted
**Date:** 2026-09-09 (updated to PRD/Blueprint v1.1)
**Deciders:** Crypty Root (Tech Lead)
**Technical Story:** PR-GOV-01, PR-SEC-06, PR-EXE-01; Blueprint B1 (fork disposition), B2 (trust boundaries)

---

## Context

PolyRoot is a fork of CloddsBot (pinned commit `715fd4a6`, v1.9.0, MIT). The
upstream is a large multi-venue trading terminal: its tool registry exposes a
630+ dynamic tool universe spanning trading, shell, SQL, Docker, messaging and
multiple venues (Blueprint S05). That surface is incompatible with least
privilege for a LIVE financial runtime. Its dependency graph pulls unrelated
exchanges, DeFi SDKs, messaging stacks and install scripts (PR-SEC-06).

Rewriting everything wastes useful concepts (risk taxonomy, provider routing);
reusing everything inherits dangerous assumptions (direct signing, broad retry,
manual signer without wallet type 3). Every upstream subsystem therefore needs
an explicit disposition, and the production runtime needs an explicit
dependency allowlist plus a minimal tool/capability model.

## Decision

### 1. Fork disposition (Blueprint B1)

Every retained upstream area gets one disposition — KEEP, ADAPT, REWRITE,
REMOVE or QUARANTINE — recorded in `docs/ARTEFAK/fork_disposition.csv`
(required before G1). Key rulings already fixed:

| Upstream area                              | Disposition            | Rule                                                                 |
| ------------------------------------------ | ---------------------- | -------------------------------------------------------------------- |
| `src/agents/tool-registry.ts` (630+ tools) | REPLACE FOR PRODUCTION | Intelligence gets explicit read/research/propose capabilities only   |
| `src/execution/index.ts`                   | REPLACE HOT PATH       | New executor uses durable intent/permit/unknown-state protocol       |
| `src/utils/polymarket-order-signer.ts`     | RETIRE / QUARANTINE    | Lacks wallet type 3 / POLY_1271; official SDK adapter is the default |
| `src/trading/kelly.ts`                     | REWRITE                | Verbal-confidence and win-streak sizing are rejected (see ADR-07)    |
| `src/strategies/hft-divergence/*`          | QUARANTINE             | Not in first LIVE release                                            |
| `src/arbitrage/*`                          | RESEARCH ONLY          | No direct execution path                                             |
| Unrelated venues / DeFi / messaging        | REMOVE                 | Amputated from the LIVE image                                        |
| SQLite/chat persistence                    | NON-FINANCIAL ONLY     | PostgreSQL is the sole financial truth                               |

### 2. Dependency allowlist (PR-SEC-06)

The LIVE image installs only the exact pinned dependencies needed by the
PolyRoot runtime. Unrelated trading/shell packages fail the build gate
(T-PR-SEC-06). Exact lock/digests, SBOM/provenance and vulnerability/secret
scans are release inputs, recorded in the release manifest.

### 3. Production tool/capability model

Intelligence and strategy code receive exactly three capability classes —
**read** (market snapshots, books, positions), **research** (normalized
evidence via the quarantine boundary, ADR-06) and **propose** (structured
`TradeIntent`, never a financial effect). No production intelligence path may
reach signing, submission, policy mutation, shell, raw financial SQL, host env
or secrets. Owner governance (pause, policy change, emergency stop) lives
exclusively in the authenticated Control API with audit (ADR-04).

## Consequences

### Positive

- Forbidden financial paths are provably unreachable, not merely undocumented.
- Upstream concepts worth keeping (risk taxonomy, provider routing ideas) are
  adapted behind new boundaries instead of inherited wholesale.
- The LIVE supply-chain surface is minimal and auditable.

### Negative

- Disposition matrix and amputated builds are upfront work before any strategy
  can reach a financial endpoint.
- Upstream syncs must re-run the disposition for every touched module.

## Validation

- `fork_disposition.csv` exists; every upstream module has a disposition
  (T-PR-GOV-01 blocks release on hash/drift).
- Call-graph/security tests find no active direct order/sign path outside the
  executor boundary (T-PR-EXE-01).
- Reintroducing an unrelated trading/shell package into the LIVE image fails
  the dependency allowlist gate (T-PR-SEC-06).
- Static analysis: no `signOrder`/`submitOrder`/private-key material reachable
  from intelligence/strategy packages.

## Related

- ADR-02 (SDK / wallet / registry), ADR-08 (deployment/security)
- Blueprint B1 (full disposition table), B2 (process/role can/cannot matrix)
- PR-GOV-01, PR-SEC-06, PR-EXE-01
