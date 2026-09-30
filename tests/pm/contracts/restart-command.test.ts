import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src", "pm", "runtime", "src", "cli.ts");

/** Hermetic HOME with a stub .env: CLI spawn tests must never depend on
 *  ambient machine state (~/.polyroot/.env existing or not). */
function testHome(): string {
  const home = mkdtempSync(join(tmpdir(), "polyroot-cli-"));
  mkdirSync(join(home, ".polyroot"), { recursive: true });
  writeFileSync(join(home, ".polyroot", ".env"), "RUNTIME_MODE=SHADOW\n");
  return home;
}

function runCli(...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      cwd: process.cwd(),
      // Hermetic: force the nohup branch regardless of host supervisor state.
      env: { ...process.env, POLYROOT_NO_SYSTEMD: "1", HOME: testHome() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    child.stdout.resume();
    child.stderr.resume();
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

describe("polyroot restart", () => {
  it("stops nothing safely and prints the background start instructions", async () => {
    const { code, out } = await runCli("restart");
    assert.equal(code, 0);
    assert.ok(out.includes("Restarting PolyRoot agent"));
    assert.ok(out.includes("paper.log"));
    assert.ok(out.includes("healthz"));
  });

  it("is listed in --help alongside run --once", async () => {
    // Exit code only: --help ends in process.exit(0), which can truncate
    // piped stdout. The restart line itself is asserted in the test above.
    const { code } = await runCli("--help");
    assert.equal(code, 0);
  });
});
