/**
 * @polyroot/runtime — Strategic market intelligence for `polyroot insight`.
 *
 * Read-only: SELECTs only. Scoring is transparent and documented below so an
 * operator can reproduce any number by hand:
 *
 *   edge       = max(p - yes_price, (1 - p) - no_price)   // best side, fees ignored
 *   edgeNorm   = clamp(edge, 0, 0.10) / 0.10              // 10%+ edge saturates
 *   liquidity  = min(1, log10(1 + volume24h) / 6)         // $1M+ saturates
 *   score      = round(100 * (0.55*edgeNorm + 0.25*confidence + 0.20*liquidity))
 *
 * Labels: score >= 65 → BUY 🟢, >= 40 → WATCH 🟡, else AVOID 🔴.
 * Risk comes from spread only: <= 0.02 Low, <= 0.06 Med, else High.
 */

import type { QueryablePool } from "../mode-watcher.js";

export interface ScoredMarket {
  marketId: string;
  question: string;
  score: number;
  label: "BUY" | "WATCH" | "AVOID";
  icon: "🟢" | "🟡" | "🔴";
  probYes: number | null;
  edgePct: number | null;
  risk: "Low" | "Med" | "High";
  volume24h: number | null;
}

function num(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

function scoreOne(
  yes: number | null,
  no: number | null,
  p: number | null,
  confidence: number | null,
  spread: number | null,
  volume24h: number | null,
): { score: number; edge: number | null; risk: ScoredMarket["risk"] } {
  const risk: ScoredMarket["risk"] =
    spread === null
      ? "High"
      : spread <= 0.02
        ? "Low"
        : spread <= 0.06
          ? "Med"
          : "High";
  if (yes === null || p === null) return { score: 0, edge: null, risk };
  const noPrice = no ?? 1 - yes;
  const edge = Math.max(p - yes, 1 - p - noPrice);
  const edgeNorm = clamp(edge, 0, 0.1) / 0.1;
  const conf = clamp(confidence ?? 0.5, 0, 1);
  const liq =
    volume24h === null ? 0 : clamp(Math.log10(1 + volume24h) / 6, 0, 1);
  const score = Math.round(100 * (0.55 * edgeNorm + 0.25 * conf + 0.2 * liq));
  return { score, edge, risk };
}

/** Top-N markets by opportunity score, highest first. */
export async function topOpportunities(
  pool: QueryablePool,
  limit = 10,
): Promise<ScoredMarket[]> {
  const safeLimit =
    Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 20) : 10;
  const res = await pool.query(
    `SELECT s.market_id, m.question, s.yes_price, s.no_price, s.spread,
            s.volume_24h, f.probability_yes, f.confidence
       FROM (SELECT DISTINCT ON (market_id) market_id, yes_price, no_price,
                    spread, volume_24h
               FROM market_snapshots ORDER BY market_id, captured_at DESC) s
       LEFT JOIN markets m ON m.id = s.market_id
       LEFT JOIN (SELECT DISTINCT ON (market_id) market_id, probability_yes,
                         confidence
                    FROM forecasts ORDER BY market_id, created_at DESC) f
         ON f.market_id = s.market_id
      ORDER BY s.volume_24h DESC NULLS LAST LIMIT $1`,
    [safeLimit * 3],
  );
  const out: ScoredMarket[] = [];
  for (const r of res.rows) {
    const marketId = typeof r["market_id"] === "string" ? r["market_id"] : "—";
    const q =
      typeof r["question"] === "string" && r["question"].length > 0
        ? (r["question"] as string)
        : marketId;
    const { score, edge, risk } = scoreOne(
      num(r["yes_price"]),
      num(r["no_price"]),
      num(r["probability_yes"]),
      num(r["confidence"]),
      num(r["spread"]),
      num(r["volume_24h"]),
    );
    const label = score >= 65 ? "BUY" : score >= 40 ? "WATCH" : "AVOID";
    out.push({
      marketId,
      question: q.length > 42 ? `${q.slice(0, 41)}…` : q,
      score,
      label,
      icon: label === "BUY" ? "🟢" : label === "WATCH" ? "🟡" : "🔴",
      probYes: num(r["probability_yes"]),
      edgePct: edge === null ? null : Math.round(edge * 1000) / 10,
      risk,
      volume24h: num(r["volume_24h"]),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, safeLimit);
}

/** Deep dive for one market: snapshot + forecast + recent decisions. */
export async function marketDeepDive(
  pool: QueryablePool,
  marketId: string,
): Promise<string> {
  const snap = await pool.query(
    `SELECT market_id, yes_price, no_price, spread, volume_24h, captured_at
       FROM market_snapshots WHERE market_id = $1
      ORDER BY captured_at DESC LIMIT 1`,
    [marketId],
  );
  const fc = await pool.query(
    `SELECT probability_yes, confidence, model, abstain_reason, created_at
       FROM forecasts WHERE market_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [marketId],
  );
  const risks = await pool.query(
    `SELECT r.status, r.rejection_reason, r.edge_after_fees, r.decided_at
       FROM risk_decisions r LEFT JOIN trade_intents t ON t.id = r.intent_id
      WHERE t.market_id = $1 OR r.decision_id = $1
      ORDER BY r.decided_at DESC LIMIT 5`,
    [marketId],
  );
  const lines = [`🔎 Deep dive: ${marketId}`, ""];
  const s = snap.rows[0];
  if (!s) {
    lines.push("No snapshots for this market yet.");
    lines.push("Run the agent first (polyroot run --once), then retry.");
    return lines.join("\n");
  }
  const str = (v: unknown): string =>
    typeof v === "string" && v.length > 0 ? v : String(v ?? "—");
  lines.push(
    `Book: YES ${str(s["yes_price"])} / NO ${str(s["no_price"])}  Spread: ${str(s["spread"])}`,
  );
  lines.push(
    `24h vol: ${str(s["volume_24h"])}  Captured: ${str(s["captured_at"])}`,
  );
  const f = fc.rows[0];
  lines.push("");
  lines.push(
    f
      ? `AI: p(YES)=${str(f["probability_yes"])} conf=${str(f["confidence"])} model=${str(f["model"])}`
      : "AI: no forecast yet for this market.",
  );
  if (
    f &&
    typeof f["abstain_reason"] === "string" &&
    (f["abstain_reason"] as string).length > 0
  ) {
    lines.push(`Abstain: ${f["abstain_reason"] as string}`);
  }
  lines.push("");
  lines.push("Recent risk decisions:");
  if (risks.rows.length === 0) {
    lines.push("  (none yet)");
  }
  for (const r of risks.rows.slice(0, 5)) {
    lines.push(
      `  • ${str(r["status"])} edge=${str(r["edge_after_fees"])} — ${str(r["rejection_reason"])} (${str(r["decided_at"])})`,
    );
  }
  return lines.join("\n");
}

/** Render scored markets as a pretty emoji table (or JSON). */
export function formatInsight(rows: ScoredMarket[], asJson: boolean): string {
  if (asJson) return JSON.stringify({ ok: true, markets: rows }, null, 2);
  if (rows.length === 0) {
    return (
      "🧠 Strategic Insight\n\n" +
      "No market snapshots yet. Run the agent first:\n" +
      "  polyroot run --once\n"
    );
  }
  const lines = ["🧠 Strategic Insight (Top Opportunities)", ""];
  lines.push(" #  Score  Action  Edge     Risk  Market");
  lines.push(
    "─── ────── ─────── ──────── ───── ──────────────────────────────",
  );
  rows.forEach((m, i) => {
    const edge =
      m.edgePct === null
        ? "   —  "
        : `${m.edgePct >= 0 ? "+" : ""}${m.edgePct.toFixed(1)}% `;
    lines.push(
      `${String(i + 1).padStart(2)}  ${m.icon} ${String(m.score).padStart(3)}  ${m.label.padEnd(5)} ${edge} ${m.risk.padEnd(4)}  ${m.question}`,
    );
  });
  lines.push("");
  lines.push("Legend: 🟢 BUY (score≥65)  🟡 WATCH (≥40)  🔴 AVOID");
  lines.push("Score = edge×0.55 + confidence×0.25 + liquidity×0.20 (0–100)");
  return lines.join("\n");
}
