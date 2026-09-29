/**
 * @polyroot/runtime — Single-instance guard.
 *
 * A second `polyroot run` must never start trading next to a live one
 * (double entries, double fills, split-brain loss accounting). Before the
 * loop boots, this guard refuses with a helpful message when:
 *   1. the systemd unit is loaded+active (the 24/7 owner — most common), or
 *   2. something already listens on the metrics/health port (a previous
 *      `run`, manual or supervised, on any supervisor).
 *
 * Both checks are best-effort and skippable (POLYROOT_NO_SYSTEMD skips the
 * unit check; a failed port probe fails OPEN so a broken sandbox never
 * blocks startup — the metrics bind itself remains the final arbiter and
 * its EADDRINUSE is translated to the same friendly message).
 */

import { execSync } from "node:child_process";
import * as net from "node:net";

export interface InstanceCheckDeps {
  /** Override for tests (default: real `systemctl show`). */
  readUnitState?: () => string | null;
  /** Override for tests (default: real TCP probe). */
  portInUse?: (host: string, port: number) => Promise<boolean>;
}

export class AgentAlreadyRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentAlreadyRunningError";
  }
}

function defaultReadUnitState(): string | null {
  try {
    const out = execSync(
      "systemctl show polyroot --property=LoadState,ActiveState,MainPID 2>/dev/null",
      { encoding: "utf8" },
    ) as string;
    return out;
  } catch {
    return null;
  }
}

function defaultPortInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    try {
      const sock = net.connect({ host, port });
      const timer = setTimeout(() => {
        try {
          sock.destroy();
        } catch {
          // teardown is best-effort
        }
        done(false);
      }, 1500);
      sock.once("connect", () => {
        clearTimeout(timer);
        try {
          sock.end();
        } catch {
          // teardown is best-effort
        }
        done(true);
      });
      sock.once("error", () => {
        clearTimeout(timer);
        done(false);
      });
    } catch {
      done(false);
    }
  });
}

function parseUnitProp(show: string, key: string): string {
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(show);
  return (m?.[1] ?? "").trim();
}

/**
 * Throw AgentAlreadyRunningError when another agent owns this machine.
 * Resolves silently otherwise (including when checks themselves fail —
 * the metrics bind stays the final arbiter).
 */
export async function assertSingleInstance(
  opts: {
    host?: string;
    port?: number;
    skipSystemdCheck?: boolean;
  } = {},
  deps: InstanceCheckDeps = {},
): Promise<void> {
  const skipUnit =
    opts.skipSystemdCheck ?? process.env["POLYROOT_NO_SYSTEMD"] === "1";
  if (!skipUnit) {
    const show = (deps.readUnitState ?? defaultReadUnitState)();
    if (show && parseUnitProp(show, "LoadState") === "loaded") {
      const active = parseUnitProp(show, "ActiveState");
      if (active === "active" || active === "activating") {
        const pid = parseUnitProp(show, "MainPID");
        throw new AgentAlreadyRunningError(
          [
            `Agent already running under systemd (PID ${pid || "?"}).`,
            "Starting a second loop would double-trade every market.",
            "Use instead:",
            "  sudo systemctl status polyroot    # is it healthy?",
            "  sudo journalctl -u polyroot -f    # watch it live",
            "  polyroot status                   # configuration",
            "  sudo systemctl restart polyroot   # restart it (picks up updates)",
          ].join("\n"),
        );
      }
    }
  }
  const host = opts.host ?? process.env["POLYROOT_METRICS_HOST"] ?? "127.0.0.1";
  const portRaw = Number(
    opts.port ?? process.env["POLYROOT_METRICS_PORT"] ?? 9090,
  );
  const port = Number.isFinite(portRaw) ? portRaw : 9090;
  const busy = await (deps.portInUse ?? defaultPortInUse)(host, port);
  if (busy) {
    throw new AgentAlreadyRunningError(
      [
        `Port ${port} is already bound — another agent (or process) is live.`,
        "Starting a second loop would double-trade every market.",
        "Find it with:  ss -ltnp | grep 9090   (or:)  ps aux | grep 'dist/cli.js run'",
        "Manage it with: sudo systemctl status polyroot",
      ].join("\n"),
    );
  }
}

/** Translate a metrics-bind EADDRINUSE into the friendly refusal. */
export function isAddrInUse(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "EADDRINUSE"
  );
}
