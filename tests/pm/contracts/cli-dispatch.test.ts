import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { suggestCommand } from "@polyroot/runtime";
import { normalizeConsoleLine } from "@polyroot/runtime";

const CLI = join(process.cwd(), "src", "pm", "runtime", "src", "cli.ts");

describe("suggestCommand (typo rescue)", () => {
  const known = ["markets", "status", "health", "restart", "run"];
  it("suggests the closest command", () => {
    assert.equal(suggestCommand("market", known), "markets");
    assert.equal(suggestCommand("statu", known), "status");
    assert.equal(suggestCommand("healt", known), "health");
    assert.equal(suggestCommand("MARKETS", known), "markets");
  });
  it("returns null when nothing is close", () => {
    assert.equal(suggestCommand("xyzzy-frobnicate", known), null);
    assert.equal(suggestCommand("", known), null);
  });
});

function runCli(
  args: string[],
  opts: {
    home?: string;
    extraEnv?: Record<string, string>;
    stdin?: string;
  } = {},
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(opts.home ? { HOME: opts.home } : {}),
        ...(opts.extraEnv ?? {}),
      },
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
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: 99, out });
    }, 30_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code: code ?? 1, out });
    });
  });
}

describe("unknown commands never boot the loop", () => {
  it("typo exits 2 with a suggestion (no DB, no network needed)", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-dispatch-"));
    const { code, out } = await runCli(["market"], { home });
    assert.equal(code, 2);
    assert.ok(out.includes("Unknown command: market"));
    assert.ok(out.includes("Did you mean: polyroot markets?"));
    assert.ok(!out.includes("starting in"));
  });

  it("gibberish exits 2 without suggestion", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-dispatch-"));
    const { code, out } = await runCli(["frobnicate"], { home });
    assert.equal(code, 2);
    assert.ok(out.includes("Unknown command: frobnicate"));
    assert.ok(out.includes("polyroot --help"));
  });
});

describe("console tolerates a leading polyroot prefix", () => {
  it("strips it, trims, leaves the rest verbatim", () => {
    assert.equal(
      normalizeConsoleLine("polyroot logs --follow"),
      "logs --follow",
    );
    assert.equal(normalizeConsoleLine("  POLYROOT STATUS  "), "STATUS");
    assert.equal(normalizeConsoleLine("status"), "status");
    assert.equal(normalizeConsoleLine("polyroot"), "polyroot");
    assert.equal(normalizeConsoleLine(""), "");
  });
});

describe("top-level logs command", () => {
  it("reports no logs cleanly with a fresh home (no supervisor)", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-dispatch-"));
    const { code, out } = await runCli(["logs"], {
      home,
      extraEnv: { POLYROOT_NO_SYSTEMD: "1" },
    });
    assert.equal(code, 0);
    assert.ok(out.includes("No agent log yet"));
  });
});

describe("console run refusal stays at the prompt", () => {
  it("occupied port -> guard message, then exit still works", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-dispatch-"));
    mkdirSync(join(home, ".polyroot"), { recursive: true });
    writeFileSync(
      join(home, ".polyroot", ".env"),
      "DATABASE_URL=postgresql://127.0.0.1:1/nodb\nRUNTIME_MODE=SHADOW\n",
    );
    const portSrv = createServer();
    await new Promise<void>((resolve, reject) => {
      portSrv.once("error", reject);
      portSrv.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = portSrv.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    try {
      const { code, out } = await runCli([], {
        home,
        extraEnv: {
          POLYROOT_NO_SYSTEMD: "1",
          POLYROOT_METRICS_PORT: String(port),
        },
        stdin: "run\nexit\n",
      });
      assert.equal(code, 0);
      assert.ok(
        out.includes("already bound") || out.includes("already running"),
      );
    } finally {
      portSrv.close();
    }
  });
});

describe("telegram setup wizard (dry-run, no network needed)", () => {
  it("rejects bad token shape, fails gracefully offline, aborts clean", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-dispatch-"));
    // Paced stdin (a line every 800ms): the shared readline session races
    // pre-ended pipes on back-to-back prompts, so upfront writes flake —
    // humans type after each prompt appears, and so does this harness.
    const lines = [
      "bad-token",
      "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh",
      "n",
    ];
    const out = await new Promise<string>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", CLI, "telegram", "setup"],
        {
          cwd: process.cwd(),
          env: { ...process.env, HOME: home },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let text = "";
      child.stdout.on("data", (d: Buffer) => {
        text += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        text += d.toString();
      });
      child.stdout.resume();
      child.stderr.resume();
      let i = 0;
      const feeder = setInterval(() => {
        if (i < lines.length) {
          try {
            child.stdin.write(`${lines[i++] as string}\n`);
          } catch {
            clearInterval(feeder);
          }
        } else {
          clearInterval(feeder);
          try {
            child.stdin.end();
          } catch {
            // already closed
          }
        }
      }, 800);
      const killer = setTimeout(() => {
        clearInterval(feeder);
        child.kill("SIGKILL");
        resolve(`TIMEOUT:${text}`);
      }, 45_000);
      child.on("close", (code) => {
        clearTimeout(killer);
        clearInterval(feeder);
        resolve(`CODE:${code ?? 1}\n${text}`);
      });
    });
    assert.ok(out.startsWith("CODE:0"), out.slice(0, 200));
    assert.ok(out.includes("bukan format token"));
    assert.ok(
      out.includes("Gagal verifikasi") || out.includes("Terhubung sebagai"),
    );
    assert.ok(out.includes("Setup dibatalkan"));
    assert.ok(!out.includes("TELEGRAM_BOT_TOKEN=123"));
  });
});

describe("onboarding preserves unmanaged env keys", () => {
  it("mergeEnvPreserving keeps TELEGRAM_* and custom keys, replaces managed", async () => {
    const { mergeEnvPreserving } = await import("@polyroot/runtime");
    const existing = [
      "DATABASE_URL=postgresql://old/db",
      "TELEGRAM_BOT_TOKEN=123:ABC",
      "TELEGRAM_OWNER_IDS=111",
      "MY_CUSTOM_RPC=https://x.example",
      "# a stale comment",
      "",
    ].join("\n");
    const out = mergeEnvPreserving(existing, [
      "DATABASE_URL=postgresql://new/db",
      "RUNTIME_MODE=SHADOW",
    ]);
    assert.ok(out.includes("DATABASE_URL=postgresql://new/db"));
    assert.ok(out.includes("TELEGRAM_BOT_TOKEN=123:ABC"));
    assert.ok(out.includes("TELEGRAM_OWNER_IDS=111"));
    assert.ok(out.includes("MY_CUSTOM_RPC=https://x.example"));
    assert.ok(!out.includes("a stale comment"));
    assert.ok(!out.includes("DATABASE_URL=postgresql://old/db"));
  });

  it("empty existing file yields the fresh body untouched", async () => {
    const { mergeEnvPreserving } = await import("@polyroot/runtime");
    assert.equal(mergeEnvPreserving("", ["A=1", "", "B=2"]), "A=1\n\nB=2");
  });
});
