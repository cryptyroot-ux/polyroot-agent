import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src", "pm", "runtime", "src", "cli.ts");

describe("onboarding contains zero maintainer-owned provider defaults", () => {
  it("never ships files.pango.fun in the onboarding path", () => {
    const src = readFileSync(join(process.cwd(), "src", "pm", "runtime", "src", "cli.ts"), "utf8");
    assert.ok(
      !src.includes("files.pango.fun"),
      "onboarding must not default to a maintainer-owned gateway",
    );
  });

  it("ships no maintainer-owned gateway in .env.example provider comments", () => {
    const envExample = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    assert.ok(
      !envExample.includes("files.pango.fun"),
      ".env.example must not point users at a maintainer-owned gateway",
    );
  });
});

function runOnboardLikeHuman(
  home: string,
  lines: string[],
  markers?: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, "onboard"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    child.stdout.resume();
    child.stderr.resume();
    const waitFor: string[] = markers ?? [
      "Choose AI provider",
      "Select model:",
      "Paste your OpenAI API key",
      "Continue anyway?",
      "Wallet (Enter = create new):",
      "Create a vault password",
      "Repeat the vault password",
      "Choose mode (Enter = SHADOW):",
      "Capital cap in USD",
      "Daily loss cap in bps",
    ];
    let i = 0;
    let lastLen = 0;
    let lastChange = Date.now();
    const timer = setInterval(() => {
      if (child.exitCode !== null || child.killed) { clearInterval(timer); return; }
      if (i >= lines.length) { clearInterval(timer); return; }
      if (out.length !== lastLen) { lastLen = out.length; lastChange = Date.now(); return; }
      if (Date.now() - lastChange < 300) return;
      const marker = waitFor[i] as string;
      if (!out.includes(marker)) return;
      try { child.stdin.write((lines[i++] as string) + "\n"); } catch { clearInterval(timer); }
    }, 100);
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

describe("onboarding contains zero maintainer-owned provider defaults", () => {
  it("never ships files.pango.fun in the onboarding path", () => {
    const src = readFileSync(join(process.cwd(), "src", "pm", "runtime", "src", "cli.ts"), "utf8");
    assert.ok(
      !src.includes("files.pango.fun"),
      "onboarding must not default to a maintainer-owned gateway",
    );
  });

  it("ships no maintainer-owned gateway in .env.example provider comments", () => {
    const envExample = readFileSync(join(process.cwd(), ".env.example"), "utf8");
    assert.ok(
      !envExample.includes("files.pango.fun"),
      ".env.example must not point users at a maintainer-owned gateway",
    );
  });
});

describe("super-easy onboarding E2E (create wallet path)", () => {
  it("completes with OpenAI key + new wallet + PAPER default", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-onboard-"));
    const { code, out } = await runOnboardLikeHuman(home, [
      "",               // provider: OpenAI (default)
      "",               // model: gpt-4o-mini (default)
      "sk-test-key-1",  // API key
      "y",              // reachability check: continue anyway (fake key never passes the ping)
      "",               // wallet: create new (default)
      "test-pass-123",  // vault password
      "test-pass-123",  // repeat vault password
      "1",              // mode: SHADOW (default) - press 1
      "10000",          // capital cap
      "500",            // loss cap bps
      "n",              // demo trade offer (no DB here, so never asked; keeps runs fast)
    ]);
    assert.equal(code, 0);
    assert.ok(out.includes("Create new wallet for me (recommended)"));
    const envPath = join(home, ".polyroot", ".env");
    assert.equal(existsSync(envPath), true);
    const env = readFileSync(envPath, "utf8");
    assert.ok(env.includes("RUNTIME_MODE=SHADOW"));
    assert.ok(env.includes("POLYROOT_FORECAST_PROVIDER=openai"));
    assert.ok(env.includes("OPENAI_BASE_URL=https://api.openai.com/v1"));
    assert.ok(env.includes("OPENAI_API_KEY=sk-test-key-1"));
    assert.ok(/WALLET_ADDRESS=0x[0-9a-fA-F]{40}/.test(env));
    const ksPath = join(home, ".polyroot", "keystore.json");
    assert.equal(existsSync(ksPath), true);
    assert.equal((statSync(ksPath).mode & 0o777), 0o600);
    assert.ok(!out.includes("files.pango.fun"));
  });
});

