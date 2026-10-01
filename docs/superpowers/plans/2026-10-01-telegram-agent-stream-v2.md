# Telegram Agent Stream v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the gimmick Telegram stream with real per-pass digests (market names + counts), full per-market reports (question, book, AI probability + verbatim reasoning, decision + reason, money), and once-per-reason dedupe — all in English.

**Architecture:** Thread `question`/`volume24h` from venue discovery into loop inputs; add pure English message builders + a dedupe helper in `@polyroot/observability`; rewire `bootstrapAgent` fan-out to the new builders; no trading-logic changes anywhere.

**Tech Stack:** TypeScript strict (ES2024, NodeNext), node:test + tsx runner, turbo 13-package build, eslint, prettier, gitleaks.

## Global Constraints

- Strict TS: `import type` for types (`verbatimModuleSyntax`); `exactOptionalPropertyTypes` (never assign `undefined` to a non-optional prop — omit the key instead); `noUncheckedIndexedAccess` (index access yields `T | undefined` — narrow it); zero `any`, use `unknown` + narrowing.
- Fail-closed: uncertainty → refusal with reason; never fabricate a displayed number (missing renders as absent, never `0`).
- No mock/simulated data outside PAPER; `--once` stays fully silent on Telegram.
- Run `npx prettier --write` on every touched file.
- Conventional commits (`feat:`, `fix:`), one concern per commit.
- Never commit secrets; test fixtures must avoid secret shapes (`sk-…`, 64-hex `0x…`, PEM blocks) so gitleaks stays green.
- Contract tests import built packages (`@polyroot/*` → `dist`): rebuild the touched workspace BEFORE running its tests: `npx turbo run build --filter=<pkg>`.
- Test runner: `node --test --import tsx <file>` from repo root; full gate `npm test` (baseline 882 contract + 12 property); lint `npm run lint`; build `npm run build`.

---

## File structure

- Modify `src/pm/venue/src/market-universe.ts` — extend `MarketSource.snapshot` return and `LiveMarketInput` with optional `question`/`volume24h`; pass through in `collectLiveInputs`.
- Modify `src/pm/runtime/src/main.ts` — snapshot attaches question (from `getOrderBook`, always present) + volume24h (startup lookup map); fan-out rewired to new builders + dedupe.
- Modify `src/pm/observability/src/telegram-stream.ts` — new `PASS_DIGEST`/`MARKET_REPORT` event types, `formatPassDigest`, `formatMarketReport`, `confidenceOf`, `ReportDedupe`; remove superseded Indonesian formatter strings.
- Modify `src/pm/runtime/src/g4-core.ts` (2 interface spots + 1 mapping) and `src/pm/runtime/src/g4-pipeline.ts` (1 call site) — `onUniversePass` summary gains `evaluated: Array<{ id: string; question: string }>`.
- Create `tests/pm/contracts/telegram-stream-v2.test.ts` — pure formatter/dedupe/confidence tests (no network, no DB).
- Modify `CHANGELOG.md` — Unreleased entry (exact text in Task 4).

---

### Task 1: Thread question + volume24h into loop inputs

**Files:**
- Modify: `src/pm/venue/src/market-universe.ts:39-71`
- Modify: `src/pm/runtime/src/main.ts` (snapshot closure inside `bootstrapAgent`, currently returns `{ bid, ask, side }`)
- Test: `tests/pm/contracts/market-input-threading.test.ts` (create)

**Interfaces:**
- Consumes: `venueAdapter.getOrderBook(marketId)` → `MarketSnapshot` (has required `question: string`); `fetchActiveMarkets(limit)` from `@polyroot/venue` → `DiscoveredMarket[]` (`yesTokenId`, `noTokenId`, `volume24h`).
- Produces: `MarketSource.snapshot()` may return `{ bid, ask, side?, question?, volume24h? }`; `LiveMarketInput` carries the same optional fields; `collectLiveInputs` copies them verbatim (absent stays absent).

- [ ] **Step 1: Extend the venue input types**

In `src/pm/venue/src/market-universe.ts`, change:

```typescript
export interface MarketSource {
  universe(): string[];
  snapshot(
    marketId: string,
  ): Promise<{
    bid: number;
    ask: number;
    side?: MarketSide;
    question?: string;
    volume24h?: number;
  } | null>;
}

export interface LiveMarketInput {
  market_id: string;
  bid: number;
  ask: number;
  side?: MarketSide;
  question?: string;
  volume24h?: number;
}
```

- [ ] **Step 2: Pass the fields through in `collectLiveInputs`**

In the same file, extend the push so optional fields survive only when present:

```typescript
inputs.push({
  market_id,
  bid: snap.bid,
  ask: snap.ask,
  ...(snap.side !== undefined ? { side: snap.side } : {}),
  ...(typeof snap.question === "string" && snap.question.length > 0
    ? { question: snap.question }
    : {}),
  ...(typeof snap.volume24h === "number" && Number.isFinite(snap.volume24h)
    ? { volume24h: snap.volume24h }
    : {}),
});
```

- [ ] **Step 3: Attach question + volume in `bootstrapAgent`**

In `src/pm/runtime/src/main.ts`, inside `bootstrapAgent` before `marketSource` is built, add a startup lookup (runs once, failures → empty map, never blocks boot):

```typescript
const marketMeta = new Map<string, { question: string; volume24h: number }>();
try {
  const { fetchActiveMarkets } = await import("@polyroot/venue");
  const discovered = await fetchActiveMarkets(50, 15_000);
  for (const d of discovered) {
    if (d.yesTokenId)
      marketMeta.set(d.yesTokenId, {
        question: d.question,
        volume24h: d.volume24h,
      });
    if (d.noTokenId)
      marketMeta.set(d.noTokenId, {
        question: d.question,
        volume24h: d.volume24h,
      });
  }
} catch {
  // display-only enrichment; an empty map just means nameless lines
}
```

And extend the existing `snapshot` closure's return:

```typescript
const meta = marketMeta.get(marketId);
const q =
  typeof snap.question === "string" && snap.question.length > 0
    ? snap.question
    : meta?.question;
return {
  bid: snap.yes_price,
  ask: snap.no_price,
  side,
  ...(q ? { question: q } : {}),
  ...(meta && Number.isFinite(meta.volume24h)
    ? { volume24h: meta.volume24h }
    : {}),
};
```

(`snap` here is the `MarketSnapshot` from `venueAdapter.getOrderBook`, whose `question` is required by schema but treated as best-effort at the boundary.)

- [ ] **Step 4: Write the threading test**

Create `tests/pm/contracts/market-input-threading.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectLiveInputs } from "@polyroot/venue";

describe("loop inputs carry question + volume24h when present", () => {
  it("copies question/volume from snapshot; omits them when absent", async () => {
    const inputs = await collectLiveInputs({
      universe: () => ["mkt-with-meta", "mkt-bare"],
      snapshot: async (id: string) => {
        if (id === "mkt-with-meta")
          return {
            bid: 0.52,
            ask: 0.55,
            question: "Will Trump leave office in 2026?",
            volume24h: 1200000,
          };
        return { bid: 0.45, ask: 0.55 };
      },
    });
    assert.equal(inputs.length, 2);
    const rich = inputs.find((i) => i.market_id === "mkt-with-meta");
    assert.equal(rich?.question, "Will Trump leave office in 2026?");
    assert.equal(rich?.volume24h, 1200000);
    const bare = inputs.find((i) => i.market_id === "mkt-bare");
    assert.ok(!("question" in (bare as object)));
    assert.ok(!("volume24h" in (bare as object)));
  });
});
```

- [ ] **Step 5: Rebuild venue, run the test**

```bash
npx turbo run build --filter=@polyroot/venue
node --test --import tsx tests/pm/contracts/market-input-threading.test.ts
```

Expected: PASS (3 assertions).

- [ ] **Step 6: Commit**

```bash
git add src/pm/venue/src/market-universe.ts src/pm/runtime/src/main.ts tests/pm/contracts/market-input-threading.test.ts
git commit -m "feat(stream): thread market question + volume24h into loop inputs"
```

---

### Task 2: English builders, digest, dedupe, confidence

**Files:**
- Modify: `src/pm/observability/src/telegram-stream.ts`
- Test: `tests/pm/contracts/telegram-stream-v2.test.ts` (create)

