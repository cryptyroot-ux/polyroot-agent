# SDK_CANDIDATE_MATRIX.md — Phase 2 (G0) SDK-freeze & wallet decision

Date: 2026-09-09 · Canonical baseline: spec pack 124 `PM-*` · Evidence: fresh npm/npx runs.

## 1. Decision record

| Decision | Choice | Rationale | Evidence |
|---|---|---|---|
| Trading SDK freeze | `@polymarket/client@0.9.0` (exact, no caret) | Pack candidate with `integrity_verified`, Node `>=24` matches runtime v24.18; `SDK_BASELINE.observed_version` in `domain/constants.ts` = `0.9.0`; published 2026-09-03 (newest). | `npm view`; installed tree shows `client=0.9.0`, `types=0.2.0`, `bindings=0.9.0` |
| Registry integrity | verifies at install (`sha512-v1Pu…` for 0.9.0) | `integrity_verified: true` in pack manifest; installed via npm with integrity | `npm install` exit 0 |
| Types SDK | `@polymarket/types@0.2.0` | transitively required by client 0.9.0 | installed tree |
| Bindings SDK | `@polymarket/bindings@0.9.0` | transitively required by client 0.9.0 | installed tree |
| Non-trading SDKs | `@polymarket/clob-client-v2@1.1.0`, `builder-relayer-client@0.0.10` → **deferred** | V2/clob + relayer surface not required for v1 mono-venue path; re-evaluate with CT-10/CT-19 if relayer needed | pack `SDK_Candidate_Manifest` |
| Wallet root identity | `WalletTypeSchema` canonical taxonomy: `EOA`, `POLY_PROXY`, `GNOSIS_SAFE`, `POLY_1271`, `DEPOSIT_WALLET`, `UNKNOWN` (legacy: `LEGACY_PROXY`/`SAFE` retained for back-compat) | Maps CT-03..06 signers: EOA, PolyProxy, GnosisSafe, ERC-1271/Poly-1271 | `domain/src/index.ts`, rebuilt dist contains all 3 added tokens ×4 |

## 2. Candidate table (from pack manifest, refreshed)

| Package | Version | status | integrity | contract | Gate |
|---|---|---|---|---|---|
| `@polymarket/client` | 0.9.0 | **FROZEN v1** | verified | CT-03..06,11..21,G0 | G0 |
| `@polymarket/client` | 0.1.0 (was installed) | superseded | — | — | — |
| `@polymarket/clob-client-v2` | 1.1.0 | candidate, NOT frozen | verified | CT-10/19 defer | G1 |
| `@polymarket/builder-relayer-client` | 0.0.10 | candidate, NOT frozen | verified | CT-10/19 defer | G1 |

## 3. Node/runtime compatibility

- client 0.9.0: engines `node >=24` ✓ (runtime v24.18.0).
- clob-client-v2 1.1.0: engines `node >=20.10` ✓, deferred.
- zod: root stays 3.25.76 (client nests its own zod 4 under `node_modules/@polymarket/client/`).

## 4. Verification (fresh)

```
npx turbo run build typecheck lint --force → 33 tasks, 0 cached, exit 0
npm run test:unit → contract 69 pass / 0 fail; property 11 pass / 0 fail
installed: client 0.9.0, types 0.2.0, bindings 0.9.0
```

## 5. Open items → forwarded to Phase 9 fault harness

- CT-03..06 wallet sign type checks → paper-mocked in Phase 6, golden-venue in G4.
- CT-16 GTD / CT-17 FOK/FAK / CT-18 post-only behavior against real venue → G4 only.
- esbuild install scripts blocked by allowScripts (esbuild 0.18/0.19/0.28) — build-only tool; approve list boundaries noted for G0 security review.