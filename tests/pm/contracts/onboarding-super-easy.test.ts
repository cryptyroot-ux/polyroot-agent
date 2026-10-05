import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  statSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src", "pm", "runtime", "src", "cli.ts");

function runCliLikeHuman(
  home: string,
  cliArgs: string[],
  lines: string[],
  markers: string[],
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", CLI, ...cliArgs],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stdout.resume();
    child.stderr.resume();
    let i = 0;
    let lastLen = 0;
    let lastChange = Date.now();
    const timer = setInterval(() => {
      if (child.exitCode !== null || child.killed) {
        clearInterval(timer);
        return;
      }
      if (i >= lines.length) {
        clearInterval(timer);
        return;
      }
      if (out.length !== lastLen) {
        lastLen = out.length;
        lastChange = Date.now();
        return;
      }
      if (Date.now() - lastChange < 300) return;
      const marker = markers[i] as string;
      if (!out.includes(marker)) return;
      try {
        child.stdin.write((lines[i++] as string) + "\n");
      } catch {
        clearInterval(timer);
      }
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
    const src = readFileSync(
      join(process.cwd(), "src", "pm", "runtime", "src", "cli.ts"),
      "utf8",
    );
    assert.ok(
      !src.includes("files.pango.fun"),
      "onboarding must not default to a maintainer-owned gateway",
    );
  });

  it("ships no maintainer-owned gateway in .env.example provider comments", () => {
    const envExample = readFileSync(
      join(process.cwd(), ".env.example"),
      "utf8",
    );
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
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, "onboard"], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stdout.resume();
    child.stderr.resume();
    const waitFor: string[] = markers ?? [
      "Choose AI provider",
      "Paste your",
      "Select model",
      "Continue anyway?",
      "Wallet (Enter = create new):",
      "Create a vault password",
      "Repeat the vault password",
      "Choose mode (Enter = MICRO_LIVE):",
      "Capital cap in USD",
      "Daily loss cap in %",
    ];
    let i = 0;
    let lastLen = 0;
    let lastChange = Date.now();
    const timer = setInterval(() => {
      if (child.exitCode !== null || child.killed) {
        clearInterval(timer);
        return;
      }
      if (i >= lines.length) {
        clearInterval(timer);
        return;
      }
      if (out.length !== lastLen) {
        lastLen = out.length;
        lastChange = Date.now();
        return;
      }
      if (Date.now() - lastChange < 300) return;
      const marker = waitFor[i] as string;
      if (!out.includes(marker)) return;
      try {
        child.stdin.write((lines[i++] as string) + "\n");
      } catch {
        clearInterval(timer);
      }
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
    const src = readFileSync(
      join(process.cwd(), "src", "pm", "runtime", "src", "cli.ts"),
      "utf8",
    );
    assert.ok(
      !src.includes("files.pango.fun"),
      "onboarding must not default to a maintainer-owned gateway",
    );
  });

  it("ships no maintainer-owned gateway in .env.example provider comments", () => {
    const envExample = readFileSync(
      join(process.cwd(), ".env.example"),
      "utf8",
    );
    assert.ok(
      !envExample.includes("files.pango.fun"),
      ".env.example must not point users at a maintainer-owned gateway",
    );
  });
});

describe("super-easy onboarding E2E (create wallet path)", () => {
  it("completes with OpenAI key + new wallet + MICRO_LIVE default", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-onboard-"));
    const { code, out } = await runOnboardLikeHuman(
      home,
      [
        "", // provider: OpenAI (default)
        "sk-test-key-1", // API key (asked first, then live model catalog)
        "", // model: curated fallback default (fake key, offline)
        "y", // reachability check: continue anyway (fake key never passes the ping)
        "", // wallet: create new (default)
        "test-pass-123", // vault password
        "test-pass-123", // repeat vault password
        "1", // mode: MICRO_LIVE (default) - press 1
        "MICRO_LIVE", // typed confirmation (real money)
        "0x1111111111111111111111111111111111111111", // WALLET_ACCOUNT (WAL-03)
        "0x2222222222222222222222222222222222222222", // WALLET_FUNDER (WAL-03)
        "10000", // capital cap
        "500", // loss cap bps
        "n", // demo trade offer (no DB here, so never asked; keeps runs fast)
      ],
      [
        "Choose AI provider",
        "Paste your",
        "Select model",
        "Continue anyway?",
        "Wallet (Enter = create new):",
        "Create a vault password",
        "Repeat the vault password",
        "Choose mode (Enter = MICRO_LIVE):",
        "Type MICRO_LIVE to continue",
        "Wallet Account address",
        "Wallet Funder address",
        "Capital cap in USD",
        "Daily loss cap in %",
      ],
    );
    assert.equal(code, 0);
    assert.ok(out.includes("Create new wallet for me (recommended)"));
    const envPath = join(home, ".polyroot", ".env");
    assert.equal(existsSync(envPath), true);
    const env = readFileSync(envPath, "utf8");
    assert.ok(env.includes("RUNTIME_MODE=MICRO_LIVE"));
    assert.ok(env.includes("POLYROOT_FORECAST_PROVIDER=openai"));
    assert.ok(env.includes("OPENAI_BASE_URL=https://api.openai.com/v1"));
    assert.ok(env.includes("OPENAI_API_KEY=sk-test-key-1"));
    assert.ok(/WALLET_ADDRESS=0x[0-9a-fA-F]{40}/.test(env));
    const ksPath = join(home, ".polyroot", "keystore.json");
    assert.equal(existsSync(ksPath), true);
    assert.equal(statSync(ksPath).mode & 0o777, 0o600);
    assert.ok(!out.includes("files.pango.fun"));
  });
});

