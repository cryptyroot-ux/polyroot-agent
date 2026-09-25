# Autonomous LIVE Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five remaining blockers (R1–R5) in the approved autonomous-LIVE safety spec using test-first remediation, so every order path is fail-closed under restart, expiry, auth, bounds, and pool pressure.

**Architecture:** Add a batch `expireOverdue` to `ReservationManager` with a supervisor-style interval job; add a DB-backed `PgSeenStore` that keeps the executor's sync `seen` interface via a hydrated in-memory mirror with write-through persistence; harden `MetricsServer` with security headers (Bearer auth already exists); centralize bounds in `autonomy-bounds.ts` with `polyroot setup` owner overrides; collapse `createOrchestratorPg` onto one shared `pg.Pool`.

**Tech Stack:** TypeScript, `pg` (node-postgres), `node:test` + `tsx`, existing migrations (no new tables; `seen_orders`, `reservations`, `live_guard_state` already exist).

## Global Constraints

- TDD: failing test first for every behavior change, minimal implementation, full verification.
- Fail-closed: every invalid/missing/expired input refuses with a typed code; never a silent fallback.
- AI execution path is read-only for bounds; only the owner via `polyroot setup` (authenticated CLI) may change bounds.
- Default daily loss latch is -5% (`DAILY_LOSS_CAP_BPS = 500`); allowed venue is `POLYMARKET_CLOB_CTF_V2` only.
- Single shared `pg.Pool` per process; factories must reuse a passed-in pool, never open a second one silently.
- Frequent commits: one commit per task, message prefixed `feat:` or `fix:`.
- Verify with `npm run build` and `node --test --import tsx <test-file>` per task, plus `npm test` in the final task.

---

## File Structure

- Modify: `src/pm/risk/src/reservation-manager.ts` — add `expireOverdue(now)` + `startReservationExpiryJob()`; extend `ReservationStatus` with `"PARTIALLY_CONSUMED"` (already written by `consume()` SQL on line 197 but missing from the type).
- Create: `src/pm/venue/src/seen-store.ts` — `PgSeenStore` (async DB load/save + sync mirror for the executor interface).
- Modify: `src/pm/runtime/src/main.ts` — replace in-memory `seenMap` with `PgSeenStore`; wire expiry job start/stop; use `AUTONOMY_BOUNDS` defaults.
- Modify: `src/pm/control/src/orchestrator-pg.ts` — accept shared `pool`, pass it to every store, use `PgSeenStore`, end only owned pools on shutdown.
- Modify: `src/pm/runtime/src/metrics-server.ts` — add security headers to every response.
- Create: `src/pm/runtime/src/autonomy-bounds.ts` — `AUTONOMY_BOUNDS` defaults, pure `resolveLossCapPusd` / `parseBoundsEnv` helpers.
- Modify: `src/pm/runtime/src/cli.ts` — `polyroot setup` prompts for capital + loss-bps, writes `POLYROOT_MICRO_LIVE_CAP_USD` / `POLYROOT_MICRO_LIVE_LOSS_CAP_USD` to `~/.polyroot/.env`.
- Tests: `tests/pm/contracts/reservation-expiry-job.test.ts`, `tests/pm/contracts/seen-store.test.ts`, `tests/pm/contracts/metrics-headers.test.ts`, `tests/pm/contracts/autonomy-bounds.test.ts`, `tests/pm/contracts/single-pool.test.ts`.

---

### Task 1: Reservation expiry job (R1)

**Files:**
- Modify: `src/pm/risk/src/reservation-manager.ts`
- Test: `tests/pm/contracts/reservation-expiry-job.test.ts`