**Interfaces:**
- Consumes: nothing new (pure functions).
- Produces (exact exported names later tasks use):
  - `type AgentStreamEventType` gains `"PASS_DIGEST"` and `"MARKET_REPORT"`; `EVENT_STYLE` gains `PASS_DIGEST: { icon: "🌐", stage: "PASS" }` and `MARKET_REPORT: { icon: "🧠", stage: "MARKET" }`. The generic `formatMessage(event)` renderer is untouched — builders below produce the `message` body it wraps.
  - `FIELD_LABELS` values switched to English (`Keputusan`→`Decision`, `Alasan`→`Reason`, `Harga Fill`→`Fill price`, `Ukuran Fill`→`Filled size`, `Status Fill`→`Fill status`, `Dari`→`From`, `Ke`→`To`, `Konteks`→`Context`; `ya`/`tidak` in `renderValue` → `yes`/`no`).
  - `confidenceOf(p: number): number` → `2 * Math.abs(p - 0.5)`.
  - `formatPassDigest(input: { mode: string; clock: string; scanned: number; evaluating: Array<{ id: string; question: string }>; deferredCount: number }): string`.
  - `formatMarketReport(input: { question: string; bid: number; ask: number; spread: number; volume24h?: number; pYes: number | null; confidence: number; rationale: string; factors: string[]; decision: "TRADE" | "NO_TRADE"; reason: string; edgePct: number; floorPct: number; sizeShares: number; notionalUsd: number; bankrollUsd: number; exposureUsd: number }): string`.
  - `class ReportDedupe { shouldSend(marketId: string, reasonKey: string): boolean }` — returns true on first sight or changed key, false on repeat; process-local `Map`, no persistence.

- [ ] **Step 1: Write the failing tests**

Create `tests/pm/contracts/telegram-stream-v2.test.ts` (imports from `@polyroot/observability` — rebuilt dist required before running):

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  confidenceOf,
  formatPassDigest,
  formatMarketReport,
  ReportDedupe,
} from "@polyroot/observability";

describe("stream v2 builders", () => {
  it("confidenceOf derives certainty 2*|p-0.5|", () => {
    assert.equal(confidenceOf(0.67), 0.34);
    assert.equal(confidenceOf(0.5), 0);
    assert.equal(confidenceOf(1), 1);
  });

  it("formatPassDigest names evaluated markets with real counts", () => {
    const text = formatPassDigest({
      mode: "SHADOW",
      clock: "10:58:04",
      scanned: 12,
      evaluating: [
        { id: "a", question: "Will Trump leave office in 2026?" },
        { id: "b", question: "Fed cuts rates in September?" },
      ],
      deferredCount: 10,
    });
    assert.ok(text.includes("Scanned 12"));
    assert.ok(text.includes("Will Trump leave office in 2026?"));
    assert.ok(text.includes("10 more deferred"));
    assert.ok(!text.includes("mock"));
  });

  it("formatMarketReport tells decision, why, and money", () => {
    const text = formatMarketReport({
      question: "Will Trump leave office in 2026?",
      bid: 0.52,
      ask: 0.55,
      spread: 0.03,
      pYes: 0.67,
      confidence: 0.34,
      rationale: "CPI down 0.2%.",
      factors: ["inflation data"],
      decision: "NO_TRADE",
      reason: "edge +1.0% below +3.0% floor",
      edgePct: 1.0,
      floorPct: 3.0,
      sizeShares: 0,
      notionalUsd: 0,
      bankrollUsd: 100,
      exposureUsd: 0,
    });
    assert.ok(text.includes("NO_TRADE"));
    assert.ok(text.includes("Why not:"));
    assert.ok(text.includes("At stake: $0"));
    assert.ok(text.includes("52.0"));
  });

  it("ReportDedupe sends once per reason, resends on change", () => {
    const d = new ReportDedupe();
    assert.equal(d.shouldSend("m1", "NO_TRADE:spread"), true);
    assert.equal(d.shouldSend("m1", "NO_TRADE:spread"), false);
    assert.equal(d.shouldSend("m1", "NO_TRADE:edge"), true);
    assert.equal(d.shouldSend("m1", "TRADE:submitted"), true);
  });
});
```

(Use plain-ASCII fake market names and no secret-shaped strings anywhere.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx turbo run build --filter=@polyroot/observability
node --test --import tsx tests/pm/contracts/telegram-stream-v2.test.ts
```

