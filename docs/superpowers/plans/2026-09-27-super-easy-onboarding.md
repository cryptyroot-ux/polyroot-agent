# Super-Easy Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `polyroot onboard` into a 3-step awam-friendly wizard with Hermes-style generic providers, mandatory API key + wallet, PAPER-by-default, and automatic migrate + doctor at the end.

**Architecture:** Narrow refactor confined to `runOnboarding`, `writeEnv`, and `runOnboardingFlow` in `src/pm/runtime/src/cli.ts`, plus one new contract test file. Live guards, `runSetupFlow`, signer, venue, and executor packages are not touched.

**Tech Stack:** TypeScript (Node ≥24), `node:test` + `tsx` (existing contract-test harness), `node:child_process` spawn pattern from `tests/pm/contracts/setup-stdin.test.ts`, Web `fetch` with `AbortController` for the optional provider ping.

## Global Constraints

- No maintainer-owned gateway URL, key, or endpoint as a default, placeholder, or example anywhere in the onboarding path (`cli.ts` onboarding functions, `writeEnv` output). Public URLs (`https://api.openai.com/v1`, `http://localhost:11434/v1`, `https://polygon-rpc.com`) are allowed.
- Secrets live only in `~/.polyroot/.env` (mode 0600) and `~/.polyroot/keystore.json` (mode 0600). Never print, log, or transmit them.
- No phone-home: the only network calls are the optional user-key `GET /models` ping and user-requested market fetch.
- Wizard copy is plain English, zero jargon on screen (no keystore, hex, seal, CLOB, caps, latch).
- Wallet + API key are mandatory: onboarding without a sealed keystore cannot complete.
- Live guards are zero-touch: `assertRuntimeEnv`, `REFUSE_LIVE_WITH_STUBS`, WAL-03, loss-cap latch, `runLivePreflight` behave exactly as before.

---

## File Structure

- Modify: `src/pm/runtime/src/cli.ts:397-444` — provider block of `runOnboarding` becomes Hermes-style generic (OpenAI / own gateway with empty base URL / Ollama).
- Modify: `src/pm/runtime/src/cli.ts:446-492` — wallet block keeps `sealPrivateKey` mechanism, plain-words copy only.
- Modify: `src/pm/runtime/src/cli.ts:494-559` — mode block keeps PAPER default + typed-LIVE gate, plain-words copy only.
- Modify: `src/pm/runtime/src/cli.ts:561-598` — `writeEnv` keeps fields, drops any owner-gateway default.
- Modify: `src/pm/runtime/src/cli.ts:600-621` — `runOnboardingFlow` appends best-effort auto-migrate + auto-doctor.
- Create: `tests/pm/contracts/onboarding-super-easy.test.ts` — grep test + spawned onboard E2E tests.
- Modify: `.env.example:100-107` — provider comments must not reference any maintainer gateway (verify, edit only if present).

---

### Task 1: Hermes-style provider step + owner-URL grep test

**Files:**
- Modify: `src/pm/runtime/src/cli.ts:397-444`
- Test: `tests/pm/contracts/onboarding-super-easy.test.ts` (new)

**Interfaces:**
- Consumes: existing `askChoice(message, options, defaultIdx)`, `askText(message, {defaultValue})`, `askRequiredSecret(message)` from same file; Web `fetch` + `AbortController` (Node 24 global).
- Produces: provider variables `{ providerLabel, model, baseUrl, apiKey }` consumed by Task 3's `writeEnv` mapping (`OpenAI → openai`, anything else → `custom`); file-local helper `pingModelsEndpoint(baseUrl, apiKey): Promise<boolean>`.

- [ ] **Step 1: Write the failing grep test**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLI_SRC = join(process.cwd(), "src", "pm", "runtime", "src", "cli.ts");

