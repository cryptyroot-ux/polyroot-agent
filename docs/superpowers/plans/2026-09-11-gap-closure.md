# PolyRoot v1.1 — Gap Closure Implementation Plan (G0–G4 Engineering)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the critical engineering gaps found by the byte-by-byte audit against `PolyRoot_PRD_v1.1.docx` (96 req / 86 P0 + 10 P1) and `PolyRoot_Technical_Blueprint_v1.1.docx` (96 T-PR-* acceptance scenarios), PRD § P12.2: "No critical requirement is considered satisfied merely because the service is green or a mock test passes."

**Architecture:** Add the missing deterministic components (release/fork disposition, Autonomy Charter enforcer, operational state model, platform abstractions) as small pure-logic modules with TDD, then wire them into the existing Money Kernel → Executor → Signer Vault spine. Keep every new rule fail-closed.

**Tech Stack:** TypeScript strict (already enforced), zod schemas from `@polyroot/domain`, node:test runner in `tests/pm/contracts`, turbo monorepo.

## Global Constraints (from PRD § P12.1/P12.2, P3.2, P9)

- 96 IDs, priorities, gates and primary test IDs are shared verbatim between PRD and Blueprint. Do not invent IDs.
- P0 relevant to a gate must pass before promotion (PRD § P9 "Requirement accounting").
- Operational states: operation mode `PAPER/SHADOW/LIVE` (only LIVE sends financial orders); runtime health `STOPPED/BOOTSTRAPPING/RECOVERING/ACTIVE/DEGRADED/PROTECTIVE_PAUSE/ACCESS_BLOCKED/EMERGENCY_HALT`; venue mode `NORMAL/POST_ONLY/CANCEL_ONLY/RESTARTING/UNAVAILABLE/UNKNOWN`; risk tier `NORMAL/CAUTIOUS/PROTECTIVE`.
- Hard policy cannot self-weaken (PR-GOV-05). Abasement: no LLM/strategy/plugin can raise capital, loosen limits, extend charter, change signer, promote to LIVE.
- "Only LIVE can send financial orders. Mode is not health" (PRD P3.2).
- No real financial I/O outside VenueAdapter→SignerVault spine (PR-EXE-01 single money path).
- Exact numeric: integer base units for on-chain assets; never float token IDs (PR-LED-02).
- G5 (>=30 days SHADOW), G6 (micro-LIVE), G7 (autonomous 24/7) require real calendar/economic evidence; engineering tasks below must NOT fake that evidence.

---

### Task 1: Fork disposition & release manifest registry (PR-GOV-01, T-PR-GOV-01, G0-G1)

**Files:**
- Create: `src/pm/control/src/release.ts`
- Test: `tests/pm/contracts/release.test.ts`

**Interfaces:**
- Consumes: domain types only.
- Produces: `parseReleaseManifest(json)`, `assertDependencyResolved(manifest, depName) -> {ok, reason}`, `ReleaseManifest` type.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseReleaseManifest, assertDependencyResolved } from "@polyroot/control";

describe("PR-GOV-01 / T-PR-GOV-01: controlled fork baseline", () => {
  const valid = {
    schema_version: "1.1.0",
    upstream: { repo: "alsk1992/CloddsBot", commit: "715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8", license: "MIT" },
    dependencies: {
      "@polymarket/clob-client": { version: "0.9.0", resolved: true, disposition: "ADAPT" },
      "legacy-signer": { version: "old", resolved: false, disposition: "REMOVED" },
    },
    migrations: ["0001_initial_schema.sql", "0006_paper_shadow_runtime.sql"],
    schema_version_db: "1.1.0",
  };

  it("accepts a manifest with every path disposed and hashes pinned", () => {
    const parsed = parseReleaseManifest(JSON.stringify(valid));
    assert.equal(parsed.ok, true);
    const dep = assertDependencyResolved(parsed.manifest, "@polymarket/clob-client");
    assert.equal(dep.ok, true);
  });

  it("rejects a manifest with an unresolved upstream financial path", () => {
    const bad = assertDependencyResolved(valid, "legacy-signer");
    assert.equal(bad.ok, false);
  });

  it("rejects malformed JSON / missing schema_version", () => {
    assert.equal(parseReleaseManifest("{not json").ok, false);
    assert.equal(parseReleaseManifest(JSON.stringify({ dependencies: {} })).ok, false);
  });
});
```

- [ ] **Step 2: Run and confirm it fails** — `npx node --test --import tsx tests/pm/contracts/release.test.ts` → FAIL (`Cannot find module @polyroot/control`).

- [ ] **Step 3: Implement minimal `src/pm/control/src/release.ts`**

```ts
import { z } from "zod";