describe("super-easy onboarding E2E (custom gateway path)", () => {
  it("writes openai provider + custom base URL so the brain stays live", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-onboard-"));
    const { code, out } = await runOnboardLikeHuman(home, [
      "2",                        // provider: own OpenAI-compatible gateway
      "https://gateway.example/v1", // gateway base URL (valid first try, no retry)
      "gpt-4o-mini",              // model name
      "sk-custom-1",              // gateway API key
      "y",                        // reachability check: continue anyway (example host never pings)
      "",                         // wallet: create new (default)
      "test-pass-123",            // vault password
      "test-pass-123",            // repeat vault password
      "1",                        // mode: SHADOW (default) - press 1
      "10000",                    // capital cap
      "500",                      // loss cap bps
      "n",                        // demo trade offer (no DB here, so never asked; keeps runs fast)
    ], [
      "Choose AI provider",
      "Your gateway base URL",
      "Model name",
      "Paste your gateway API key",
      "Continue anyway?",
      "Wallet (Enter = create new):",
      "Create a vault password",
      "Repeat the vault password",
      "Choose mode (Enter = SHADOW):",
      "Capital cap in USD",
      "Daily loss cap in bps",
    ]);
    assert.equal(code, 0);
    const envPath = join(home, ".polyroot", ".env");
    assert.equal(existsSync(envPath), true);
    const env = readFileSync(envPath, "utf8");
    assert.ok(env.includes("POLYROOT_FORECAST_PROVIDER=openai"));
    assert.ok(env.includes("OPENAI_BASE_URL=https://gateway.example/v1"));
    assert.ok(env.includes("POLYROOT_FORECAST_MODEL=gpt-4o-mini"));
    assert.ok(env.includes("OPENAI_API_KEY=sk-custom-1"));
    assert.ok(!out.includes("files.pango.fun"));
  });
});

describe("onboarding finish is resilient without a database", () => {
  it("still exits 0 and tells the user the one next command", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-onboard-"));
    // Hermetic: force an unroutable DB so migrate/doctor fail on EVERY host,
    // even where localhost:5432 is up. writeEnv respects ambient DATABASE_URL.
    const { code, out } = await runOnboardLikeHuman(home, [
      "",               // provider: OpenAI (default)
      "",               // model: gpt-4o-mini (default)
      "sk-test-key-2",  // API key
      "y",              // reachability check: continue anyway (fake key never passes the ping)
      "",               // wallet: create new (default)
      "test-pass-123",  // vault password
      "test-pass-123",  // repeat vault password
      "1",              // mode: SHADOW (default) - press 1
      "10000",          // capital cap
      "500",            // loss cap bps
      "n",              // demo trade offer (no DB here, so never asked; keeps runs fast)
    ], undefined, { DATABASE_URL: "postgresql://onboard_test:none@127.0.0.1:1/nodb" });
    assert.equal(code, 0);
    assert.ok(
      out.includes("migrate:latest"),
      "must point the user at the one next command when infra is missing",
    );
    assert.ok(
      !out.includes("Watch a 1-step demo trade now?"),
      "demo offer appears only after migrate+doctor succeed; must not hang here",
    );
    const envPath = join(home, ".polyroot", ".env");
    assert.ok(
      readFileSync(envPath, "utf8").includes("127.0.0.1:1/nodb"),
      "writeEnv must respect a pre-configured DATABASE_URL instead of clobbering it",
    );
  });
});