Expected: FAIL with "does not provide an export named 'confidenceOf'" (or similar).

- [ ] **Step 3: Implement builders + dedupe in `telegram-stream.ts`**

Additive only: keep `TelegramStreamEmitter`, `formatMessage`, `redactSecrets`, rate cap, `getTelegramEmitter`, `createNullStreamEmitter` untouched. Add:

```typescript
export function confidenceOf(p: number): number {
  // Derived certainty, NOT a model self-report (profit-contract rule).
  return Math.min(Math.max(2 * Math.abs(p - 0.5), 0), 1);
}

export function formatPassDigest(input: {
  mode: string;
  clock: string;
  scanned: number;
  evaluating: Array<{ id: string; question: string }>;
  deferredCount: number;
}): string {
  const lines = [
    `🌐 PASS [${input.mode}] ${input.clock}`,
    `Scanned ${input.scanned} → evaluating ${input.evaluating.length}, deferred ${input.deferredCount}`,
  ];
  for (const m of input.evaluating.slice(0, 5)) {
    const name =
      m.question.length > 0 ? m.question : m.id;
    lines.push(`• "${name}" — evaluating`);
  }
  if (input.deferredCount > 0) {
    lines.push(
      `• ${input.deferredCount} more deferred (ranked below this pass's top-K cut)`,
    );
  }
  return lines.join("\n");
}

export function formatMarketReport(input: {
  question: string;
  bid: number;
  ask: number;
  spread: number;
  volume24h?: number;
  pYes: number | null;
  confidence: number;
  rationale: string;
  factors: string[];
  decision: "TRADE" | "NO_TRADE";
  reason: string;
  edgePct: number;
  floorPct: number;
  sizeShares: number;
  notionalUsd: number;
  bankrollUsd: number;
  exposureUsd: number;
}): string {
  const head = input.question.length > 0 ? input.question : "Untitled market";
  const lines = [
    `🧠 "${head}"`,
    `Book: YES ${(input.bid * 100).toFixed(1)}¢ / NO ${((1 - input.ask) * 100).toFixed(1)}¢ · spread ${(input.spread * 100).toFixed(1)}¢` +
      (input.volume24h !== undefined
        ? ` · 24h vol $${Math.round(input.volume24h).toLocaleString("en-US")}`
        : ""),
  ];
  if (input.pYes === null) {
    lines.push(`AI: abstained — ${input.reason}`);
  } else {
    lines.push(
      `AI: p(YES) ${(input.pYes * 100).toFixed(1)}% (confidence ${(input.confidence * 100).toFixed(0)}%)`,
      `Reasoning: "${input.rationale.length > 0 ? input.rationale : "no rationale recorded"}"`,
    );
    if (input.factors.length > 0) {
      lines.push(`Factors: ${input.factors.slice(0, 3).map((f) => `• ${f}`).join(" ")}`);
    }
  }
  lines.push("---");
  if (input.decision === "TRADE") {
    lines.push(
      `🚀 TRADE: ${input.sizeShares} shares ≈ $${input.notionalUsd.toFixed(2)}`,
      `"${head}"`,
      `Edge +${input.edgePct.toFixed(1)}% > floor +${input.floorPct.toFixed(1)}%`,
      `Bankroll $${input.bankrollUsd.toFixed(2)} · exposure $${input.exposureUsd.toFixed(2)}`,
    );
  } else {
    lines.push(
      `🛡️ DECISION: ⏭️ NO_TRADE`,
      `Why not: ${input.reason}`,
      `At stake: $${input.notionalUsd.toFixed(2)} (held)`,
    );
  }
  return lines.join("\n");
}

