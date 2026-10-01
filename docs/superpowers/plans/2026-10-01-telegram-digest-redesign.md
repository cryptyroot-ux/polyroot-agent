# Telegram Digest Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign Telegram reporting to reduce message volume from 234/hour to ~4/hour (batched 15-minute digests + instant trade alerts), using clean, human-friendly formatting without technical jargon or raw market IDs.

**Architecture:** 
- Add a digest scheduler / throttle to `TelegramStreamEmitter` or `main.ts` so per-market reports are batched into a single 15-minute summary (`PASS_DIGEST`).
- Instant alerts (`TRADE`, `RISK_GATE`, `ERROR`) continue to send immediately without batching.
- Refactor formatters to show clean market names, side, AI prediction, edge verdict, and portfolio summary.

**Tech Stack:** TypeScript, Node.js Test Runner, Telegram Bot API

## Global Constraints
- Do not modify core trading logic, risk gates, or forecast provider.
- Keep all existing test coverage (891+ tests) passing.
- No raw market IDs or technical jargon in outbound messages.
- Portfolio summary displayed only in batched digests, not every report.

---

## Task 1: Formatters for Batched Digest and Trade Alerts

**Files:**
- Modify: `src/pm/observability/src/telegram-stream.ts`
- Test: `tests/pm/contracts/telegram-stream-v2.test.ts`

**Interfaces:**
- Consumes: Existing formatting primitives
- Produces: `formatBatchedDigest`, `formatTradeAlert`

- [ ] **Step 1: Write failing tests for new batched formatters**

```typescript
// Add to tests/pm/contracts/telegram-stream-v2.test.ts
it("formatBatchedDigest produces clean summary with portfolio", () => {
  const text = formatBatchedDigest({
    mode: "SHADOW",
    clock: "14:30:00",
    scanned: 12,
    gatesPassed: 2,
    trades: 0,
    evaluated: [
      { question: "Bitcoin >$100k 2026", side: "YES", edgePct: 1.2, floorPct: 1.0 },
      { question: "Fed cut Sept", side: "NO", reason: "spread 1¢, too tight" }
    ],
    bankrollUsd: 100,
    exposureUsd: 0,
    pnlUsd: 0,
  });
  assert.ok(text.includes("14:30:00 · SHADOW"));
  assert.ok(text.includes("Scanned 12 | gates passed 2 | trades 0"));
  assert.ok(text.includes("Bitcoin >$100k 2026 [YES]"));
  assert.ok(text.includes("Portfolio: $100.00"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx tests/pm/contracts/telegram-stream-v2.test.ts`
Expected: FAIL with "formatBatchedDigest is not a function"

- [ ] **Step 3: Implement `formatBatchedDigest` in `src/pm/observability/src/telegram-stream.ts`**

```typescript
export function formatBatchedDigest(input: {
  mode: string;
  clock: string;
  scanned: number;
  gatesPassed: number;
  trades: number;
  evaluated: Array<{
    question: string;
    side?: string;
    edgePct?: number;
    floorPct?: number;
    reason?: string;
  }>;
  bankrollUsd: number | null;
  exposureUsd: number | null;
  pnlUsd: number | null;
}): string {
  const money = (v: number | null): string => (v === null ? "—" : `$${v.toFixed(2)}`);
  const lines = [
    `${input.clock} · ${input.mode}`,
    `Scanned ${input.scanned} | gates passed ${input.gatesPassed} | trades ${input.trades}`,
    "",
    "Markets evaluated:",
  ];
  for (const m of input.evaluated.slice(0, 5)) {
    const tag = m.side ? ` [${m.side}]` : "";
    const detail = m.edgePct !== undefined && m.floorPct !== undefined
      ? ` — edge +${m.edgePct.toFixed(1)}% (floor +${m.floorPct.toFixed(1)}%)`
      : m.reason ? ` — ${m.reason}` : "";
    lines.push(`• ${m.question}${tag}${detail}`);
  }
  if (input.evaluated.length > 5) {
    lines.push(`… and ${input.evaluated.length - 5} more`);
  }
  lines.push(
    "",
    `Portfolio: ${money(input.bankrollUsd)} | PnL ${money(input.pnlUsd)} | Exposure ${money(input.exposureUsd)}`,
  );
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx tests/pm/contracts/telegram-stream-v2.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pm/observability/src/telegram-stream.ts tests/pm/contracts/telegram-stream-v2.test.ts
git commit -m "feat(observability): add formatBatchedDigest for clean Telegram summaries"
```

---

## Task 2: Runtime Digest Scheduler & Throttling

**Files:**
- Modify: `src/pm/runtime/src/main.ts`
- Test: `tests/pm/contracts/telegram-stream-v2.test.ts`

**Interfaces:**
- Consumes: `formatBatchedDigest`, `getTelegramEmitter`
- Produces: Throttled 15-minute digests in loop

- [ ] **Step 1: Update `main.ts` to accumulate pass results and emit batched digest every 15 minutes**

```typescript
// In main.ts, add batch accumulation state
let lastDigestTime = 0;
const digestIntervalMs = 15 * 60 * 1000; // 15 minutes
let currentPassEvaluated: Array<{ question: string; side?: string; edgePct?: number; floorPct?: number; reason?: string }> = [];
let currentPassScanned = 0;
let currentPassGatesPassed = 0;
let currentPassTrades = 0;

// In onUniversePass:
onUniversePass: (s) => {
  currentPassScanned = s.scanned;
  // Accumulate evaluated
  currentPassEvaluated = s.evaluated.map(e => ({
    question: e.question,
    ...(e.side ? { side: e.side } : {}),
  }));
},

// In emitStepComplete:
// When a step completes, record whether it passed gates / traded
```

- [ ] **Step 2: Add timer check to emit digest**

```typescript
const now = Date.now();
if (now - lastDigestTime >= digestIntervalMs && streamOn) {
  lastDigestTime = now;
  // get bankroll / pnl
  // emit PASS_DIGEST event using formatBatchedDigest
  currentPassEvaluated = [];
  currentPassScanned = 0;
  currentPassGatesPassed = 0;
  currentPassTrades = 0;
}
```

- [ ] **Step 3: Run full contract tests to ensure no regressions**

Run: `npm run test:contract`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/pm/runtime/src/main.ts
git commit -m "feat(runtime): throttle telegram digests to 15-minute batched intervals"
```

---

## Task 3: Build, Lint, and VPS Deployment

**Files:**
- Modify: `CHANGELOG.md`
- Deploy to VPS

- [ ] **Step 1: Run typecheck, lint, and build**

Run: `npm run ci`
Expected: 0 errors, 0 warnings

- [ ] **Step 2: Update CHANGELOG.md**

Add unreleased entry for Telegram batched digest redesign.

- [ ] **Step 3: Push to GitHub and deploy to VPS**

Run: `git push origin main` and SSH to VPS to pull, build, and restart service.

- [ ] **Step 4: Verify live service status**

Run: `sudo systemctl status polyroot`
Expected: active (running)
