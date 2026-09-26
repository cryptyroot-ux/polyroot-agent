# Runtime Mode Hot-Reload & Dynamic Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a database-driven `ModeWatcher` in `@polyroot/runtime` that polls `live_guard_state.runtime_mode` every 5 seconds, validates mode changes with fail-closed semantics, degrades to `READ_ONLY` on DB connectivity loss, and provides dynamic mode updates to the agent loop.

**Architecture:** A standalone `ModeWatcher` class in `src/pm/runtime/src/mode-watcher.ts`, backed by SQL migration `0022_runtime_mode_hot_reload.sql`, integrated into `src/pm/runtime/src/index.ts` and `cli.ts`.

**Tech Stack:** TypeScript (Node.js >= 24), PostgreSQL (`pg` pool), `node:test` test runner.

## Global Constraints

- **Zero external dependencies:** Pure Node.js + existing `pg` pool.
- **Fail-closed on network/DB loss:** 3 consecutive failed polls degrades mode to `READ_ONLY`.
- **Strict TDD:** Every component starts with a failing test before implementation.
- **Verification gate:** `npm run ci` must pass exit code 0 without warnings.

---

### Task 1: Database Migration `0022_runtime_mode_hot_reload.sql`

**Files:**
- Create: `/root/polyroot-audit/migrations/0022_runtime_mode_hot_reload.sql`

**Interfaces:**
- Produces: `live_guard_state.runtime_mode` (TEXT NOT NULL DEFAULT 'PAPER') and `mode_updated_at` (TIMESTAMPTZ NOT NULL DEFAULT now()).

- [ ] **Step 1: Write SQL migration file**

```sql
-- Migration 0022: Add runtime_mode and mode_updated_at to live_guard_state for hot-reload
ALTER TABLE live_guard_state
  ADD COLUMN IF NOT EXISTS runtime_mode TEXT NOT NULL DEFAULT 'PAPER',
  ADD COLUMN IF NOT EXISTS mode_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE live_guard_state
  SET runtime_mode = 'PAPER', mode_updated_at = now()
  WHERE key = 'micro-live' AND (runtime_mode IS NULL OR runtime_mode = '');
```

- [ ] **Step 2: Commit migration file**

```bash
git add migrations/0022_runtime_mode_hot_reload.sql
git commit -m "feat(db): migration 0022 add runtime_mode to live_guard_state"
```

---

### Task 2: Core `ModeWatcher` Implementation (TDD)

**Files:**
- Create: `/root/polyroot-audit/src/pm/runtime/src/mode-watcher.ts`
- Test: `/root/polyroot-audit/tests/pm/contracts/mode-watcher.test.ts`
- Modify: `/root/polyroot-audit/src/pm/runtime/src/index.ts` (export `ModeWatcher`)

**Interfaces:**
- Produces: `ModeWatcher` class with `start()`, `stop()`, `getMode(): RuntimeMode`, `isDegraded(): boolean`, `requestModeChange(newMode, operator)`

- [ ] **Step 1: Write failing contract test for `ModeWatcher`**

Create `/root/polyroot-audit/tests/pm/contracts/mode-watcher.test.ts`:

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ModeWatcher, type QueryablePool } from "../../../src/pm/runtime/src/mode-watcher.js";

class FakePool implements QueryablePool {
  mode = "PAPER";
  halted = false;
  shouldFail = false;
  failCount = 0;

  async query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    if (this.shouldFail) {
      this.failCount++;
      throw new Error("DB_CONNECTION_LOST");
    }
    if (text.includes("UPDATE")) {
      const newMode = params?.[1] as string;
      this.mode = newMode;
      return { rows: [{ runtime_mode: this.mode, halted: this.halted }] };
    }
    return { rows: [{ runtime_mode: this.mode, halted: this.halted }] };
  }
}