describe("onboarding contains zero maintainer-owned provider defaults", () => {
  it("never ships files.pango.fun in the onboarding path", () => {
    const src = readFileSync(CLI_SRC, "utf8");
    assert.ok(
      !src.includes("files.pango.fun"),
      "onboarding must not default to a maintainer-owned gateway",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx tests/pm/contracts/onboarding-super-easy.test.ts`
Expected: FAIL on the `files.pango.fun` assertion (current `cli.ts:424` contains it as the 9Router default).

- [ ] **Step 3: Rewrite the provider block (Hermes-style generic)**

Replace `src/pm/runtime/src/cli.ts:397-444` with:

```typescript
  // 1. AI Provider & Model — the brain that reads markets.
  // Hermes-style: generic OpenAI-compatible provider. The user always
  // supplies their own base URL + key; this repo ships no gateway default.
  console.log("📡 Step 1/3: AI brain (reads the markets)");
  const provider = await askChoice(
    "Choose AI provider (Enter = default):",
    [
      "OpenAI (GPT-4o, GPT-4o-mini)",
      "My own OpenAI-compatible gateway (my 9Router/NewAPI/OpenRouter account, company gateway, ...)",
      "Ollama (runs on this machine)",
    ],
    0,
  );

  let model = "";
  let baseUrl = "";
  let apiKey = "";

  if (provider.startsWith("OpenAI")) {
    model = await askChoice(
      "Select model:",
      ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo"],
      0,
    );
    apiKey = await askRequiredSecret("Paste your OpenAI API key");
    baseUrl = "https://api.openai.com/v1";
  } else if (provider.startsWith("Ollama")) {
    model = await askText("Model name", { defaultValue: "llama3.1" });
    baseUrl = await askText("Base URL", {
      defaultValue: "http://localhost:11434/v1",
    });
    apiKey = "ollama"; // dummy
  } else {
    baseUrl = await askText("Your gateway base URL (example: https://your-gateway.example/v1)");
    if (!/^https?:\/\/.+/.test(baseUrl)) {
      console.log("That does not look like a web address — it starts with http:// or https://.");
      baseUrl = await askText("Your gateway base URL (example: https://your-gateway.example/v1)");
      if (!/^https?:\/\/.+/.test(baseUrl)) {
        throw new Error("A valid gateway base URL is required");
      }
    }
    model = await askText("Model name (example: gpt-4o-mini)");
    apiKey = await askRequiredSecret("Paste your gateway API key");
  }

  if (!model.trim()) {
    throw new Error("Model name is required");
  }
  if (!apiKey.trim()) {
    throw new Error("API key is required (Ollama on this machine uses any placeholder)");
  }

  if (!provider.startsWith("Ollama")) {
    const reachable = await pingModelsEndpoint(baseUrl, apiKey);
    if (!reachable) {
      console.log(
        "⚠️  Could not reach that address with your key — corporate gateways sometimes block the check while chat still works.",
      );
      const goOn = await askText("Continue anyway? (y/n)", { defaultValue: "y" });
      if (!goOn.trim().toLowerCase().startsWith("y")) {
        throw new Error("Setup stopped — double-check the base URL and key, then run `polyroot onboard` again");
      }
    }
  }
```

Add beside the other `ask*` helpers (after `askRequiredSecret` at `cli.ts:359-366`, before `askChoice` at `cli.ts:368`):

```typescript
/** Best-effort reachability ping for a user's own gateway. Warning-only: never blocks setup. */
async function pingModelsEndpoint(baseUrl: string, apiKey: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx tests/pm/contracts/onboarding-super-easy.test.ts`
Expected: PASS (no `files.pango.fun` remains in `cli.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/pm/runtime/src/cli.ts tests/pm/contracts/onboarding-super-easy.test.ts
git commit -m "feat(onboard): Hermes-style generic AI provider, no maintainer gateway default"
```

---

### Task 2: Wallet step in plain words (mechanism unchanged)

**Files:**
- Modify: `src/pm/runtime/src/cli.ts:446-492` (copy + inline validation messages only)
- Test: append to `tests/pm/contracts/onboarding-super-easy.test.ts`

**Interfaces:**
- Consumes: existing `sealPrivateKey`, `deriveAddressFromPrivateKey`, `ensurePolyrootHome`, `KEYSTORE_PATH` (0600 write, unchanged); Task 1's provider answers precede it in the spawned flow.
- Produces: sealed keystore at `~/.polyroot/keystore.json` + `WALLET_ADDRESS` for Task 3's `writeEnv`; no signature changes.

- [ ] **Step 1: Write the failing E2E test (spawned onboard, scripted stdin)**

Append to `tests/pm/contracts/onboarding-super-easy.test.ts`:

```typescript
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

const CLI = join(process.cwd(), "src", "pm", "runtime", "src", "cli.ts");

function runOnboardLikeHuman(home: string, lines: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, "onboard"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    child.stdout.resume();
    child.stderr.resume();
    let i = 0;
    const timer = setInterval(() => {
      if (child.exitCode !== null || child.killed) { clearInterval(timer); return; }
      if (i >= lines.length) { clearInterval(timer); return; }
      try { child.stdin.write((lines[i++] as string) + "\n"); } catch { clearInterval(timer); }
    }, 400);
    const killer = setTimeout(() => {
      clearInterval(timer);
      child.kill("SIGKILL");
      resolve({ code: 99, out });
    }, 55_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      clearInterval(timer);
      resolve({ code: code ?? 1, out });
    });
  });
}

describe("super-easy onboarding E2E (create wallet path)", () => {
  it("completes with OpenAI key + new wallet + PAPER default", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-onboard-"));
    const { code, out } = await runOnboardLikeHuman(home, [
      "",               // provider: OpenAI (default)
      "",               // model: gpt-4o-mini (default)
      "sk-test-key-1",  // API key
      "",               // wallet: create new (default)
      "test-pass-123",  // vault password
      "test-pass-123",  // repeat vault password
      "",               // mode: PAPER (default)
    ]);
    assert.equal(code, 0);
    const envPath = join(home, ".polyroot", ".env");
    assert.equal(existsSync(envPath), true);
    const env = readFileSync(envPath, "utf8");
    assert.ok(env.includes("RUNTIME_MODE=PAPER"));
    assert.ok(env.includes("OPENAI_API_KEY=sk-test-key-1"));
    assert.ok(/WALLET_ADDRESS=0x[0-9a-fA-F]{40}/.test(env));
    const ksPath = join(home, ".polyroot", "keystore.json");
    assert.equal(existsSync(ksPath), true);
    assert.equal((statSync(ksPath).mode & 0o777), 0o600);
    assert.ok(!out.includes("files.pango.fun"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx tests/pm/contracts/onboarding-super-easy.test.ts`
Expected: FAIL — the E2E block is new and the current provider block still offers the old 9Router second choice, so scripted keystrokes misalign and the run cannot complete with exit 0.

- [ ] **Step 3: Rewrite wallet copy (no mechanism change)**

In `src/pm/runtime/src/cli.ts:446-492`, keep every call and regex identical; replace only user-facing strings:
- Header stays `🔐 Step 2/3: Wallet (where your keys live)`; subline stays `Keys stay locked in a vault on this computer, never sent anywhere.`
- Choice list becomes `["Create new wallet for me (recommended)", "I already have a wallet (import secret key)"]`, default index 0.
- Create path prompts: `"Create a vault password"` + `"Repeat the vault password"`; mismatch line: `"Passwords do not match — try again."`; success lines keep structure: `New wallet created!` + `Address: ...` + `(Write this address down — it is shown only once)`.
- Import path prompts: `"Paste your wallet secret key (starts with 0x)"`; bad format line: `"That does not look like a wallet secret key — it is 64 letters/numbers, starting with 0x."`; passphrase prompt: `"Create a vault password"`.
- Keystore-saved line keeps `KEYSTORE_PATH` and `(encrypted, 600 perms)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx tests/pm/contracts/onboarding-super-easy.test.ts`
Expected: PASS — E2E completes exit 0, `.env` has PAPER + key + derived address, keystore exists at 0600.

- [ ] **Step 5: Commit**

```bash
git add src/pm/runtime/src/cli.ts tests/pm/contracts/onboarding-super-easy.test.ts
git commit -m "feat(onboard): plain-words wallet step, same sealed vault mechanism"
```

---

### Task 3: PAPER-default finish with auto-migrate + auto-doctor

**Files:**
- Modify: `src/pm/runtime/src/cli.ts:494-559` (mode copy), `src/pm/runtime/src/cli.ts:561-598` (`writeEnv`), `src/pm/runtime/src/cli.ts:600-621` (`runOnboardingFlow`)
- Test: append to `tests/pm/contracts/onboarding-super-easy.test.ts`

**Interfaces:**
- Consumes: existing `AUTONOMY_BOUNDS`, `resolveLossCapPusd`, current `writeEnv` lines; existing `runDoctor()` (same file, non-live); migrate via spawned `node --import tsx scripts/migrate.ts latest` (`scripts/migrate.ts` has no exports, child-process only).
- Produces: `~/.polyroot/.env` with `RUNTIME_MODE`, caps, auto-discovery defaults; console output ending in `formatNextSteps(PAPER)`; exit 0 even when DB is unreachable.

- [ ] **Step 1: Write the failing test (no-DB resilience)**

Append to `tests/pm/contracts/onboarding-super-easy.test.ts`:

```typescript
describe("onboarding finish is resilient without a database", () => {
  it("still exits 0 and tells the user the one next command", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-onboard-"));
    const { code, out } = await runOnboardLikeHuman(home, [
      "",
      "",
      "sk-test-key-2",
      "",
      "test-pass-123",
      "test-pass-123",
      "",
    ]);
    assert.equal(code, 0);
    assert.ok(
      out.includes("migrate:latest") || out.includes("doctor"),
      "must point the user at the one next command when infra is missing",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx tests/pm/contracts/onboarding-super-easy.test.ts`
Expected: FAIL — current `runOnboardingFlow` never runs migrate/doctor, so the hint assertion fails.

- [ ] **Step 3: Implement mode copy + writeEnv + finish**

Mode block (`cli.ts:494-545`): keep the two choices and the typed-`LIVE` gate byte-for-byte in logic; change only the PAPER line to `"PAPER — Safe practice with play money (recommended, no real money)"` and the intro subline to `"PAPER = practice with play money (100% safe). LIVE = real money."`.

`writeEnv` (`cli.ts:561-598`): keep all current lines; change the provider mapping to match Task 1 labels:

```typescript
`POLYROOT_FORECAST_PROVIDER=${config.provider.startsWith("OpenAI") ? "openai" : "custom"}`,
```

`runOnboardingFlow` (`cli.ts:600-621`): after `writeEnv(config)` and before the banner, insert best-effort infra (never fatal):

```typescript
    try {
      const { execSync } = await import("node:child_process");
      execSync("node --import tsx scripts/migrate.ts latest", {
        cwd: process.cwd(),
        stdio: "inherit",
      });
    } catch {
      console.log(
        "⚠️  Database not reachable yet — run `npm run migrate:latest` then `polyroot doctor` when PostgreSQL is up (try `polyroot docker-fix`).",
      );
    }
    try {
      process.env["POLYROOT_ONBOARDING"] = "1";
      await runDoctor();
    } catch {
      console.log(
        "⚠️  Doctor reported issues — fix them with the hints above, or re-run `polyroot setup` any time.",
      );
    } finally {
      delete process.env["POLYROOT_ONBOARDING"];
    }
```

`runDoctor` currently ends with `if (!allOk) process.exit(1);` (`cli.ts:1763`): guard it so a failed doctor cannot kill onboarding while direct `polyroot doctor` behavior stays identical:

```typescript
  if (!allOk && process.env["POLYROOT_ONBOARDING"] !== "1") process.exit(1);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx tests/pm/contracts/onboarding-super-easy.test.ts`
Expected: PASS — both E2E tests exit 0; no-DB run prints the migrate/doctor hint.

- [ ] **Step 5: Commit**

```bash
git add src/pm/runtime/src/cli.ts tests/pm/contracts/onboarding-super-easy.test.ts
git commit -m "feat(onboard): PAPER-default finish with best-effort migrate and doctor"
```

---

### Task 4: Sync `.env.example` + help text, full verification

**Files:**
- Verify: `.env.example:100-107` (edit only if a maintainer gateway URL is present)
- Test: extend the Task 1 grep test to cover `.env.example` provider/discovery comments

**Interfaces:**
- Consumes: nothing new. Produces: docs consistent with the new flow.

- [ ] **Step 1: Extend the grep test to `.env.example`**

Append to the Task 1 describe block:

```typescript
  it("ships no maintainer-owned gateway in .env.example provider comments", () => {
    const envExample = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    assert.ok(
      !envExample.includes("files.pango.fun"),
      ".env.example must not point users at a maintainer-owned gateway",
    );
  });
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test --import tsx tests/pm/contracts/onboarding-super-easy.test.ts`
Expected: PASS (current `.env.example` is already clean — the test locks it in).

- [ ] **Step 3: Run the full verification suite**

Run: `npm run test:contract`
Expected: all green including the new file (existing `setup-stdin`, `setup-guide`, `wallet-verify`, `signer-keystore`, `live-preflight` suites unmodified and passing).

Run: `npm run build`
Expected: 13/13 packages pass.

Run: `npm run traceability`
Expected: 96/96 (no new requirements added).

- [ ] **Step 4: Commit**

```bash
git add tests/pm/contracts/onboarding-super-easy.test.ts .env.example
git commit -m "test(onboard): lock in zero maintainer-gateway defaults, verify full suite"
```

---

## Self-Review

**1. Spec coverage:** Open-source constraints → Task 1 (URL removal + grep test) + Task 4 (`.env.example` lock). Hermes-style provider → Task 1 (generic choices, empty base URL, ping). Wallet mandatory + plain words → Task 2 (mechanism untouched, copy only). PAPER default + LIVE gate → Task 3 (logic kept, copy tweaked). Auto-migrate + auto-doctor → Task 3 (best-effort, never fatal). Testing → Tasks 1–4 tests. Acceptance 1–4 → E2E test (Task 2), grep tests (Tasks 1+4), unmodified live suites (Task 4 step 3). No gaps.

**2. Placeholder scan:** No TBD/TODO. Every RUN line names the exact file + command + expected output. Error strings are quoted verbatim. The `POLYROOT_ONBOARDING` env-key mechanism is fully specified inline.

**3. Type consistency:** `pingModelsEndpoint(baseUrl: string, apiKey: string): Promise<boolean>` matches its call `await pingModelsEndpoint(baseUrl, apiKey)`. `runOnboardLikeHuman(home: string, lines: string[])` matches both call sites. `writeEnv` provider mapping uses the same `startsWith("OpenAI")` predicate as the new choice labels. `askChoice/askText/askRequiredSecret` signatures are the existing ones (`cli.ts:337-389`).