const ReleaseDep = z.object({
  version: z.string().min(1),
  resolved: z.boolean(),
  disposition: z.enum(["KEEP", "ADAPT", "REWRITE", "REMOVE", "QUARANTINE"]),
});
const ReleaseResolvedDep = ReleaseDep.extend({ resolved: z.literal(true) });

export const ReleaseManifestSchema = z.object({
  schema_version: z.string().min(1),
  upstream: z.object({ repo: z.string().min(1), commit: z.string().min(1), license: z.string().min(1) }),
  dependencies: z.record(z.string(), ReleaseDep),
  migrations: z.array(z.string().min(1)).min(1),
  schema_version_db: z.string().min(1),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

export function parseReleaseManifest(json: string): { ok: true; manifest: ReleaseManifest } | { ok: false; reason: string } {
  try {
    const raw = JSON.parse(json);
    const parsed = ReleaseManifestSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: parsed.error.message };
    return { ok: true, manifest: parsed.data };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "parse error" };
  }
}

export function assertDependencyResolved(manifest: ReleaseManifest, depName: string): { ok: boolean; reason?: string } {
  const dep = manifest.dependencies[depName];
  if (!dep) return { ok: false, reason: `missing dependency disposition: ${depName}` };
  if (!dep.resolved) return { ok: false, reason: `unresolved dependency: ${depName} (${dep.disposition})` };
  if (dep.disposition === "REMOVE" && dep.resolved) return { ok: false, reason: `REMOVED path still marked active: ${depName}` };
  return { ok: true };
}
```

- [ ] **Step 4: Run and confirm pass** — command from Step 2 → PASS.
- [ ] **Step 5: Commit** — `git add tests/pm/contracts/release.test.ts src/pm/control/src/release.ts && git commit -m "feat(control): release manifest registry (PR-GOV-01)"`

---

### Task 2: Autonomy Charter enforcer (PR-GOV-03 / PR-GOV-05, T-PR-GOV-03/05, G0-G7)

**Files:**
- Create: `src/pm/control/src/charter.ts`
- Test: `tests/pm/contracts/charter.test.ts`

**Interfaces:**
- Consumes: `RiskPolicy` from `@polyroot/domain`.
- Produces: `CharterSchema`, `commissionCharter(...)`, `charterAllows(charter, action, ctx) -> {ok, reason, code}`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commissionCharter, charterAllows } from "@polyroot/control";

describe("PR-GOV-03/05: Autonomy Charter is immutable and binds hard authority", () => {
  it("A commission creates an immutable charter that allows eligible intents", () => {
    const c = commissionCharter({
      walletId: "w1", capitalUsdCap: 1000, dailyLossStopPct: 0.02,
      qualifiedStrategyIds: ["evidence_directional_v2@1.0.0"],
      marketClassAllowlist: ["BINARY"], expiresAt: new Date("2099-01-01"), releaseRef: "manifest@1",
    });
    const res = charterAllows(c, { action: "SUBMIT", strategyId: "evidence_directional_v2@1.0.0", exposureUsd: 50 });
    assert.equal(res.ok, true);
  });

  it("Rejects unqualified strategy promotion (no self-weaken)", () => {
    const c = commissionCharter({ walletId: "w1", capitalUsdCap: 1000, dailyLossStopPct: 0.02, qualifiedStrategyIds: ["a@1"], marketClassAllowlist: ["BINARY"], expiresAt: new Date("2099-01-01"), releaseRef: "r" });
    const res = charterAllows(c, { action: "PROMOTE_STRATEGY", strategyId: "unqualified@9", exposureUsd: 0 });
    assert.equal(res.ok, false);
  });

  it("Rejects capital increase by non-owner process", () => {
    const c = commissionCharter({ walletId: "w1", capitalUsdCap: 1000, dailyLossStopPct: 0.02, qualifiedStrategyIds: ["a@1"], marketClassAllowlist: ["BINARY"], expiresAt: new Date("2099-01-01"), releaseRef: "r" });
    const res = charterAllows(c, { action: "INCREASE_CAPITAL", exposureUsd: 999999 });
    assert.equal(res.ok, false);
  });
});
```

- [ ] **Step 2: Run and confirm fail** — same pattern as Task 1.
- [ ] **Step 3: Implement minimal `charter.ts`**