export class ReportDedupe {
  private readonly lastReason = new Map<string, string>();
  shouldSend(marketId: string, reasonKey: string): boolean {
    const prev = this.lastReason.get(marketId);
    if (prev === reasonKey) return false;
    this.lastReason.set(marketId, reasonKey);
    return true;
  }
}
```

Keep `TelegramStreamEmitter`, `formatMessage`, `redactSecrets`, the rate cap, `getTelegramEmitter`, and `createNullStreamEmitter` untouched. Do NOT add per-type formatter functions — the two builders above produce `message` bodies; the existing generic renderer wraps them. Before deleting anything, grep for other importers of any name you plan to remove (`rg -n "NAME" src/ tests/`); only delete what Task 3 stops referencing.

- [ ] **Step 4: Rebuild + run tests**

```bash
npx turbo run build --filter=@polyroot/observability
node --test --import tsx tests/pm/contracts/telegram-stream-v2.test.ts
```

Expected: PASS (4 tests). Floating-point note: `confidenceOf(0.67)` is `0.339999…` in binary — assert with tolerance instead of exact equality: `assert.ok(Math.abs(confidenceOf(0.67) - 0.34) < 1e-9)`. (Write the test that way in Step 1.)

- [ ] **Step 5: Commit**

```bash
git add src/pm/observability/src/telegram-stream.ts tests/pm/contracts/telegram-stream-v2.test.ts
git commit -m "feat(stream): English digest/report builders, dedupe, confidence"
```

---

### Task 3: Rewire fan-out to the new builders

**Files:**
- Modify: `src/pm/runtime/src/main.ts` (fan-out block + `onUniversePass` dep, ~lines 451-640)
- Modify: `src/pm/runtime/src/g4-core.ts` (2 `onUniversePass` type spots + 1 mapping) and `src/pm/runtime/src/g4-pipeline.ts` (1 call site) — extend summary with `evaluated: Array<{ id: string; question: string }>`

**Interfaces:**
- Consumes: `formatPassDigest`, `formatMarketReport`, `ReportDedupe` from `@polyroot/observability`; loop inputs now carry `question?`/`volume24h?` (Task 1); `getReasoning(marketId)` → `{ rationale: string | null; factors: string[]; model: string } | undefined`; `getFunds()` → `{ bankrollUsd: number | null; lockedUsd: number | undefined; sessionPnlUsd: number }`.
- Produces: per-pass `PASS_DIGEST`; per-market `MARKET_REPORT` (deduped) + unchanged always-send `ORDER_FILL`/`ERROR`/mode lines, all English.

- [ ] **Step 1: Extend the universe summary with evaluated names**

In `g4-core.ts`, change both `onUniversePass` signatures to:

```typescript
onUniversePass?:
  | ((summary: {
      scanned: number;
      selected: number;
      deferred: number;
      mode: string;
      evaluated: Array<{ id: string; question: string }>;
    }) => void)
  | undefined;
```

In `g4-pipeline.ts`, update the existing `onUniversePass` call (after `selectMarketsForPass`, where `byId` maps ids to inputs) to include:

```typescript
evaluated: selected
  .map((id) => {
    const hit = byId.get(id);
    const q = hit?.question;
    return {
      id,
      question:
        typeof q === "string" && q.length > 0 ? q : id,
    };
  })
  .slice(0, 5),