describe("Runtime — ModeWatcher (Hot-Reload & Fail-Closed)", () => {
  it("initializes with initialMode and reads DB on first poll", async () => {
    const pool = new FakePool();
    pool.mode = "SHADOW";
    const watcher = new ModeWatcher({ pool, initialMode: "PAPER", pollIntervalMs: 50 });
    assert.equal(watcher.getMode(), "PAPER");

    await watcher.pollOnce();
    assert.equal(watcher.getMode(), "SHADOW");
    assert.equal(watcher.isDegraded(), false);
  });

  it("triggers onModeChange callback when DB mode changes", async () => {
    const pool = new FakePool();
    const changes: Array<{ from: string; to: string }> = [];
    const watcher = new ModeWatcher({
      pool,
      initialMode: "PAPER",
      pollIntervalMs: 50,
      onModeChange: (from, to) => changes.push({ from, to }),
    });

    await watcher.pollOnce(); // initial poll -> PAPER
    pool.mode = "LIVE";
    await watcher.pollOnce(); // mode change -> LIVE

    assert.equal(watcher.getMode(), "LIVE");
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0], { from: "PAPER", to: "LIVE" });
  });

  it("degrades to READ_ONLY after 3 consecutive polling failures (fail-closed)", async () => {
    const pool = new FakePool();
    pool.mode = "LIVE";
    const watcher = new ModeWatcher({ pool, initialMode: "LIVE", pollIntervalMs: 50, maxFailuresBeforeDegrade: 3 });

    await watcher.pollOnce(); // success
    assert.equal(watcher.getMode(), "LIVE");

    pool.shouldFail = true;
    await watcher.pollOnce(); // fail 1
    assert.equal(watcher.getMode(), "LIVE");
    await watcher.pollOnce(); // fail 2
    assert.equal(watcher.getMode(), "LIVE");
    await watcher.pollOnce(); // fail 3 -> DEGRADED to READ_ONLY

    assert.equal(watcher.getMode(), "READ_ONLY");
    assert.equal(watcher.isDegraded(), true);

    // Recover DB
    pool.shouldFail = false;
    await watcher.pollOnce(); // recovery -> restores LIVE
    assert.equal(watcher.getMode(), "LIVE");
    assert.equal(watcher.isDegraded(), false);
  });

  it("refuses mode upgrade to LIVE if loss latch (halted) is engaged", async () => {
    const pool = new FakePool();
    pool.halted = true;
    const watcher = new ModeWatcher({ pool, initialMode: "PAPER", pollIntervalMs: 50 });

    const res = await watcher.requestModeChange("LIVE", "operator_1");
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, "LOSS_LATCH_ENGAGED");
    }
    assert.equal(watcher.getMode(), "PAPER");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx tests/pm/contracts/mode-watcher.test.ts`
Expected: FAIL (Cannot find module `mode-watcher.ts`)

- [ ] **Step 3: Implement `ModeWatcher`**

Create `/root/polyroot-audit/src/pm/runtime/src/mode-watcher.ts`:

```typescript
/**
 * @polyroot/runtime — Dynamic Mode Watcher & Hot-Reload Engine.
 *
 * Polls `live_guard_state` in PostgreSQL to update the runtime mode dynamically
 * without process restart. Enforces fail-closed degradation (READ_ONLY) when
 * database connectivity is lost for > maxFailures.
 */

export type RuntimeMode = "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE" | "READ_ONLY";

export interface QueryablePool {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface ModeWatcherOptions {
  pool: QueryablePool;
  pollIntervalMs?: number;
  maxFailuresBeforeDegrade?: number;
  initialMode?: RuntimeMode;
  onModeChange?: (from: RuntimeMode, to: RuntimeMode, reason: string) => void;
  onDegrade?: (reason: string) => void;
}

export type ModeChangeResult =
  | { ok: true; mode: RuntimeMode }
  | { ok: false; code: string; reason: string };

const LATCH_KEY = "micro-live";

export class ModeWatcher {
  private currentMode: RuntimeMode;
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private degraded = false;
  private preDegradedMode: RuntimeMode | null = null;

  private readonly pool: QueryablePool;
  private readonly pollIntervalMs: number;
  private readonly maxFailuresBeforeDegrade: number;
  private readonly onModeChange?: (
    from: RuntimeMode,
    to: RuntimeMode,
    reason: string,
  ) => void;
  private readonly onDegrade?: (reason: string) => void;

  constructor(opts: ModeWatcherOptions) {
    this.pool = opts.pool;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.maxFailuresBeforeDegrade = opts.maxFailuresBeforeDegrade ?? 3;
    this.currentMode = opts.initialMode ?? "PAPER";
    this.onModeChange = opts.onModeChange;
    this.onDegrade = opts.onDegrade;
  }