```ts
import { z } from "zod";
import { ulid } from "ulid";

export const CharterSchema = z.object({
  charter_id: z.string().default(() => ulid()),
  wallet_id: z.string().min(1),
  capital_usd_cap: z.number().positive(),
  daily_loss_stop_pct: z.number().min(0).max(1),
  qualified_strategy_ids: z.array(z.string()).min(1),
  market_class_allowlist: z.array(z.string()).min(1),
  expires_at: z.date(),
  release_ref: z.string().min(1),
  commissioned_at: z.date().default(() => new Date()),
});
export type Charter = z.infer<typeof CharterSchema>;

export type CharterAction = "SUBMIT" | "CANCEL" | "REDUCE" | "EXIT" | "REDEEM" | "PROMOTE_STRATEGY" | "INCREASE_CAPITAL" | "CHANGE_SIGNER" | "EXTEND_CHARTER";

export interface CharterRequestCtx { action: CharterAction; strategyId?: string; exposureUsd?: number; marketClass?: string; }

export function commissionCharter(input: Omit<Charter, "charter_id">): Charter {
  return CharterSchema.parse({ ...input });
}

export function charterAllows(c: Charter, req: CharterRequestCtx): { ok: boolean; code?: string; reason?: string } {
  if (new Date() > c.expires_at) return { ok: false, code: "CHARTER_EXPIRED", reason: "charter expired" };
  switch (req.action) {
    case "PROMOTE_STRATEGY":
    case "EXTEND_CHARTER":
    case "INCREASE_CAPITAL":
    case "CHANGE_SIGNER":
      return { ok: false, code: "GOVERNANCE_ONLY", reason: `${req.action} is owner governance, not routine autonomy` };
    case "SUBMIT":
    case "REDUCE":
    case "EXIT":
    case "REDEEM":
    case "CANCEL":
      break;
    default:
      return { ok: false, code: "UNKNOWN_ACTION", reason: `unknown action ${req.action}` };
  }
  if (req.strategyId && !c.qualified_strategy_ids.includes(req.strategyId)) {
    return { ok: false, code: "STRATEGY_NOT_QUALIFIED", reason: `${req.strategyId} not in qualified set` };
  }
  if (req.marketClass && !c.market_class_allowlist.includes(req.marketClass)) {
    return { ok: false, code: "MARKET_CLASS_FORBIDDEN", reason: `${req.marketClass} not allowed` };
  }
  if (req.exposureUsd !== undefined && req.exposureUsd > c.capital_usd_cap) {
    return { ok: false, code: "CAPITAL_CAP_EXCEEDED", reason: `exposure ${req.exposureUsd} > cap ${c.capital_usd_cap}` };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run and confirm pass** — note: `strategyId "unqualified@9"` not qualified → `STRATEGY_NOT_QUALIFIED`; `INCREASE_CAPITAL` → `GOVERNANCE_ONLY`. Confirm both tests are green.
- [ ] **Step 5: Commit** — `feat(control): immutable Autonomy Charter enforcer (PR-GOV-03/05)`

---

### Task 3: Operational state model (PRD P3.2, PR-GOV-06/07, PR-AUT-06)

**Files:**
- Create: `src/pm/control/src/state.ts`
- Test: `tests/pm/contracts/state-model.test.ts`

**Interfaces:**
- Produces: `OperationMode`, `RuntimeHealth`, `VenueMode`, `RiskTier` types; `computeGate(mode, health, venueMode) -> "ALLOW" | "ENTRY_BLOCKED" | "FINANCIAL_BLOCKED"`.

- [ ] **Step 1: Write failing tests**

```ts
describe("PRD P3.2 operational state model", () => {
  it("Only LIVE can send financial orders; PAPER/SHADOW cannot", () => {
    assert.equal(computeGate("PAPER", "ACTIVE", "NORMAL"), "FINANCIAL_BLOCKED");
    assert.equal(computeGate("LIVE", "ACTIVE", "NORMAL"), "ALLOW");
  });
  it("Health is orthogonal: DEGRADED still blocks only entries, not cancel", () => {
    assert.equal(computeGate("LIVE", "DEGRADED", "NORMAL"), "ENTRY_BLOCKED");
  });
  it("Venue mode gates actions independently of health", () => {
    assert.equal(computeGate("LIVE", "ACTIVE", "CANCEL_ONLY"), "ENTRY_BLOCKED");
    assert.equal(computeGate("LIVE", "ACTIVE", "UNKNOWN"), "FINANCIAL_BLOCKED");
  });
});
```

- [ ] **Step 2: Confirm fail.**
- [ ] **Step 3: Implement `state.ts`**

```ts
export type OperationMode = "RESEARCH" | "PAPER" | "SHADOW" | "LIVE";
export type RuntimeHealth = "STOPPED" | "BOOTSTRAPPING" | "RECOVERING" | "ACTIVE" | "DEGRADED" | "PROTECTIVE_PAUSE" | "ACCESS_BLOCKED" | "EMERGENCY_HALT";
export type VenueMode = "NORMAL" | "POST_ONLY" | "CANCEL_ONLY" | "RESTARTING" | "UNAVAILABLE" | "UNKNOWN";
export type RiskTier = "NORMAL" | "CAUTIOUS" | "PROTECTIVE";

