import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src", "pm", "runtime", "src", "cli.ts");

/**
 * Run `polyroot setup` like a human: keystrokes arrive over time and stdin
 * stays open until the flow ends. (Writing every byte up-front followed by
 * an immediate EOF is not how terminals behave, and Node readline treats it
 * as a dead stream.)
 */
function runSetupLikeHuman(home: string): Promise<{ code: number }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", CLI, "setup"],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdout.resume();
    child.stderr.resume();
    // Keep pressing Enter until the flow ends: extra Enters only ever
    // accept safe defaults, and stdin stays open so EOF can never cancel us.
    const timer = setInterval(() => {
      if (child.exitCode !== null || child.killed) {
        clearInterval(timer);
        return;
      }
      try {
        child.stdin.write("\n");
      } catch {
        clearInterval(timer);
      }
    }, 400);
    const killer = setTimeout(() => {
      clearInterval(timer);
      child.kill("SIGKILL");
      resolve({ code: 99 });
    }, 55_000);
    child.on("close", (code) => {
      clearTimeout(killer);
      clearInterval(timer);
      resolve({ code: code ?? 1 });
    });
  });
}

describe("setup survives sequential prompts (shared stdin)", () => {
  it("completes with all defaults and writes bounds to .env", async () => {
    const home = mkdtempSync(join(tmpdir(), "polyroot-setup-"));
    const { code } = await runSetupLikeHuman(home);
    const envPath = join(home, ".polyroot", ".env");
    assert.equal(code, 0);
    assert.equal(
      existsSync(envPath),
      true,
      "setup must write ~/.polyroot/.env instead of cancelling",
    );
    const env = readFileSync(envPath, "utf8");
    assert.ok(env.includes("POLYROOT_MICRO_LIVE_CAP_USD=1000"));
    assert.ok(env.includes("POLYROOT_MICRO_LIVE_LOSS_CAP_USD=50"));
  });
});