  getMode(): RuntimeMode {
    return this.currentMode;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  async pollOnce(): Promise<void> {
    try {
      const res = await this.pool.query(
        `SELECT runtime_mode, halted FROM live_guard_state WHERE key = $1`,
        [LATCH_KEY],
      );
      const row = res.rows[0];
      this.consecutiveFailures = 0;

      // Recover from degraded state if DB is back
      if (this.degraded) {
        this.degraded = false;
        const restoredMode =
          (row?.["runtime_mode"] as RuntimeMode) ??
          this.preDegradedMode ??
          "PAPER";
        const oldMode = this.currentMode;
        this.currentMode = restoredMode;
        this.preDegradedMode = null;
        if (this.onModeChange && oldMode !== restoredMode) {
          this.onModeChange(
            oldMode,
            restoredMode,
            "database connection restored",
          );
        }
        return;
      }

      if (row && typeof row["runtime_mode"] === "string") {
        const dbMode = row["runtime_mode"] as RuntimeMode;
        if (dbMode !== this.currentMode) {
          const oldMode = this.currentMode;
          this.currentMode = dbMode;
          if (this.onModeChange) {
            this.onModeChange(
              oldMode,
              dbMode,
              "mode updated via database live_guard_state",
            );
          }
        }
      }
    } catch (err) {
      this.consecutiveFailures++;
      if (
        !this.degraded &&
        this.consecutiveFailures >= this.maxFailuresBeforeDegrade
      ) {
        this.degraded = true;
        this.preDegradedMode = this.currentMode;
        const oldMode = this.currentMode;
        this.currentMode = "READ_ONLY";
        const reason = `database polling failed ${this.consecutiveFailures} times: ${(err as Error).message}`;
        if (this.onDegrade) this.onDegrade(reason);
        if (this.onModeChange) {
          this.onModeChange(oldMode, "READ_ONLY", reason);
        }
      }
    }
  }

  async requestModeChange(
    newMode: RuntimeMode,
    operator: string,
  ): Promise<ModeChangeResult> {
    if (newMode === "LIVE" || newMode === "MICRO_LIVE") {
      const res = await this.pool.query(
        `SELECT halted FROM live_guard_state WHERE key = $1`,
        [LATCH_KEY],
      );
      const row = res.rows[0];
      if (row && row["halted"] === true) {
        return {
          ok: false,
          code: "LOSS_LATCH_ENGAGED",
          reason: "cannot upgrade to LIVE while loss latch is engaged",
        };
      }
    }

    try {
      await this.pool.query(
        `UPDATE live_guard_state 
         SET runtime_mode = $1, mode_updated_at = now() 
         WHERE key = $2`,
        [newMode, LATCH_KEY],
      );
      await this.pollOnce();
      return { ok: true, mode: this.currentMode };
    } catch (err) {
      return {
        ok: false,
        code: "DB_UPDATE_FAILED",
        reason: `failed to update mode in database: ${(err as Error).message}`,
      };
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.pollOnce().catch(() => {});
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

- [ ] **Step 4: Export `ModeWatcher` from `src/pm/runtime/src/index.ts`**

Modify `/root/polyroot-audit/src/pm/runtime/src/index.ts` to add export:
```typescript
export {
  ModeWatcher,
  type ModeWatcherOptions,
  type RuntimeMode,
  type QueryablePool,
} from "./mode-watcher.js";
```

- [ ] **Step 5: Run contract test to verify it passes**

Run: `node --test --import tsx tests/pm/contracts/mode-watcher.test.ts`
Expected: PASS (4/4 tests pass)

- [ ] **Step 6: Commit**

```bash
git add src/pm/runtime/src/mode-watcher.ts src/pm/runtime/src/index.ts tests/pm/contracts/mode-watcher.test.ts
git commit -m "feat(runtime): add ModeWatcher for dynamic mode hot-reload and fail-closed DB degradation"
```

---

### Task 3: CLI Mode Command Integration & Full Verification

**Files:**
- Modify: `/root/polyroot-audit/src/pm/runtime/src/cli.ts`
- Modify: `/root/polyroot-audit/src/pm/runtime/src/main.ts`

- [ ] **Step 1: Add `polyroot mode` CLI subcommand**

Update `/root/polyroot-audit/src/pm/runtime/src/cli.ts` to add help & command parser for `polyroot mode <MODE>`.

- [ ] **Step 2: Run full CI test suite**

Run: `npm run ci`
Expected: PASS (Exit code 0, 588+ contract tests pass)

- [ ] **Step 3: Commit**

```bash
git add src/pm/runtime/src/cli.ts
git commit -m "feat(cli): add polyroot mode command for interactive runtime mode management"
```

---

## Handoff

Plan complete and saved. Execute task-by-task using TDD cycle and verify each task before proceeding.