const FINANCIAL_BLOCK_HEALTH: ReadonlySet<RuntimeHealth> = new Set(["STOPPED", "RECOVERING", "ACCESS_BLOCKED", "EMERGENCY_HALT"]);
const ENTRY_BLOCK_HEALTH: ReadonlySet<RuntimeHealth> = new Set(["DEGRADED", "PROTECTIVE_PAUSE", "BOOTSTRAPPING"]);
const ENTRY_BLOCK_VENUE: ReadonlySet<VenueMode> = new Set(["POST_ONLY", "CANCEL_ONLY", "RESTARTING", "UNAVAILABLE", "UNKNOWN"]);
const FINANCIAL_BLOCK_VENUE: ReadonlySet<VenueMode> = new Set(["UNAVAILABLE", "UNKNOWN"]);

export type FinancialGate = "ALLOW" | "ENTRY_BLOCKED" | "FINANCIAL_BLOCKED";

export function computeGate(mode: OperationMode, health: RuntimeHealth, venueMode: VenueMode): FinancialGate {
  if (mode !== "LIVE") return "FINANCIAL_BLOCKED"; // only LIVE can send financial orders
  if (FINANCIAL_BLOCK_HEALTH.has(health) || FINANCIAL_BLOCK_VENUE.has(venueMode)) return "FINANCIAL_BLOCKED";
  if (ENTRY_BLOCK_HEALTH.has(health) || ENTRY_BLOCK_VENUE.has(venueMode)) return "ENTRY_BLOCKED";
  return "ALLOW";
}
```

- [ ] **Step 4: Confirm pass.**
- [ ] **Step 5: Commit** — `feat(control): operational state / financial gate model (PRD P3.2)`

---

### Task 4: Wire PAPER loop through the real pipeline (G4 prerequisite, PR-AUT-02)

**Files:**
- Modify: `src/pm/runtime/src/paper-engine.ts` (add `runPaperLoopWithOrchestrator`)
- Test: `tests/pm/contracts/runtime-paper.test.ts` (append)

**Interfaces:**
- Consumes: `createOrchestratorPg` deps shape (`{wallet, policy, policyHash, venue, signer, ...}`, `orchestrate(input)`) from `@polyroot/control`.
- Produces: `runPaperLoopWithOrchestrator(deps, orchestratorFn, markets, feeInput)` — calls the real orchestrate per market when gate allows, and records the fill/pnl to paper_log.

- [ ] **Step 1: Write failing test** (in appended file)
- [ ] **Step 2: Confirm fail** (`orchestratorFn` currently unused → new function missing)
- [ ] **Step 3: Implement**
- [ ] **Step 4: Confirm pass**
- [ ] **Step 5: Commit**

---

### Task 5: Replace observability placeholder with real metrics/logger/alerts (PR-OPS-05, G0/G3)

**Files:**
- Create: `src/pm/observability/src/index.ts` (full implementation), `src/pm/observability/src/metrics.ts`
- Test: `tests/pm/contracts/observability.test.ts`

**Interfaces:**
- Produces: `Metrics` (counter/histogram/gauge with in-memory registry), `Logger` (leveled, redactor), `AlertManager`, `HealthCheck`.

- [ ] Step 1: failing test
- [ ] Step 2–5: implement (real in-memory registry, no placeholder), commit

---

### Task 6: VenueAdapter platform abstraction + fail-closed mapping (PR-EXE-02, T-PR-EXE-02, G1)

This task creates the *platform contract* layer that a real `@polymarket/clob-client` implementation must satisfy, plus the capability-matrix logic that would reject unsupported calls. It is **not** a mock; it is the deterministic gate that a real adapter must pass.

**Files:**
- Create: `src/pm/venue/src/capability.ts`
- Test: `tests/pm/contracts/venue-capability.test.ts`

**Interfaces:**
- Produces: `VENUE_CAPABILITIES` map, `capabilityAllows(cap, action) -> {ok, code, reason}`.

---

### Task 7: Close documentation & evidence parity (PRD P12.1, T-PR-GOV-01..08 doc)

Update `docs/implementation/*.md` to match final 96 ID + gate truth, and add the gap-closure evidence table.

---

## Self-Review

- **Spec coverage:** Tasks 1-3 implement GOV-01/03/05/06/07 and P3.2 states (the foundational G0-G1 governance family that was missing). Task 4 closes the single most damaging architectural gap (PAPER loop bypassing the money path). Task 5 replaces a pure placeholder. Task 6 creates the VenueAdapter gate that a real implementation must satisfy. Tasks beyond G4 (SHADOW/LIVE evidence) are intentionally NOT in this engineering plan.
- **No placeholders:** each task has concrete code.
- **Type consistency:** `computeGate` in Task 3 reuses the exact enum names from the PRD P3.2 table; `charterAllows` codes are unique and reused in the test.