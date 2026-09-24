# Live Guard Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce exposure cap, loss-cap latch (durable), and SHADOW→MICRO_LIVE startup readiness in the live order path, so MICRO_LIVE cannot exceed its cap, trade through a loss breach, or start without 30d/100-cluster evidence.

**Architecture:** Enforcement lives in `executeG4Step` (single seam used by pipeline AND loop), fed by a new `liveGuard` dep (durable latch via `PgLiveGuardStore` + realized-loss reader). Startup gate lives in CLI `main()` (reads `shadow_baseline`, requires loss-cap env). Owner latch reset is an explicit `polyroot guard reset` command. Migration adds `live_guard_state`.

**Tech Stack:** TypeScript, pg, Node test runner + `tsx`.

## Global Constraints

- Node.js `>=24.0.0`; gates `npm run ci` + secret scan.
- No network in unit tests (fake pool/client).
- Latch must survive restarts (DB-persisted); reset only via explicit owner command and only when loss is back under cap.
- Existing tests that assume unwired guards must be updated to the new fail-closed behavior (documented behavior change, not a regression).

---

### Task 1: Durable latch store + migration (TDD)

**Files:**
- Create: `migrations/0015_live_guard.sql`
- Create: `src/pm/runtime/src/live-guard-store.ts`
- Modify: `src/pm/runtime/src/index.ts` (export)
- Test: `tests/pm/contracts/live-guard-store.test.ts` (new)

**Interfaces:**
- Consumes: `pg.Pool`-like `{ query(text, params?) }`.
- Produces: `PgLiveGuardStore { load(): Promise<LossGuardState|null>; save(s: LossGuardState): Promise<void> }` keyed `'micro-live'`.

Migration:

```sql
CREATE TABLE IF NOT EXISTS live_guard_state (
    key TEXT PRIMARY KEY,
    halted BOOLEAN NOT NULL DEFAULT FALSE,
    halted_at TIMESTAMPTZ,
    realized_loss_pusd NUMERIC NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO live_guard_state (key) VALUES ('micro-live')
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 1: Write failing test** with a fake pool recording queries: `load` returns null on empty row; `save` upserts halted state; round-trip preserves `haltedAt`.
- [ ] **Step 2: Run, expect FAIL** (not a function).
- [ ] **Step 3: Implement** store + export; `save` uses `INSERT ... ON CONFLICT (key) DO UPDATE`.
- [ ] **Step 4: Build runtime + run test, expect PASS.**

---

### Task 2: Enforcement in executeG4Step (TDD)

**Files:**
- Modify: `src/pm/runtime/src/g4-core.ts`
- Modify: `tests/pm/contracts/runtime-micro-live.test.ts` (add fake guard + caps)
- Modify: any other test calling live `executeG4Step`/pipeline without guard (find via failures)
- Test: new `tests/pm/contracts/live-enforcement.test.ts`

**Interfaces:**
- Consumes: `config.microLiveCapUsd`, `config.liveLossCapPusd`, `deps.liveGuard?`.
- Produces: NO_TRADE refusals with `MICRO_LIVE_CAP_UNCONFIGURED`, `EXPOSURE_CAP_EXCEEDED`, `LOSS_CAP_UNCONFIGURED`, `LIVE_GUARD_UNWIRED`, or the latch code.

New types in `g4-core.ts`:

```typescript
export interface LiveGuardDeps {
  loadLatch(): Promise<import("./micro-live-guard.js").LossGuardState | null>;
  saveLatch(state: import("./micro-live-guard.js").LossGuardState): Promise<void>;
  realizedLossPusd(): number | Promise<number>;
}
```

Add `liveLossCapPusd?: number` to `G4CoreConfig`, `liveGuard?: LiveGuardDeps` to `G4CoreDeps`, pass through `createG4Core`.

In `executeG4Step`, in the MICRO_LIVE/LIVE branch BEFORE `deps.executor.submit`:

```typescript
const cap = config.microLiveCapUsd;
if (!Number.isFinite(cap) || (cap as number) <= 0) return noTrade("MICRO_LIVE_CAP_UNCONFIGURED", ...);
const notional = size * (built.order.price);
const exposure = currentPortfolioExposureUsd ?? 0;
if (exposure + notional > (cap as number)) return noTrade("EXPOSURE_CAP_EXCEEDED", ...);
const lossCap = config.liveLossCapPusd;
if (!Number.isFinite(lossCap) || (lossCap as number) <= 0) return noTrade("LOSS_CAP_UNCONFIGURED", ...);
if (!deps.liveGuard) return noTrade("LIVE_GUARD_UNWIRED", ...);
const previous = await deps.liveGuard.loadLatch();
const loss = await deps.liveGuard.realizedLossPusd();
const verdict = evaluateLossGuard({ realizedLossPusd: loss, lossCapPusd: lossCap as number, reset: false, previous });
await deps.liveGuard.saveLatch(verdict.state);
if (verdict.halted) return noTrade(verdict.code, verdict.reason);
```

(`noTrade` = the existing `{ market_id, decision: "NO_TRADE", reason }` shape.)

- [ ] **Step 1: Write failing tests** in `live-enforcement.test.ts` using the same fake-deps harness style as `runtime-micro-live.test.ts` (read that file first for the harness): cap missing → refuse; exposure over cap → refuse; loss cap missing → refuse; no guard → refuse; latched previous → refuse with `LOSS_CAP_LATCHED` and executor never called; happy path (cap ok, loss 0, no latch) submits.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** in `g4-core.ts` (+ import `evaluateLossGuard` from `./micro-live-guard.js`; verify no import cycle: micro-live-guard imports paper-engine + reality-gap only).
- [ ] **Step 4: Update broken existing tests** (`runtime-micro-live.test.ts` etc.) to supply fake guard + caps. Do NOT weaken assertions — add the newly required inputs.
- [ ] **Step 5: Build + run contract suite, expect PASS.**

---

### Task 3: Bootstrap plumbing + CLI startup gate + guard reset (TDD where possible)

**Files:**
- Modify: `src/pm/runtime/src/main.ts` (read `POLYROOT_MICRO_LIVE_LOSS_CAP_USD`, optional `POLYROOT_MICRO_LIVE_CAP_USD` override; build `PgLiveGuardStore`; realized-loss reader from shared `Metrics`; pass into pipeline config+deps; throw `LIVE_LOSS_CAP_UNCONFIGURED` when live mode lacks the loss-cap env)
- Modify: `src/pm/runtime/src/cli.ts` (`MICRO_LIVE` startup gate via `shadow_baseline`; `polyroot guard reset` command)
- Modify: `tests/pm/contracts/runtime-live-guard.test.ts` (set loss-cap env for the success case)
- Test: extend `live-guard-store.test.ts` or new `cli-guard.test.ts` for the pure parts: `checkShadowBaselineRow({observed_days, resolved_clusters})` → ok / `MICRO_LIVE_NOT_READY`; reset refuses when loss ≥ cap.

Startup gate (cli.ts, MICRO_LIVE only, before startAgent): open `Pool(DATABASE_URL)`, `SELECT observed_days, resolved_clusters FROM shadow_baseline WHERE id='00000000-0000-0000-0000-000000000001'`, require days ≥ 30 and clusters ≥ 100 (comment cites `getDefaultModeConfig` shadowCriteria), else throw `MICRO_LIVE_NOT_READY`. Close pool in finally. Extract pure `checkShadowBaselineRow` for unit tests; DB touch only in the thin wrapper.

`polyroot guard reset`: loads latch via PgLiveGuardStore(DATABASE_URL); refuses unless current realized loss (arg `--loss <n>`, explicit owner-measured) is under the env loss cap; clears halted. No agent started. Unit-test the pure decision function.

- [ ] **Step 1: Failing tests** for pure functions.
- [ ] **Step 2-4: Implement**, update broken tests, build + green.

---

### Task 4: Docs + full verification

**Files:**
- Modify: `.env.example` (`POLYROOT_MICRO_LIVE_LOSS_CAP_USD`, optional `POLYROOT_MICRO_LIVE_CAP_USD`), `docs/PUBLIC_API.md`, `docs/RUNBOOK_SHADOW_MICROLIVE.md` (strike/adjust warning #1: latch now enforced + durable; reset procedure).
- Test: `npm run ci` exit 0; prettier; `git diff --check`; gitleaks.
