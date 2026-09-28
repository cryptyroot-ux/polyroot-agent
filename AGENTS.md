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
  ...[truncated 4474 chars]
