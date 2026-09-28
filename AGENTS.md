# PolyRoot Agent — Instructions for Coding Agents

You are working on an **autonomous AI trading agent for Polymarket** (real money
capable). Your changes can directly affect profitability and fund safety. Read
this file first, follow it exactly.

## 1. The one invariant (never violate it)

**Reasoning is separated from execution.** The LLM proposes typed intents only.
A deterministic executor validates, signs, and submits. The AI never holds
private keys, never sizes beyond policy, never bypasses the risk engine.

Consequences for you:

- Never give the model a path to sign, send, or size orders.
- Never weaken a fail-closed branch into a guess. Uncertainty → `NO_TRADE`
  with a reason, always.
- Never use mock/simulated data outside `PAPER` mode. Live-configured code
  running on mock markets fabricates decisions — the codebase refuses this
  (`LIVE_LOOP_UNWIRED`), and so must you.

## 2. Commands (run these, in this order)

```bash
npm ci                                   # install (needs devDeps: turbo, tsx, @types/*)
npm run build                            # turbo build, 13 packages — must be 13/13
npm run test:unit                        # contract + property suites
npm run typecheck && npm run lint        # strict TS + eslint, zero warnings
npm run ci                               # full gate: typecheck + lint + test + build
```

Contract tests import from built packages (`@polyroot/*` → `dist`), so
**rebuild before running tests** after touching `src/`. Tests need a live
Postgres test DB (see CONTRIBUTING.md step 3); if you see `ECONNREFUSED`,
that is environment, not code — start Postgres and migrate first.

Prettier governs formatting: run `npx prettier --write` on every file you touch.

## 3. Code conventions (non-negotiable)

- Strict TypeScript: `verbatimModuleSyntax` (use `import type`),
  `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. Zero `any`
  in new code; `unknown` + narrowing instead.
- Fail-closed: every uncertainty resolves to refusal with a reason code.
  No silent fallbacks, no fabricated values, no `|| default` on money math.
- Pure engines, thin wiring: decision logic lives in dependency-injected
  pure functions (see `G4CoreDeps`, `QueryablePool`); CLI/DB/network stay at
  the edges. Unit tests inject fakes — they never need Postgres or network.
- Display never fabricates: print only values the engine produced. A missing
  number renders as `—`, never `0`.
- Run `npx prettier --write` on every file you touch.

## 4. Profit contract (how money is made or lost here)

```
forecast p → abstain unless 0.02 < p < 0.98 AND |p − 0.5| ≥ 0.02
         → edge_after_fees = best_side(p − price) − taker_fee
         → TRADE only if edge_after_fees > adaptive floor
            floor = minEdgeAfterCost (default 0.03)
                  + min(spread × 0.5, 0.05)   // adverse-selection add-on
         → sizeIntent → validateAndReserve → buildSignedOrder → executor
```

- Book regime (`classifyRegime`: DUST / TIGHT_CONSENSUS / CONTESTED /
  NORMAL) and the applied floor are recorded per step in
  `forecasts.lineage`. Query there before claiming a threshold change is
  "needed" — bring numbers, not hunches.
- `confidence` is derived as certainty `2·|p − 0.5|`, NOT a model
  self-report. Any new derived number must document its formula in a code
  comment and in `lineage`.
- The default forecaster prompt lives in
  `src/pm/intelligence/src/forecast-provider.ts` (`buildForecastUserPrompt`).
  `p` parsing stays strict JSON; reasoning (`rationale`, `factors`) is
  best-effort and must never influence the decision path.
- There is no resolved-outcome feedback loop yet (`shadow_log` records
  decisions, not settlements). Do NOT invent auto-tuning from history
  without a ground-truth signal — propose the schema first.

## 5. What you must never do

- Lower `minEdgeAfterCost` (or the spread add-on cap) to "get more trades".
  Fewer, better trades beat volume. Changes need backtest evidence + review.
- Let any mode except PAPER touch mock data (`LIVE_LOOP_UNWIRED` exists
  for a reason — keep it).
- Commit secrets: `.env*`, `keystore.json`, API keys, private keys.
  `.gitignore` covers them; `gitleaks` runs in CI. Never print secrets
  in logs, tests, or chat output.
- Touch `MICRO_LIVE`/`LIVE` paths without running the FULL suite
  (`npm run test:unit`) plus `polyroot doctor --live` reasoning in the PR.

## 6. Workflow

- Branch from `main`, conventional commits (`feat:`, `fix:`, `docs:` …),
  one concern per commit. PRs need: typecheck + lint + tests + build green.
- Small, reviewable steps. Update CHANGELOG.md for user-visible changes.
- After finishing: `git status` clean, branch pushed, PR description states
  evidence (test counts, not adjectives).