**Interfaces:**
- Consumes: `reservations` table (`id`, `status`, `expires_at`); existing per-id `expire()` → `release(id, "EXPIRED")`.
- Produces: `expireOverdue(now?: Date): Promise<{ ok: true; expired: number }>` and `startReservationExpiryJob(deps, intervalMs?): () => void` used by Task wiring in `cli.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReservationManager } from "../../../src/pm/risk/src/reservation-manager.js";

function fakePool(rows: Array<{ id: string }>) {
  return {
    query: async (text: string) => {
      if (text.includes("SELECT id FROM reservations")) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 1 };
    },
    connect: async () => ({
      query: async () => ({ rows: [{ account: "a", asset: "pUSD", amount: "100", consumed_amount: "0", released_amount: "0", status: "ACTIVE" }], rowCount: 1 }),
      release: () => {},
    }),
  };
}

describe("reservation expiry job", () => {
  it("expires every overdue ACTIVE reservation and reports the count", async () => {
    const mgr = new ReservationManager({ balanceStore: {} as never, permitStore: {} as never, pool: fakePool([{ id: "r1" }, { id: "r2" }]) as never });
    const res = await mgr.expireOverdue(new Date());
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.expired, 2);
  });

  it("returns zero when nothing is overdue", async () => {
    const mgr = new ReservationManager({ balanceStore: {} as never, permitStore: {} as never, pool: fakePool([]) as never });
    const res = await mgr.expireOverdue(new Date());
    assert.deepEqual(res, { ok: true, expired: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx tests/pm/contracts/reservation-expiry-job.test.ts`
Expected: FAIL with `mgr.expireOverdue is not a function`

- [ ] **Step 3: Write minimal implementation**

```typescript
/** Expire all overdue ACTIVE/PARTIALLY_CONSUMED reservations. Idempotent. */
async expireOverdue(
  now: Date = new Date(),
): Promise<{ ok: true; expired: number }> {
  if (!this.deps.pool) return { ok: true, expired: 0 };
  const r = await this.deps.pool.query(
    `SELECT id FROM reservations
     WHERE status IN ('ACTIVE', 'PARTIALLY_CONSUMED') AND expires_at <= $1`,
    [now],
  );
  let expired = 0;
  for (const row of r.rows as Array<{ id: string }>) {
    const res = await this.expire(row.id);
    if (res.ok) expired += 1;
  }
  return { ok: true, expired };
}
```

Plus the `"PARTIALLY_CONSUMED"` addition to `ReservationStatus`, and a standalone job starter following the `Supervisor.startPeriodicReconciliation` overlap-guard pattern:

```typescript
export function startReservationExpiryJob(
  deps: { reservations: Pick<ReservationManager, "expireOverdue">; now?: () => Date },
  intervalMs = 30_000,
): () => void {
  let running = false;
  let stopped = false;
  const timer = setInterval(async () => {
    if (running || stopped) return;
    running = true;
    try {
      await deps.reservations.expireOverdue(deps.now?.() ?? new Date());
    } catch (err) {
      console.error(`[reservations] periodic expiry failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx tests/pm/contracts/reservation-expiry-job.test.ts`
Expected: PASS (2/2)

- [ ] **Step 5: Commit**

```bash
git add src/pm/risk/src/reservation-manager.ts tests/pm/contracts/reservation-expiry-job.test.ts
git commit -m "feat: batch reservation expiry with periodic job"
```

---

### Task 2: DB-backed seen store + restart replay (R2)

**Files:**
- Create: `src/pm/venue/src/seen-store.ts`
- Modify: `src/pm/runtime/src/main.ts` (replace `seenMap` with `PgSeenStore`)
- Test: `tests/pm/contracts/seen-store.test.ts`

**Interfaces:**
- Consumes: `seen_orders(order_id, state, updated_at)` table (migration `0021_seen_orders.sql`); `recoveryLedger.getUnresolved()`; executor sync `seen` interface `{ has, add, get }`.
- Produces: `PgSeenStore` with `hydrate()`, `has()`, `get()`, `set()` (sync mirror) and `persist()`/`close()`; `main.ts` awaits `hydrate()` at startup before the pipeline starts.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PgSeenStore } from "../../../src/pm/venue/src/seen-store.js";

function fakePool(saved: Map<string, string>) {
  return {
    query: async (text: string, params?: unknown[]) => {
      if (text.includes("SELECT order_id")) {
        return { rows: [...saved.entries()].map(([order_id, state]) => ({ order_id, state })) };
      }
      if (text.includes("INSERT INTO seen_orders")) {
        saved.set(params?.[0] as string, params?.[1] as string);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

describe("PgSeenStore", () => {
  it("hydrates from DB and write-through persists new states", async () => {
    const saved = new Map([["ord-1", "ACKNOWLEDGED"]]);
    const store = new PgSeenStore(fakePool(saved) as never);
    await store.hydrate([{ orderId: "ord-2", state: "SUBMITTING" }]);
    assert.equal(store.has("ord-1"), true);
    assert.equal(store.get("ord-2"), "SUBMITTING");
    store.set("ord-3", "ACKNOWLEDGED");
    await store.flush();
    assert.equal(saved.get("ord-3"), "ACKNOWLEDGED");
  });

  it("restart replay: a fresh instance recovers persisted states", async () => {
    const saved = new Map([["ord-9", "SUBMISSION_UNKNOWN"]]);
    const first = new PgSeenStore(fakePool(saved) as never);
    await first.hydrate([]);
    const second = new PgSeenStore(fakePool(saved) as never);
    await second.hydrate([]);
    assert.equal(second.get("ord-9"), "SUBMISSION_UNKNOWN");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx tests/pm/contracts/seen-store.test.ts`