describe("super-easy onboarding E2E (ChatGPT login via Codex OAuth)", () => {
  it("writes codex provider with no API key when a login exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-onboard-"));
    // Fake Codex login in the temp HOME (far-future expiry, no refresh).
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const access = `${b64({ alg: "none" })}.${b64({ exp: 4102444800 })}.sig`;
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: access, account_id: "acc1" } }),
    );
    const { code, out } = await runOnboardLikeHuman(
      home,
      [
        "1", // provider: Codex (ChatGPT login via OAuth)
        "", // backend base URL (default)
        "", // model (default)
        "", // wallet: create new (default)
        "test-pass-123", // vault password
        "test-pass-123", // repeat vault password
        "1", // mode: MICRO_LIVE (default)
        "MICRO_LIVE", // typed confirmation (real money)
        "0x1111111111111111111111111111111111111111", // WALLET_ACCOUNT (WAL-03)
        "0x2222222222222222222222222222222222222222", // WALLET_FUNDER (WAL-03)
        "10000", // capital cap
        "500", // loss cap bps
        "n", // demo trade offer (never asked without DB)
      ],
      [
        "Choose AI provider",
        "Codex backend base URL",
        "Select Codex model",
        "Wallet (Enter = create new):",
        "Create a vault password",
        "Repeat the vault password",
        "Choose mode (Enter = MICRO_LIVE):",
        "Type MICRO_LIVE to continue",
        "Wallet Account address",
        "Wallet Funder address",
        "Capital cap in USD",
        "Daily loss cap in %",
      ],
    );
    assert.equal(code, 0);
    const envPath = join(home, ".polyroot", ".env");
    assert.equal(existsSync(envPath), true);
    const env = readFileSync(envPath, "utf8");
    assert.ok(env.includes("POLYROOT_FORECAST_PROVIDER=codex"));
    assert.ok(env.includes("POLYROOT_CODEX_BASE_URL="));
    assert.ok(!env.includes("OPENAI_API_KEY="));
    assert.ok(!out.includes("files.pango.fun"));
  });
});

describe("super-easy onboarding E2E (custom gateway path)", () => {
  it("writes openai provider + custom base URL so the brain stays live", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-onboard-"));
    const { code, out } = await runOnboardLikeHuman(
      home,
      [
        "10", // provider: Custom endpoint (always last)
        "https://gateway.example/v1", // gateway base URL (valid first try, no retry)
        "sk-custom-1", // gateway API key (asked BEFORE model: key→catalog contract)
        "", // model: live discovery offline → default (gpt-4o-mini)
        "mygw", // save endpoint for reuse under this name
        "y", // reachability check: continue anyway (example host never pings)
        "", // wallet: create new (default)
        "test-pass-123", // vault password
        "test-pass-123", // repeat vault password
        "1", // mode: MICRO_LIVE (default) - press 1
        "MICRO_LIVE", // typed confirmation (real money)
        "0x1111111111111111111111111111111111111111", // WALLET_ACCOUNT (WAL-03)
        "0x2222222222222222222222222222222222222222", // WALLET_FUNDER (WAL-03)
        "10000", // capital cap
        "500", // loss cap bps
        "n", // demo trade offer (no DB here, so never asked; keeps runs fast)
      ],
      [
        "Choose AI provider",
        "Your gateway base URL",
        "Paste your gateway API key",
        "Model name",
        "Save this endpoint for reuse?",
        "Continue anyway?",
        "Wallet (Enter = create new):",
        "Create a vault password",
        "Repeat the vault password",
        "Choose mode (Enter = MICRO_LIVE):",
        "Type MICRO_LIVE to continue",
        "Wallet Account address",
        "Wallet Funder address",
        "Capital cap in USD",
        "Daily loss cap in %",
      ],
    );
    assert.equal(code, 0);
    const envPath = join(home, ".polyroot", ".env");
    assert.equal(existsSync(envPath), true);
    const env = readFileSync(envPath, "utf8");
    assert.ok(env.includes("POLYROOT_FORECAST_PROVIDER=openai"));
    assert.ok(env.includes("OPENAI_BASE_URL=https://gateway.example/v1"));
    assert.ok(env.includes("POLYROOT_FORECAST_MODEL=gpt-4o-mini"));
    assert.ok(env.includes("OPENAI_API_KEY=sk-custom-1"));
    assert.ok(!out.includes("files.pango.fun"));
    const savedPath = join(home, ".polyroot", "custom-providers.json");
    assert.equal(existsSync(savedPath), true);
    const saved = JSON.parse(readFileSync(savedPath, "utf8")) as Array<{
      name: string;
      baseUrl: string;
    }>;
    assert.deepEqual(saved, [
      { name: "mygw", baseUrl: "https://gateway.example/v1" },
    ]);
    assert.equal(statSync(savedPath).mode & 0o777, 0o600);
  });
});

