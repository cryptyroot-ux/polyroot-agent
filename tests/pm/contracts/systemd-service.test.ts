import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMPLATE = join(process.cwd(), "scripts", "polyroot.service.template");
const INSTALLER = join(process.cwd(), "scripts", "install-systemd.sh");

function render(home: string, user: string): string {
  return execFileSync(
    "bash",
    [INSTALLER, "--print", "--home", home, "--user", user, "--node", "/usr/bin/node"],
    { encoding: "utf8" },
  );
}

describe("systemd 24/7 supervisor (template)", () => {
  it("ships a template with placeholders and zero secrets", () => {
    assert.equal(existsSync(TEMPLATE), true);
    const src = readFileSync(TEMPLATE, "utf8");
    assert.ok(src.includes("{{POLYROOT_HOME}}"));
    assert.ok(src.includes("{{POLYROOT_USER}}"));
    assert.ok(src.includes("{{NODE_BIN}}"));
    // No maintainer-owned or hardcoded paths, no secrets, no wrong entrypoint.
    assert.ok(!src.includes("/root/"));
    assert.ok(!src.includes("/home/"));
    assert.ok(!src.includes("files.pango.fun"));
    assert.ok(!src.includes("control/src/index.js"));
    assert.ok(!/sk-[A-Za-z0-9]{8,}/.test(src));
    assert.ok(!/0x[0-9a-fA-F]{64}/.test(src));
    assert.ok(!/BEGIN .*PRIVATE/.test(src));
    // 24/7 semantics: always come back, start on boot.
    assert.ok(src.includes("Restart=always"));
    assert.ok(src.includes("WantedBy=multi-user.target"));
    // No hard Requires= on distro-specific postgres units (fail-closed instead).
    assert.ok(!src.includes("Requires=postgresql"));
    assert.ok(!src.includes("Requires=docker"));
  });

  it("starts the TRADING LOOP, never the bare interactive console", () => {
    const src = readFileSync(TEMPLATE, "utf8");
    const execLine = src.split("\n").find((l) => l.startsWith("ExecStart="));
    assert.ok(execLine);
    assert.ok(execLine.endsWith("src/pm/runtime/dist/cli.js run"));
  });

  it("renders placeholders with zero leftovers", () => {
    const out = render("/home/ops/.polyroot", "ops");
    assert.ok(out.includes("User=ops"));
    assert.ok(out.includes("WorkingDirectory=/home/ops/.polyroot"));
    assert.ok(
      out.includes(
        "ExecStart=/usr/bin/node /home/ops/.polyroot/src/pm/runtime/dist/cli.js run",
      ),
    );
    assert.ok(!out.includes("{{"));
  });

  it("installs into SYSTEMD_DIR without touching real systemd (test mode)", () => {
    const dir = mkdtempSync(join(tmpdir(), "polyroot-systemd-"));
    execFileSync("bash", [INSTALLER, "--home", "/home/ops/.polyroot", "--user", "ops", "--node", "/usr/bin/node"], {
      env: { ...process.env, SYSTEMD_DIR: dir },
    });
    const unitPath = join(dir, "polyroot.service");
    assert.equal(existsSync(unitPath), true);
    const unit = readFileSync(unitPath, "utf8");
    assert.ok(unit.includes("Restart=always"));
    assert.ok(!unit.includes("{{"));
  });

  it("installer + template stay in sync (installer consumes this template)", () => {
    const installer = readFileSync(INSTALLER, "utf8");
    assert.ok(installer.includes("polyroot.service.template"));
    assert.ok(installer.includes("{{POLYROOT_HOME}}") || installer.includes("POLYROOT_HOME"));
    assert.ok(installer.includes("daemon-reload"));
    assert.ok(installer.includes("reset-failed"));
  });

  it("restart help prefers systemd when the unit is loaded", () => {
    // Source-level guard: restart path must branch on the unit state instead
    // of unconditionally printing nohup instructions.
    const cli = readFileSync(
      join(process.cwd(), "src", "pm", "runtime", "src", "cli.ts"),
      "utf8",
    );
    assert.ok(cli.includes("systemctl show polyroot --property=LoadState"));
    assert.ok(cli.includes("sudo systemctl restart polyroot"));
    assert.ok(cli.includes("install-systemd.sh"));
  });
});

// Keep install.sh honest: the systemd step must run on every fresh install.
describe("install.sh wires the 24/7 service", () => {
  it("calls install-systemd.sh best-effort after linking the binary", () => {
    const sh = readFileSync(join(process.cwd(), "scripts", "install.sh"), "utf8");
    const linkIdx = sh.indexOf("link_binary");
    const sysIdx = sh.indexOf("install-systemd.sh");
    assert.ok(linkIdx >= 0 && sysIdx >= 0 && sysIdx > linkIdx);
  });
});

// `polyroot update` must deliver unit fixes by itself (render-only here:
// SYSTEMD_DIR override never touches real systemd, even on hosts that
// have a polyroot unit loaded).
describe("polyroot update refreshes the supervisor unit", () => {
  it("renders the unit into SYSTEMD_DIR and reports refreshed", async () => {
    const { refreshSupervisorUnit } = await import("@polyroot/runtime");
    const dir = mkdtempSync(join(tmpdir(), "polyroot-update-systemd-"));
    const prev = process.env["POLYROOT_SYSTEMD_DIR"];
    process.env["POLYROOT_SYSTEMD_DIR"] = dir;
    try {
      const res = await refreshSupervisorUnit(process.cwd());
      assert.equal(res.refreshed, true);
      assert.equal(res.restarted, false);
      const unit = readFileSync(join(dir, "polyroot.service"), "utf8");
      assert.ok(unit.includes("ExecStart="));
      assert.ok(unit.includes("src/pm/runtime/dist/cli.js run"));
      assert.ok(!unit.includes("{{"));
    } finally {
      if (prev === undefined) delete process.env["POLYROOT_SYSTEMD_DIR"];
      else process.env["POLYROOT_SYSTEMD_DIR"] = prev;
    }
  });

  it("is a no-op (never throws) with POLYROOT_NO_SYSTEMD=1", async () => {
    const { refreshSupervisorUnit } = await import("@polyroot/runtime");
    const prev = process.env["POLYROOT_NO_SYSTEMD"];
    process.env["POLYROOT_NO_SYSTEMD"] = "1";
    try {
      const res = await refreshSupervisorUnit(process.cwd());
      assert.equal(res.refreshed, false);
      assert.equal(res.restarted, false);
    } finally {
      if (prev === undefined) delete process.env["POLYROOT_NO_SYSTEMD"];
      else process.env["POLYROOT_NO_SYSTEMD"] = prev;
    }
  });

  it("update path runs migrations automatically (best-effort)", () => {
    const cli = readFileSync(
      join(process.cwd(), "src", "pm", "runtime", "src", "cli.ts"),
      "utf8",
    );
    assert.ok(cli.includes("npm run migrate:latest"));
    assert.ok(cli.includes("refreshSupervisorUnit"));
    assert.ok(cli.includes("systemctl try-restart polyroot"));
  });
});