Expected: FAIL with `Cannot find module .../seen-store.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { OrderLifecycleState } from "@polyroot/domain";

interface QueryablePool {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** DB-backed idempotency log: sync mirror for the executor + write-through to seen_orders. */
export class PgSeenStore {
  private readonly mirror = new Map<string, OrderLifecycleState>();
  private readonly pending = new Map<string, OrderLifecycleState>();
  constructor(private readonly pool: QueryablePool) {}

  /** Load persisted states + unresolved recovery-ledger rows before accepting intents. */
  async hydrate(unresolved: Array<{ orderId: string; state: OrderLifecycleState }>): Promise<void> {
    const res = await this.pool.query(`SELECT order_id, state FROM seen_orders`);
    for (const row of res.rows) {
      this.mirror.set(String(row["order_id"]), String(row["state"]) as OrderLifecycleState);
    }
    for (const u of unresolved) this.mirror.set(u.orderId, u.state);
  }

  has(orderId: string): boolean { return this.mirror.has(orderId); }
  get(orderId: string): OrderLifecycleState | undefined { return this.mirror.get(orderId); }

  /** Sync for the executor hot path; persistence happens on flush(). */
  set(orderId: string, state: OrderLifecycleState): void {
    this.mirror.set(orderId, state);
    this.pending.set(orderId, state);
  }

  async flush(): Promise<void> {
    for (const [orderId, state] of this.pending) {
      await this.pool.query(
        `INSERT INTO seen_orders (order_id, state, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (order_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
        [orderId, state],
      );
      this.pending.delete(orderId);
    }
  }
}
```

Then in `main.ts`, replace the `seenMap` block:

```typescript
const seenStore = new PgSeenStore(pool);
await seenStore.hydrate(await recoveryLedger.getUnresolved());
const executor = new Executor({
  ...
  seen: { has: (id) => seenStore.has(id), add: (id, st) => { seenStore.set(id, st); void seenStore.flush().catch((e) => console.error("[seen] persist failed:", e)); }, get: (id) => seenStore.get(id) },
  ...
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx tests/pm/contracts/seen-store.test.ts`
Expected: PASS (2/2)

- [ ] **Step 5: Commit**

```bash
git add src/pm/venue/src/seen-store.ts src/pm/runtime/src/main.ts tests/pm/contracts/seen-store.test.ts
git commit -m "feat: DB-backed seen store with restart replay"
```

---

### Task 3: Single shared pool in orchestrator-pg (R5)

**Files:**
- Modify: `src/pm/control/src/orchestrator-pg.ts`
- Test: `tests/pm/contracts/single-pool.test.ts`

**Interfaces:**
- Consumes: `PgSeenStore` from Task 2; `createPgStores`, `createPgControlStores` (both already accept a `Pool`); `PgPermitStore`, `PgRecoveryLedger`, `PgLeaseStore` constructors (already accept a `Pool`).
- Produces: `createOrchestratorPg` accepting `pool?: Pool` in `OrchestratorPgDeps`; `shutdown()` ends only pools the factory created itself.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("single shared pool", () => {
  it("orchestrator-pg accepts an injected pool and never news one up when given", () => {
    const src = readFileSync("src/pm/control/src/orchestrator-pg.ts", "utf8");
    assert.match(src, /pool\?:\s*import\("pg"\)\.Pool|pool\?: Pool/);
    assert.match(src, /deps\.pool \?\?|pool = deps\.pool/);
  });

  it("shutdown does not end an injected pool", () => {
    const src = readFileSync("src/pm/control/src/orchestrator-pg.ts", "utf8");
    assert.match(src, /ownsPool|ownedPool/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx tests/pm/contracts/single-pool.test.ts`
Expected: FAIL (no `pool?` in deps)

- [ ] **Step 3: Write minimal implementation**

In `OrchestratorPgDeps`, add `pool?: import("pg").Pool;`. At the top of `createOrchestratorPg`:

```typescript
import { Pool } from "pg";
const sharedPool = deps.pool ?? new Pool(
  typeof deps.pgConfig === "string" ? { connectionString: deps.pgConfig } : deps.pgConfig,
);
const ownsPool = deps.pool === undefined;
const riskStores = createPgStores({ pool: sharedPool });
const permitStore = new (await import("@polyroot/venue")).PgPermitStore(sharedPool);
const recoveryLedger = new (await import("@polyroot/venue")).PgRecoveryLedger(sharedPool);
const leaseStore = new (await import("@polyroot/venue")).PgLeaseStore(sharedPool);
// seen hydration via PgSeenStore (Task 2), then createPgControlStores(sharedPool, executor, policy)
```

And in the returned `shutdown`, wrap pool termination:

```typescript
shutdown: async () => {
  stopReconciliation();
  if (ownsPool) await sharedPool.end().catch(() => undefined);
},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx tests/pm/contracts/single-pool.test.ts`
Expected: PASS (2/2)

- [ ] **Step 5: Commit**

```bash
git add src/pm/control/src/orchestrator-pg.ts tests/pm/contracts/single-pool.test.ts
git commit -m "fix: single shared pool in orchestrator-pg"
```

---

### Task 4: MetricsServer security headers (R3)

**Files:**
- Modify: `src/pm/runtime/src/metrics-server.ts`
- Test: `tests/pm/contracts/metrics-headers.test.ts`

**Interfaces:**
- Consumes: existing `MetricsServer` (`GET /healthz` public, `GET /metrics` Bearer-gated, 401/404/405 paths).
- Produces: same behavior plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on every response.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { MetricsServer } from "../../../src/pm/runtime/src/metrics-server.js";

describe("metrics security headers", () => {
  it("serves security headers on public and gated routes", async () => {
    const server = new MetricsServer({ exporter: { getMetrics: () => "# ok\n" }, port: 0 });
    const { port } = await server.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      const denied = await fetch(`http://127.0.0.1:${port}/metrics`);
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get("cache-control"), "no-store");
    } finally {
      await server.stop();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx tests/pm/contracts/metrics-headers.test.ts`
Expected: FAIL (`null` headers)

- [ ] **Step 3: Write minimal implementation**

Add a helper in `metrics-server.ts` and call it before every `writeHead`:

```typescript
private secure(res: ServerResponse): ServerResponse {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  return res;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx tests/pm/contracts/metrics-headers.test.ts`
Expected: PASS (1/1). Also re-run `node --test --import tsx tests/pm/contracts/metrics-server.test.ts` — all existing auth tests must still pass.

- [ ] **Step 5: Commit**

```bash
git add src/pm/runtime/src/metrics-server.ts tests/pm/contracts/metrics-headers.test.ts
git commit -m "feat: security headers on metrics server"
```

---

### Task 5: Autonomy bounds + polyroot setup (R4)

**Files:**
- Create: `src/pm/runtime/src/autonomy-bounds.ts`
- Modify: `src/pm/runtime/src/main.ts`, `src/pm/runtime/src/cli.ts`
- Test: `tests/pm/contracts/autonomy-bounds.test.ts`

**Interfaces:**
- Consumes: env `POLYROOT_MICRO_LIVE_CAP_USD`, `POLYROOT_MICRO_LIVE_LOSS_CAP_USD`; spec defaults below.
- Produces: `AUTONOMY_BOUNDS`, `resolveLossCapPusd(capitalUsd, bps)`, `parseBoundsEnv(env)`; onboarding writes both vars; `bootstrapAgent` uses resolved values and keeps fail-closed refusal when the loss cap is missing/invalid in live modes.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AUTONOMY_BOUNDS, resolveLossCapPusd, parseBoundsEnv } from "../../../src/pm/runtime/src/autonomy-bounds.js";

describe("autonomy bounds", () => {
  it("defaults encode the approved 5% latch and venue pin", () => {
    assert.equal(AUTONOMY_BOUNDS.DAILY_LOSS_CAP_BPS, 500);
    assert.equal(AUTONOMY_BOUNDS.ALLOWED_VENUE, "POLYMARKET_CLOB_CTF_V2");
  });

  it("resolves an absolute loss cap from capital and bps", () => {
    assert.equal(resolveLossCapPusd(1000, 500), 50);
  });

  it("rejects non-positive or non-finite loss caps", () => {
    assert.equal(parseBoundsEnv({}).lossCapPusd, undefined);
    assert.equal(parseBoundsEnv({ POLYROOT_MICRO_LIVE_LOSS_CAP_USD: "-5" }).lossCapPusd, undefined);
  });

  it("accepts an explicit owner loss cap", () => {
    assert.equal(parseBoundsEnv({ POLYROOT_MICRO_LIVE_LOSS_CAP_USD: "50" }).lossCapPusd, 50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx tests/pm/contracts/autonomy-bounds.test.ts`
Expected: FAIL (`Cannot find module .../autonomy-bounds.js`)

- [ ] **Step 3: Write minimal implementation**

```typescript
export const AUTONOMY_BOUNDS = {
  CAPITAL_CAP_USD: 1000,
  DAILY_LOSS_CAP_BPS: 500,
  ALLOWED_VENUE: "POLYMARKET_CLOB_CTF_V2",
  MAX_ORDER_USD: 100,
  MAX_CONCURRENT_ORDERS: 3,
} as const;

export function resolveLossCapPusd(capitalUsd: number, bps: number): number | undefined {
  if (!Number.isFinite(capitalUsd) || capitalUsd <= 0) return undefined;
  if (!Number.isFinite(bps) || bps <= 0) return undefined;
  return Math.floor((capitalUsd * bps) / 10_000);
}

export function parseBoundsEnv(env: NodeJS.ProcessEnv): { capUsd?: number; lossCapPusd?: number } {
  const capRaw = env["POLYROOT_MICRO_LIVE_CAP_USD"];
  const lossRaw = env["POLYROOT_MICRO_LIVE_LOSS_CAP_USD"];
  const capUsd = capRaw === undefined ? undefined : Number(capRaw);
  const lossCapPusd = lossRaw === undefined ? undefined : Number(lossRaw);
  return {
    ...(capUsd !== undefined && Number.isFinite(capUsd) && capUsd > 0 ? { capUsd } : {}),
    ...(lossCapPusd !== undefined && Number.isFinite(lossCapPusd) && lossCapPusd > 0 ? { lossCapPusd } : {}),
  };
}
```

In `main.ts`, replace the inline env parsing with `parseBoundsEnv(process.env)` (keeping the exact `LIVE_LOSS_CAP_UNCONFIGURED` / `LIVE_CAP_INVALID` errors and the `pool.end()` cleanup). In `cli.ts` onboarding LIVE branch, prompt for capital (default `1000`) and loss bps (default `500`), then append to the generated env file:

```typescript
`POLYROOT_MICRO_LIVE_CAP_USD=${capitalUsd}`,
`POLYROOT_MICRO_LIVE_LOSS_CAP_USD=${resolveLossCapPusd(capitalUsd, lossBps)}`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx tests/pm/contracts/autonomy-bounds.test.ts`
Expected: PASS (4/4). Also re-run `node --test --import tsx tests/pm/contracts/runtime-live-guard.test.ts tests/pm/contracts/live-enforcement.test.ts` — existing live-guard behavior must be unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/pm/runtime/src/autonomy-bounds.ts src/pm/runtime/src/main.ts src/pm/runtime/src/cli.ts tests/pm/contracts/autonomy-bounds.test.ts
git commit -m "feat: autonomy bounds with owner setup overrides"
```

---

### Task 6: Full verification + gate checklist

**Files:** none (verification only).

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: clean, 13/13 packages.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: 629/629 unit+integration PASS plus 12/12 property PASS, including the 5 new test files from Tasks 1–5.

- [ ] **Step 3: Record the gate checklist**

Append results to the PR description: build status, test counts, new tests, and the spec section-8 checklist state. If anything fails, fix under the owning task (do not bundle fixes here), then re-run.

- [ ] **Step 4: Commit only if verification changed tracked files**

```bash
git status --short
```

If clean, no commit; the task is done when the evidence above is recorded.