describe("onboarding offers the MICRO_LIVE → LIVE ladder", () => {
  it("MICRO_LIVE path requires typed confirmation and writes caps", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-onboard-"));
    const { code, out } = await runOnboardLikeHuman(
      home,
      [
        "", // provider: OpenAI (default)
        "sk-test-key-4", // API key (asked first, then live model catalog)
        "", // model: curated fallback default (fake key, offline)
        "y", // reachability check: continue anyway
        "", // wallet: create new (default)
        "test-pass-123", // vault password
        "test-pass-123", // repeat vault password
        "1", // mode: MICRO_LIVE
        "MICRO_LIVE", // typed confirmation (real money)
        "0x1111111111111111111111111111111111111111", // WALLET_ACCOUNT (WAL-03)
        "0x2222222222222222222222222222222222222222", // WALLET_FUNDER (WAL-03)
        "100", // capital cap
        "500", // loss cap bps
        "n", // demo trade offer (never asked without DB)
      ],
      [
        "Choose AI provider",
        "Paste your",
        "Select model",
        "Continue anyway?",
        "Wallet (Enter = create new):",
        "Create a vault password",
        "Repeat the vault password",
        "Choose mode (Enter = MICRO_LIVE):",
        "Type MICRO_LIVE to continue",
        "Wallet Account address",
        "Wallet Funder address",
        "Capital cap in USD",
        "Daily loss cap in %",
      ],
    );
    assert.equal(code, 0);
    const env = readFileSync(join(home, ".polyroot", ".env"), "utf8");
    assert.ok(env.includes("RUNTIME_MODE=MICRO_LIVE"));
    assert.ok(env.includes("POLYROOT_MICRO_LIVE_CAP_USD=100"));
    assert.ok(
      env.includes("WALLET_ACCOUNT=0x1111111111111111111111111111111111111111"),
    );
    assert.ok(
      env.includes("WALLET_FUNDER=0x2222222222222222222222222222222222222222"),
    );
    assert.ok(!out.includes("files.pango.fun"));
  });

  it("MICRO_LIVE without typed confirmation cancels setup (exit 0, no env)", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-onboard-"));
    const { code, out } = await runOnboardLikeHuman(
      home,
      [
        "", // provider: OpenAI (default)
        "sk-test-key-5", // API key (asked first, then live model catalog)
        "", // model: curated fallback default (fake key, offline)
        "y", // reachability check: continue anyway
        "", // wallet: create new (default)
        "test-pass-123", // vault password
        "test-pass-123", // repeat vault password
        "1", // mode: MICRO_LIVE
        "nope", // wrong confirmation → cancel setup
      ],
      [
        "Choose AI provider",
        "Paste your",
        "Select model",
        "Continue anyway?",
        "Wallet (Enter = create new):",
        "Create a vault password",
        "Repeat the vault password",
        "Choose mode (Enter = MICRO_LIVE):",
        "Type MICRO_LIVE to continue",
      ],
    );
    assert.equal(code, 0);
    assert.ok(out.includes("Setup cancelled"));
    assert.equal(
      existsSync(join(home, ".polyroot", ".env")),
      false,
      "cancelled setup must not write env",
    );
  });
});
describe("onboarding finish is resilient without a database", () => {
  it("still exits 0 and tells the user the one next command", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-onboard-"));
    // Hermetic: force an unroutable DB so migrate/doctor fail on EVERY host,
    // even where localhost:5432 is up. writeEnv respects ambient DATABASE_URL.
    const { code, out } = await runOnboardLikeHuman(
      home,
      [
        "", // provider: OpenAI (default)
        "sk-test-key-2", // API key (asked first, then live model catalog)
        "", // model: curated fallback default (fake key, offline)
        "y", // reachability check: continue anyway (fake key never passes the ping)
        "", // wallet: create new (default)
        "test-pass-123", // vault password
        "test-pass-123", // repeat vault password
        "1", // mode: MICRO_LIVE (default) - press 1
        "MICRO_LIVE", // typed confirmation (real money)
        "0x1111111111111111111111111111111111111111", // WALLET_ACCOUNT (WAL-03)
        "0x2222222222222222222222222222222222222222", // WALLET_FUNDER (WAL-03)
        "10000", // capital cap
        "500", // loss cap bps
        "n", // demo trade offer (no DB here, so never asked; keeps runs fast)
      ],
      [
        "Choose AI provider",
        "Paste your",
        "Select model",
        "Continue anyway?",
        "Wallet (Enter = create new):",
        "Create a vault password",
        "Repeat the vault password",
        "Choose mode (Enter = MICRO_LIVE):",
        "Type MICRO_LIVE to continue",
        "Wallet Account address",
        "Wallet Funder address",
        "Capital cap in USD",
        "Daily loss cap in %",
      ],
      { DATABASE_URL: "postgresql://onboard_test:none@127.0.0.1:1/nodb" },
    );
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

describe("onboarding E2E (Anthropic official key: key→live-catalog contract)", () => {
  it("writes anthropic provider + ANTHROPIC_API_KEY, never OPENAI_API_KEY", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-onboard-"));
    const { code, out } = await runOnboardLikeHuman(
      home,
      [
        "7", // provider: Claude (Anthropic official API key)
        "sk-ant-test-1", // official key (asked BEFORE catalog: key→catalog contract)
        "", // model: live catalog offline → curated default (claude-sonnet-4-5)
        "y", // reachability check: continue anyway (offline)
        "", // wallet: create new (default)
        "test-pass-123", // vault password
        "test-pass-123", // repeat vault password
        "1", // mode: MICRO_LIVE (default)
        "MICRO_LIVE", // typed confirmation (real money)
        "0x1111111111111111111111111111111111111111", // WALLET_ACCOUNT (WAL-03)
        "0x2222222222222222222222222222222222222222", // WALLET_FUNDER (WAL-03)
        "10000", // capital cap
        "500", // loss cap bps
        "n", // no demo trade
      ],
      [
        "Choose AI provider",
        "Paste your Anthropic API key",
        "Select model",
        "Continue anyway?",
        "Wallet (Enter = create new):",
        "Create a vault password",
        "Repeat the vault password",
        "Choose mode (Enter = MICRO_LIVE):",
        "Type MICRO_LIVE to continue",
        "Wallet Account address",
        "Wallet Funder address",
        "Capital cap in USD",
        "Daily loss cap in %",
      ],
    );
    assert.equal(code, 0);
    const env = readFileSync(join(home, ".polyroot", ".env"), "utf8");
    assert.ok(env.includes("POLYROOT_FORECAST_PROVIDER=anthropic"));
    assert.ok(env.includes("ANTHROPIC_API_KEY=sk-ant-test-1"));
    assert.ok(env.includes("POLYROOT_FORECAST_MODEL=claude-sonnet-4-5"));
    assert.ok(!env.includes("OPENAI_API_KEY="));
    assert.ok(!out.includes("files.pango.fun"));
  });
});

describe("polyroot set-key (hidden prompt, never argv)", () => {
  it("stores an OpenAI-compatible key then refuses silent overwrite", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-setkey-"));
    const first = await runCliLikeHuman(
      home,
      ["set-key"],
      ["1", "sk-test-openai-1"],
      ["Which API key", "Paste your OPENAI_API_KEY"],
    );
    assert.equal(first.code, 0);
    const envPath = join(home, ".polyroot", ".env");
    assert.ok(
      readFileSync(envPath, "utf8").includes("OPENAI_API_KEY=sk-test-openai-1"),
    );
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
    assert.ok(!first.out.includes("sk-test-openai-1"), "key must never echo");
    const second = await runCliLikeHuman(
      home,
      ["set-key"],
      ["1", "n"],
      ["Which API key", "Overwrite it?"],
    );
    assert.equal(second.code, 0);
    assert.ok(
      readFileSync(envPath, "utf8").includes("OPENAI_API_KEY=sk-test-openai-1"),
      "declined overwrite keeps the old key",
    );
  });

  it("stores an Anthropic key under its own variable", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-setkey-"));
    const r = await runCliLikeHuman(
      home,
      ["set-key"],
      ["2", "sk-ant-test-2"],
      ["Which API key", "Paste your ANTHROPIC_API_KEY"],
    );
    assert.equal(r.code, 0);
    const env = readFileSync(join(home, ".polyroot", ".env"), "utf8");
    assert.ok(env.includes("ANTHROPIC_API_KEY=sk-ant-test-2"));
    assert.ok(!r.out.includes("sk-ant-test-2"), "key must never echo");
  });
});