```

(Falls back to the id when nameless — the builder then shows the id instead of fabricating a name.)

- [ ] **Step 2: Rewire `bootstrapAgent` fan-out in `main.ts`**

Replace the per-step gimmick emission with the digest + report flow. Concretely, in the `observability` object passed to `createG4Pipeline`:

- Delete the `emitStepStart` arm that sends the old placeholder line.
- In `onUniversePass`, build the body with `formatPassDigest({ mode: s.mode, clock: new Date().toISOString().slice(11, 19), scanned: s.scanned, evaluating: s.evaluated, deferredCount: s.deferred })`, then `emitStream("PASS_DIGEST", text)`. (`s.evaluated` arrives as `{id, question}[]` from the extended hook — Task 3 Step 1.)
- In `emitStepComplete`, build ONE `MARKET_REPORT` body via `formatMarketReport` using: question from `input.question` (fallback: market id), book/spread/volume from `input`, `pYes: result.p ?? null`, `confidence: result.p === undefined || result.p === null ? 0 : confidenceOf(result.p)`, rationale/factors from `getReasoning()` (`rationale ?? ""`, `factors ?? []`), `decision: result.decision === "BUY" || result.decision === "SELL" ? "TRADE" : "NO_TRADE"`, `reason: result.reason ?? "no reason recorded"`, `edgePct: (result.edge ?? 0) * 100`, `floorPct: 3.0` (same `minEdgeAfterCost: 0.03` the pipeline config sets two screens above — one source of truth, read don't duplicate), size/bankroll/exposure from `result` + `getFunds()`. Send it only when `reportDedupe.shouldSend(input.market_id, \`${result.decision}:${result.reason ?? "noreason"}\`)` is true. Keep the existing `isExecuted` (`ORDER_FILL`) branch exactly as-is — fills always send, never deduped.
- Instantiate `const reportDedupe = new ReportDedupe();` next to `lastReasoning`. Replace the remaining Indonesian strings with these exact English ones: `RISK_GATE` → `` `Risk gate: [${gate}] (mode ${gateMode}, venue ${venue})` ``; `ERROR` → `` `Agent loop error: ${error.message}` `` (metadata `{ context: String(context) }` unchanged); mode transition → `` `Mode: ${from} → ${to} — ${reason}` ``.
- Keep `emitMetrics`, step-persistence fan-out, `safeObserve` guards, and the `[telegram] agent stream ON` log exactly as-is.

- [ ] **Step 3: Verify build + existing suites**

```bash
npx turbo run build --filter=@polyroot/runtime
node --test --import tsx tests/pm/contracts/telegram-stream-v2.test.ts
node --test --import tsx tests/pm/contracts/telegram.test.ts
```

Expected: all PASS (wiring has no new dedicated test — builders/dedupe carry the coverage from Task 2; wiring is verified by build + suite + the `--once` silence check in Task 4).

- [ ] **Step 4: Commit**

```bash
git add src/pm/runtime/src/main.ts src/pm/runtime/src/g4-core.ts src/pm/runtime/src/g4-pipeline.ts
git commit -m "feat(stream): digest with names, deduped market reports, English strings"
```

---

### Task 4: Full gate, changelog, deploy, verify on the phone

**Files:**
- Modify: `CHANGELOG.md` (Unreleased entry, exact text below)
- Deploy target: `/root/.polyroot` on the VPS (clean tree at `main`), service `polyroot.service`

- [ ] **Step 1: Full gate**

```bash
npm run lint
npm run build
npm test
```

Expected: lint 13/13, build 13/13, 882 contract + 12 property green. Known flake: `telegram setup wizard` piped-stdin test occasionally fails under full-suite load — on failure, re-run it alone (`node --test --import tsx tests/pm/contracts/cli-dispatch.test.ts`, expect 10/10) to confirm flake vs regression.

- [ ] **Step 2: CHANGELOG + commit + push**

Append under `## [Unreleased]` (create the section if absent):

```markdown
### ✨ Changed
- **Telegram agent stream v2 (PM-OBS-01 refinement)** — per-pass digest with real market names and scanned/evaluated/deferred counts; per-market reports (question, book, AI probability + verbatim reasoning, decision + reason, money at stake) in full English; NO_TRADE reported once per reason; `--once` runs stay silent
```

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for Telegram agent stream v2"
git push origin main
```

- [ ] **Step 3: Deploy on the VPS**

```bash
git pull
npm run build
sudo systemctl restart polyroot
sleep 20
sudo journalctl -u polyroot --since "2 min ago" --no-pager | grep -E "starting in|agent stream|Telegram live|G4 Pipeline"
```

Expected: `starting in SHADOW mode`, `[telegram] agent stream ON`, `📲 Telegram live as @Polyrootbot (owners: 1)`, `G4 Pipeline running in SHADOW mode...`.

- [ ] **Step 4: `--once` silence check**

```bash
timeout 40 node --import tsx src/pm/runtime/src/cli.ts run --once 2>&1 | grep -cE "agent stream ON|Telegram live"
```

Expected: `0`.

- [ ] **Step 5: Phone verification**

Within ~30 seconds of restart, the owner DM must receive a `🌐 PASS [SHADOW]` digest naming real markets (never `mock_market_1`, never Indonesian strings), followed by per-market reports. Confirm on the phone; no further messages for repeated identical NO_TRADE reasons.
