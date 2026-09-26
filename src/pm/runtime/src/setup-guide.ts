/**
 * @polyroot/runtime — Lay-friendly setup guide.
 *
 * The community operating PolyRoot is not expected to know coding. All
 * user-facing setup copy lives here in plain simple English: short steps,
 * one idea per line, safe defaults on Enter, and an exact command
 * cheat-sheet at the end. The AI execution path never reads these strings —
 * they are operator UI only.
 */

import { AUTONOMY_BOUNDS, resolveLossCapPusd } from "./autonomy-bounds.js";

export interface SetupBoundsInput {
  capitalUsd: number;
  lossBps: number;
  mode: "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE";
  universe: string[];
  discovery?: {
    mode: "auto" | "manual";
    minVolume24h?: number;
    maxMarkets?: number;
    maxSpread?: number;
  };
}

/** Build the exact .env lines for owner bounds. Invalid numbers fall back
 *  to the approved safe defaults (never a zero/unbounded cap). */
export function buildSetupEnvUpdate(input: SetupBoundsInput): string[] {
  const capital =
    Number.isFinite(input.capitalUsd) && input.capitalUsd > 0
      ? Math.floor(input.capitalUsd)
      : AUTONOMY_BOUNDS.CAPITAL_CAP_USD;
  const bps =
    Number.isFinite(input.lossBps) && input.lossBps > 0
      ? Math.floor(input.lossBps)
      : AUTONOMY_BOUNDS.DAILY_LOSS_CAP_BPS;
  const lossCap = resolveLossCapPusd(capital, bps) ?? 0;
  const lines = [
    `POLYROOT_MICRO_LIVE_CAP_USD=${capital}`,
    `POLYROOT_MICRO_LIVE_LOSS_CAP_USD=${lossCap}`,
    `RUNTIME_MODE=${input.mode}`,
  ];
  if (input.universe.length > 0) {
    lines.push(`POLYROOT_MARKET_IDS=${[...new Set(input.universe)].join(",")}`);
  }
  if (input.discovery) {
    const minRaw = Number(input.discovery.minVolume24h);
    const maxRaw = Number(input.discovery.maxMarkets);
    const spreadRaw = Number(input.discovery.maxSpread);
    lines.push(`POLYROOT_MARKET_DISCOVERY=${input.discovery.mode}`);
    lines.push(
      `POLYROOT_DISCOVERY_MIN_VOLUME_24H=${Number.isFinite(minRaw) && minRaw > 0 ? Math.floor(minRaw) : 10_000}`,
    );
    lines.push(
      `POLYROOT_DISCOVERY_MAX_MARKETS=${Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(Math.floor(maxRaw), 20) : 5}`,
    );
    lines.push(
      `POLYROOT_DISCOVERY_MAX_SPREAD=${Number.isFinite(spreadRaw) && spreadRaw > 0 ? Math.min(Math.max(spreadRaw, 0.01), 0.5) : 0.1}`,
    );
  }
  return lines;
}

/** Replace existing keys in place, append missing ones. Never duplicates. */
export function upsertEnvLines(existing: string, updates: string[]): string {
  const wanted = new Map<string, string>();
  for (const line of updates) {
    const eq = line.indexOf("=");
    if (eq > 0) wanted.set(line.slice(0, eq), line);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of existing.split("\n")) {
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq) : "";
    if (key && wanted.has(key)) {
      out.push(wanted.get(key) as string);
      seen.add(key);
    } else {
      out.push(line);
    }
  }
  for (const [key, line] of wanted) {
    if (!seen.has(key)) out.push(line);
  }
  return out.join("\n");
}

/** Numbered cheat-sheet printed after setup/onboarding. Exact commands,
 *  in order, with what PASS looks like. */
export function formatNextSteps(
  mode: "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE",
): string {
  const lines = [
    "",
    "═══ Next steps (run one at a time) ═══",
    "",
    "1) Check your configuration:",
    "     polyroot status",
    "     → make sure Mode, Wallet, and Loss Cap look right.",
    "",
  ];
  if (mode !== "PAPER") {
    lines.push(
      "2) Test LIVE readiness (required before real money):",
      "     polyroot doctor --live",
      "     → everything must be ✅ PASS. Fix any ❌ first.",
      "",
      "3) Practice 48 hours with no money (SHADOW mode):",
      "     polyroot setup",
      "     → choose SHADOW, then: polyroot run",
      "     → let it run, make sure there are no errors.",
      "",
      "4) Start small first:",
      "     polyroot run",
      "     → watch for 1-2 days before raising capital.",
      "",
    );
  } else {
    lines.push(
      "2) Open the console and run practice mode (play money, 100% safe):",
      "     polyroot",
      "     → type: run (press Ctrl+C to stop, exit to leave).",
      "",
      "3) When you are ready for real money, run:",
      "     polyroot setup",
      "     → follow the guide, then polyroot doctor --live.",
      "",
    );
  }
  lines.push("Need help? Run: polyroot status", "");
  return lines.join("\n");
}
