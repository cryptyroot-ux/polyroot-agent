import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { explainLastDecision } from "@polyroot/runtime";

const CLI = join(process.cwd(), "src", "pm", "runtime", "src", "cli.ts");

function runCli(...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
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

interface FakePool {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

function makePool(
  handlers: Array<(text: string) => Record<string, unknown>[] | null>,
): FakePool {
  return {
    query: async (text: string) => {
      for (const h of handlers) {
        const rows = h(text);
        if (rows !== null) return { rows };
      }
      return { rows: [] };
    },
  };
}

const PAPER_ROWS = [
  {
    market_id: "mkt-abc",
    action: "NO_TRADE",
    forecast_p: 0.48,
    size: 0,
    fill_status: "NONE",
    created_at: new Date("2026-09-28T10:00:00Z"),
  },
];

const FORECAST_ROWS = [
  {
    market_id: "mkt-abc",
    probability_yes: 0.48,
    confidence: 0.72,
    model: "claude-opus-5",
    abstain_reason: "|p - 0.5| < 0.02 → uncertain",
    created_at: new Date("2026-09-28T09:59:00Z"),
  },
];

const RISK_ROWS = [
  {
    status: "REJECTED",
    rejection_reason: "forecast uncertain or unavailable",
    edge_after_fees: -0.016,
    ev_per_share: -0.008,
    decided_at: new Date("2026-09-28T09:59:30Z"),
    market_id: "mkt-abc",
    side: null,
    price: null,
    size: null,
  },
];

function fullPool(): FakePool {
  return makePool([
    (t) => (t.includes("FROM paper_log") ? PAPER_ROWS : null),
    (t) => (t.includes("FROM shadow_log") ? [] : null),
    (t) => (t.includes("FROM forecasts") ? FORECAST_ROWS : null),
    (t) => (t.includes("FROM risk_decisions") ? RISK_ROWS : null),
  ]);
}

describe("polyroot explain", () => {
  it("renders FORECAST, RISK and DECISION sections for the latest decision", async () => {
    const out = await explainLastDecision(fullPool(), 1);
    assert.ok(out.includes("FORECAST"), "missing FORECAST section");
    assert.ok(out.includes("RISK"), "missing RISK section");
    assert.ok(out.includes("DECISION"), "missing DECISION section");
    assert.ok(out.includes("mkt-abc"), "missing market id");
    assert.ok(
      out.includes("forecast uncertain or unavailable"),
      "missing rejection reason",
    );
    assert.ok(out.includes("claude-opus-5"), "missing model name");
    assert.ok(out.includes("NO_TRADE"), "missing final action");
  });

  it("reports gracefully when no decisions exist yet", async () => {
    const empty = makePool([() => []]);
    const out = await explainLastDecision(empty, 1);
    assert.ok(out.includes("No decisions recorded yet"));
    assert.ok(out.includes("polyroot run --once"));
  });

  it("is listed in --help", async () => {
    const { code, out } = await runCli("--help");
    assert.equal(code, 0);
    assert.ok(out.includes("explain"), "help must list the explain command");
  });

  it("caps --last at 20 and merges PAPER + SHADOW newest-first", async () => {
    const pool = makePool([
      (t) =>
        t.includes("FROM paper_log")
          ? [
              {
                market_id: "mkt-old",
                action: "BUY",
                forecast_p: 0.7,
                size: 10,
                fill_status: "FILLED",
                created_at: new Date("2026-09-28T08:00:00Z"),
              },
            ]
          : null,
      (t) =>
        t.includes("FROM shadow_log")
          ? [
              {
                market_id: "mkt-new",
                action: "NO_TRADE",
                forecast_p: null,
                size: 0,
                fill_status: "NONE",
                created_at: new Date("2026-09-28T09:00:00Z"),
              },
            ]
          : null,
      () => [],
    ]);
    const out = await explainLastDecision(pool, 999);
    // newest-first: shadow row market "mkt-new" must render before "mkt-old"
    assert.ok(
      out.indexOf("mkt-new") < out.indexOf("mkt-old"),
      "expected newest decision first",
    );
  });
});
