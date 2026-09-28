/**
 * @polyroot/runtime — Decision-chain explainer for `polyroot explain`.
 *
 * Read-only by construction: issues SELECTs only, never writes. Accepts any
 * pg-Pool-like `{ query }` (see QueryablePool) so unit tests run without a
 * database. All row access is defensive: unknown/missing columns degrade to
 * "—" placeholders instead of throwing, except for transport errors which
 * propagate to the CLI (fail-closed: CLI prints the error and exits 1).
 */

import type { QueryablePool } from "../mode-watcher.js";

function str(value: unknown): string {
  if (typeof value === "string" && value.length > 0) {
    // pg returns NUMERIC as raw strings ("0.00000000") — trim for display.
    if (/^-?\d+\.\d+$/.test(value)) {
      const trimmed = value.replace(/\.?0+$/, "");
      return trimmed === "" || trimmed === "-" ? "0" : trimmed;
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  return "—";
}

function pct(value: unknown): string {
  const n = typeof value === "string" ? Number(value) : (value as number);
  if (typeof n === "number" && Number.isFinite(n)) {
    return `${(n * 100).toFixed(1)}%`;
  }
  return "—";
}

function usd(value: unknown): string {
  const n = typeof value === "string" ? Number(value) : (value as number);
  if (typeof n === "number" && Number.isFinite(n)) {
    const sign = n < 0 ? "-" : n > 0 ? "+" : "";
    return `${sign}$${Math.abs(n).toFixed(2)}`;
  }
  return "—";
}

interface LogRow {
  market_id: unknown;
  action: unknown;
  forecast_p: unknown;
  size: unknown;
  fill_status: unknown;
  created_at: unknown;
  source: string;
}

/** Latest simulated decisions across PAPER + SHADOW logs, newest first. */
async function latestDecisions(
  pool: QueryablePool,
  limit: number,
): Promise<LogRow[]> {
  const paper = await pool.query(
    `SELECT market_id, action, forecast_p, size, fill_status, created_at
       FROM paper_log ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  const shadow = await pool.query(
    `SELECT market_id, action, forecast_p, size, fill_status, created_at
       FROM shadow_log ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  const rows: LogRow[] = [];
  for (const r of paper.rows) {
    rows.push({
      market_id: r["market_id"],
      action: r["action"],
      forecast_p: r["forecast_p"],
      size: r["size"],
      fill_status: r["fill_status"],
      created_at: r["created_at"],
      source: "PAPER",
    });
  }
  for (const r of shadow.rows) {
    rows.push({
      market_id: r["market_id"],
      action: r["action"],
      forecast_p: r["forecast_p"],
      size: r["size"],
      fill_status: r["fill_status"],
      created_at: r["created_at"],
      source: "SHADOW",
    });
  }
  rows.sort((a, b) => {
    const ta = a.created_at instanceof Date ? a.created_at.getTime() : 0;
    const tb = b.created_at instanceof Date ? b.created_at.getTime() : 0;
    const sa = typeof a.created_at === "string" ? Date.parse(a.created_at) : 0;
    const sb = typeof b.created_at === "string" ? Date.parse(b.created_at) : 0;
    return (tb || sb) - (ta || sa);
  });
  return rows.slice(0, limit);
}

async function latestForecast(
  pool: QueryablePool,
  marketId: string,
): Promise<Record<string, unknown> | null> {
  const res = await pool.query(
    `SELECT market_id, probability_yes, confidence, model, abstain_reason,
            assumptions, lineage, created_at
       FROM forecasts WHERE market_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [marketId],
  );
  const row = res.rows[0];
  return row ?? null;
}

/**
 * Extract the AI's stated reasoning from a forecast row: lineage JSON first
 * (written by step-persistence), assumptions[] as fallback. Pure display —
 * missing reasoning renders nothing instead of fabrications.
 */
function reasoningLines(f: Record<string, unknown>): string[] {
  let rationale: string | null = null;
  let factors: string[] = [];
  const rawLineage = f["lineage"];
  let lin: Record<string, unknown> | null = null;
  if (typeof rawLineage === "string" && rawLineage.length > 0) {
    try {
      lin = JSON.parse(rawLineage) as Record<string, unknown>;
    } catch {
      lin = null; // corrupt lineage: fall through to assumptions
    }
  } else if (typeof rawLineage === "object" && rawLineage !== null) {
    // pg returns JSONB columns pre-parsed as objects
    lin = rawLineage as Record<string, unknown>;
  }
  if (lin) {
    if (typeof lin["rationale"] === "string" && lin["rationale"].length > 0) {
      rationale = lin["rationale"];
    }
    if (Array.isArray(lin["factors"])) {
      factors = lin["factors"].filter(
        (x): x is string => typeof x === "string" && x.length > 0,
      );
    }
  }
  if (!rationale && Array.isArray(f["assumptions"])) {
    const first = (f["assumptions"] as unknown[])[0];
    if (typeof first === "string" && first.length > 0) rationale = first;
  }
  const lines: string[] = [];
  if (rationale) lines.push(`  │ AI reasoning: ${rationale}`);
  for (const factor of factors.slice(0, 3)) {
    lines.push(`  │   · ${factor}`);
  }
  return lines;
}

async function latestRiskDecision(
  pool: QueryablePool,
): Promise<Record<string, unknown> | null> {
  const res = await pool.query(
    `SELECT r.status, r.rejection_reason, r.edge_after_fees, r.ev_per_share,
            r.decided_at, t.market_id, t.side, t.price, t.size
       FROM risk_decisions r LEFT JOIN trade_intents t ON t.id = r.intent_id
      ORDER BY r.decided_at DESC LIMIT 1`,
    [],
  );
  const row = res.rows[0];
  return row ?? null;
}

/**
 * Build a human-readable decision-chain explanation for the latest `limit`
 * simulated decisions. Returns printable text (never throws for empty data;
 * transport errors propagate).
 */
export async function explainLastDecision(
  pool: QueryablePool,
  limit = 1,
): Promise<string> {
  const safeLimit =
    Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 20) : 1;
  const decisions = await latestDecisions(pool, safeLimit);
  if (decisions.length === 0) {
    return (
      "🔍 Decision Explanation\n\n" +
      "No decisions recorded yet. Start the agent first:\n" +
      "  polyroot run --once   (single cycle)\n" +
      "  polyroot run          (continuous loop)\n"
    );
  }
  const lines: string[] = ["🔍 Decision Explanation"];
  let idx = 0;
  for (const d of decisions) {
    idx += 1;
    const marketId = str(d.market_id);
    const action = str(d.action);
    const icon = action === "BUY" ? "🟢" : action === "SELL" ? "🔴" : "⏭️";
    lines.push("");
    lines.push(
      `${decisions.length > 1 ? `#${idx} ` : ""}${icon} ${action} — ${marketId} [${d.source}]`,
    );
    lines.push(
      `  Forecast p(YES): ${str(d.forecast_p)}   Size: ${str(d.size)}`,
    );
    lines.push(`  Fill: ${str(d.fill_status)}   At: ${str(d.created_at)}`);

    if (marketId !== "—") {
      const f = await latestForecast(pool, marketId);
      lines.push("");
      lines.push("  ┌─ FORECAST ─────────────────────────────");
      if (f) {
        lines.push(`  │ Model: ${str(f["model"])}`);
        lines.push(
          `  │ p(YES): ${str(f["probability_yes"])} (${pct(f["probability_yes"])})  Confidence: ${str(f["confidence"])}`,
        );
        const abstain = str(f["abstain_reason"]);
        if (abstain !== "—") lines.push(`  │ Abstain reason: ${abstain}`);
        for (const line of reasoningLines(f)) lines.push(line);
      } else {
        lines.push("  │ No forecast row for this market (abstained upstream).");
      }
    }

    const r = await latestRiskDecision(pool);
    lines.push("  ┌─ RISK ENGINE ──────────────────────────");
    if (r) {
      lines.push(`  │ Status: ${str(r["status"])}`);
      const rej = str(r["rejection_reason"]);
      if (rej !== "—") lines.push(`  │ Rejection: ${rej}`);
      lines.push(`  │ Edge after fees: ${usd(r["edge_after_fees"])}`);
      lines.push(`  │ EV/share: ${usd(r["ev_per_share"])}`);
      const side = str(r["side"]);
      if (side !== "—") {
        lines.push(
          `  │ Intent: ${side} ${str(r["size"])} @ ${str(r["price"])} (${str(r["market_id"])})`,
        );
      }
    } else {
      lines.push("  │ No risk-decision row recorded yet.");
    }

    lines.push("  └─ FINAL DECISION ───────────────────────");
    lines.push(
      action === "NO_TRADE" || action === "ABSTAIN"
        ? `     ⏭️ ${action} — AI tidak yakin atau edge tidak cukup, jadi diam (aman).`
        : `     ${icon} ${action} ${str(d.size)} @ fill ${str(d.fill_status)}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
