/**
 * @polyroot/observability — Telegram Agent Stream Emitter (PM-OBS-01)
 *
 * Human-readable real-time stream of the agent's live decision loop.
 * Every G4 stage is surfaced so the owner can watch the AI research,
 * forecast, reason, get risk-gated, and (in SHADOW) simulate execution.
 *
 * Design rules:
 *  - Fail-closed but non-blocking: a Bot API failure never touches the loop.
 *  - Structured, not raw: metadata renders as aligned field lines, never JSON.
 *  - Markdown-safe: every interpolated value is escaped for Telegram's
 *    legacy Markdown parser so a hostile market title can never break format.
 */

export type AgentStreamEventType =
  | "RESEARCH_INGEST"
  | "EVIDENCE_WEIGHT"
  | "UNIVERSE_SCAN"
  | "FORECAST_READY"
  | "REASONING_LOG"
  | "RISK_GATE"
  | "ORDER_SUBMIT"
  | "ORDER_FILL"
  | "NO_TRADE"
  | "PASS_DIGEST"
  | "MARKET_REPORT"
  | "ERROR";

export interface AgentStreamEvent {
  eventId: string;
  timestamp: Date;
  type: AgentStreamEventType;
  marketId?: string;
  title?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

interface EventStyle {
  icon: string;
  stage: string;
}

const EVENT_STYLE: Record<AgentStreamEventType, EventStyle> = {
  RESEARCH_INGEST: { icon: "🔍", stage: "RESEARCH" },
  EVIDENCE_WEIGHT: { icon: "⚖️", stage: "INTEL WEIGHT" },
  UNIVERSE_SCAN: { icon: "🌐", stage: "UNIVERSE SCAN" },
  FORECAST_READY: { icon: "📊", stage: "FORECAST" },
  REASONING_LOG: { icon: "💡", stage: "REASONING" },
  RISK_GATE: { icon: "🛡️", stage: "RISK GATE" },
  ORDER_SUBMIT: { icon: "🚀", stage: "SUBMIT" },
  ORDER_FILL: { icon: "✅", stage: "FILL" },
  NO_TRADE: { icon: "🛑", stage: "NO TRADE" },
  PASS_DIGEST: { icon: "🌐", stage: "PASS" },
  MARKET_REPORT: { icon: "🧠", stage: "MARKET" },
  ERROR: { icon: "❌", stage: "ERROR" },
};

/** Metadata keys that read better as a labelled value than a raw dump. */
const FIELD_LABELS: Record<string, string> = {
  probability: "Probability",
  ask: "Ask",
  bid: "Bid",
  spread: "Spread",
  edge: "Edge",
  decision: "Decision",
  reason: "Reason",
  fillStatus: "Fill status",
  fillPrice: "Fill price",
  filledSize: "Filled size",
  mode: "Mode",
  venue: "Venue",
  from: "From",
  to: "To",
  context: "Context",
};

/** Escape Telegram legacy-Markdown control characters in an untrusted value. */
function mdEscape(value: string): string {
  return value.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/** Max Bot API sends per rolling minute; overflow is dropped, never queued. */
const STREAM_MAX_PER_MINUTE = 30;

/**
 * Scrub credential-shaped material from ANY outbound text. Market titles and
 * metadata are untrusted input — a hostile value must never exfiltrate a key
 * into the owner's chat history (or any screenshot of it).
 */
function redactSecrets(text: string): string {
  let out = text;
  out = out.replace(/0x[0-9a-fA-F]{64}/g, "0x…[redacted]");
  out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-…[redacted]");
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted-block]",
  );
  out = out.replace(
    /(["']?(?:api[_-]?key|secret|passphrase|mnemonic)["']?\s*[:=]\s*)\S+/gi,
    "$1[redacted]",
  );
  return out;
}

/** Render a metadata value as a single-line, human-readable cell. */
function renderValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // 4-decimal display for probabilities/prices, integers stay bare.
    return Number.isInteger(value) ? String(value) : value.toFixed(4);
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value.length > 0 ? value : null;
  return null;
}

export class TelegramStreamEmitter {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly enabled: boolean;
  private readonly parseMode: "Markdown" | "HTML";
  /** Consecutive failures; used to back off without ever throwing. */
  private failureStreak = 0;
  /** Rolling send timestamps for the per-minute rate cap. */
  private readonly sentAt: number[] = [];
  /** Last time a throttle drop was logged (log at most once per minute). */
  private throttledLoggedAt = 0;

  constructor(botToken?: string, chatId?: string) {
    this.botToken = botToken || process.env["TELEGRAM_BOT_TOKEN"] || "";
    this.chatId = chatId || process.env["TELEGRAM_CHAT_ID"] || "";
    this.enabled = Boolean(this.botToken && this.chatId);
    this.parseMode = "HTML";
  }

  /** Check if the emitter is configured and enabled. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Escape for the active parse mode. */
  private esc(value: string): string {
    return this.parseMode === "HTML"
      ? value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      : mdEscape(value);
  }

  /**
   * Format an event into a compact, aligned Telegram message.
   * Header carries stage + wall-clock time; the body carries the human
   * sentence; the footer carries structured fields as label/value lines.
   */
  formatMessage(event: AgentStreamEvent): string {
    const style = EVENT_STYLE[event.type] ?? { icon: "ℹ️", stage: event.type };
    const clock = event.timestamp.toISOString().slice(11, 19);

    const lines: string[] = [];
    lines.push(
      `${style.icon} <b>${this.esc(style.stage)}</b> <code>${clock} UTC</code>`,
    );

    if (event.title) {
      lines.push(`<i>${this.esc(redactSecrets(event.title))}</i>`);
    }

    lines.push("");
    lines.push(this.esc(redactSecrets(event.message)));

    // Structured footer: one label/value line per field, never a JSON blob.
    if (event.metadata) {
      const fields: string[] = [];
      for (const [key, raw] of Object.entries(event.metadata)) {
        const rendered = renderValue(raw);
        if (rendered === null) continue;
        const label = FIELD_LABELS[key] ?? key;
        fields.push(
          `• <b>${this.esc(label)}</b>: ${this.esc(redactSecrets(rendered))}`,
        );
      }
      if (fields.length > 0) {
        lines.push("");
        lines.push(...fields);
      }
    }

    if (event.marketId) {
      const short =
        event.marketId.length > 16
          ? `${event.marketId.slice(0, 8)}…${event.marketId.slice(-6)}`
          : event.marketId;
      lines.push("");
      lines.push(`<code>${this.esc(redactSecrets(short))}</code>`);
    }

    return lines.join("\n");
  }

  /**
   * Push event to Telegram via Bot API. Never throws: on repeated failure the
   * emitter degrades to a local log so the trading loop stays untouched.
   */
  async emit(event: AgentStreamEvent): Promise<boolean> {
    if (!this.enabled) {
      console.log(
        `[agent-stream] ${event.type} ${event.marketId ?? ""} — ${event.message}`,
      );
      return false;
    }

    // Rate cap: a hot loop must never flood the owner's chat. Overflow is
    // dropped (never queued — a stale backlog is worse than a gap).
    const now = Date.now();
    while (
      this.sentAt.length > 0 &&
      (this.sentAt[0] as number) <= now - 60000
    ) {
      this.sentAt.shift();
    }
    if (this.sentAt.length >= STREAM_MAX_PER_MINUTE) {
      if (now - this.throttledLoggedAt > 60000) {
        this.throttledLoggedAt = now;
        console.log(
          `[agent-stream] throttled: dropped ${event.type} (cap ${STREAM_MAX_PER_MINUTE}/min)`,
        );
      }
      return false;
    }
    this.sentAt.push(now);

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: this.formatMessage(event),
          parse_mode: this.parseMode,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        this.failureStreak = 0;
        return true;
      }

      this.failureStreak += 1;
      // 429/5xx are transient: log once per streak, never spam the loop.
      if (this.failureStreak <= 3 || this.failureStreak % 50 === 0) {
        console.error(
          `[agent-stream] Telegram rejected ${event.type} (HTTP ${response.status}), ` +
            `streak=${this.failureStreak}`,
        );
      }
      return false;
    } catch (err) {
      this.failureStreak += 1;
      if (this.failureStreak <= 3 || this.failureStreak % 50 === 0) {
        console.error(
          `[agent-stream] Telegram unreachable for ${event.type}:`,
          (err as Error).message,
        );
      }
      return false;
    }
  }
}

/** Global singleton instance for the agent stream. */
let globalEmitter: TelegramStreamEmitter | null = null;

export function getTelegramEmitter(): TelegramStreamEmitter {
  if (!globalEmitter) {
    globalEmitter = new TelegramStreamEmitter();
  }
  return globalEmitter;
}

export function confidenceOf(p: number): number {
  // Derived certainty, NOT a model self-report (profit-contract rule).
  return Math.min(Math.max(2 * Math.abs(p - 0.5), 0), 1);
}

export function formatPassDigest(input: {
  mode: string;
  clock: string;
  scanned: number;
  evaluating: Array<{ id: string; question: string }>;
  deferredCount: number;
}): string {
  const lines = [
    `🌐 PASS [${input.mode}] ${input.clock}`,
    `Scanned ${input.scanned} → evaluating ${input.evaluating.length}, deferred ${input.deferredCount}`,
  ];
  for (const m of input.evaluating.slice(0, 5)) {
    const name = m.question.length > 0 ? m.question : m.id;
    lines.push(`• "${name}" — evaluating`);
  }
  if (input.deferredCount > 0) {
    lines.push(
      `• ${input.deferredCount} more deferred (ranked below this pass's top-K cut)`,
    );
  }
  return lines.join("\n");
}

export function formatMarketReport(input: {
  question: string;
  bid: number;
  ask: number;
  spread: number;
  volume24h?: number;
  pYes: number | null;
  confidence: number;
  rationale: string;
  factors: string[];
  decision: "TRADE" | "NO_TRADE";
  reason: string;
  edgePct: number;
  floorPct: number;
  sizeShares: number;
  notionalUsd: number;
  bankrollUsd: number | null;
  exposureUsd: number | null;
}): string {
  // Unknown money renders as "—": never fabricate $0 for a missing ledger.
  const money = (v: number | null): string =>
    v === null ? "—" : `$${v.toFixed(2)}`;
  const head = input.question.length > 0 ? input.question : "Untitled market";
  const lines = [
    `🧠 "${head}"`,
    `Book: YES ${(input.bid * 100).toFixed(1)}¢ / NO ${((1 - input.ask) * 100).toFixed(1)}¢ · spread ${(input.spread * 100).toFixed(1)}¢` +
      (input.volume24h !== undefined
        ? ` · 24h vol $${Math.round(input.volume24h).toLocaleString("en-US")}`
        : ""),
  ];
  if (input.pYes === null) {
    lines.push(`AI: abstained — ${input.reason}`);
  } else {
    lines.push(
      `AI: p(YES) ${(input.pYes * 100).toFixed(1)}% (confidence ${(input.confidence * 100).toFixed(0)}%)`,
      `Reasoning: "${input.rationale.length > 0 ? input.rationale : "no rationale recorded"}"`,
    );
    if (input.factors.length > 0) {
      lines.push(
        `Factors: ${input.factors
          .slice(0, 3)
          .map((f) => `• ${f}`)
          .join(" ")}`,
      );
    }
  }
  lines.push("---");
  if (input.decision === "TRADE") {
    lines.push(
      `🚀 TRADE: ${input.sizeShares} shares ≈ $${input.notionalUsd.toFixed(2)}`,
      `"${head}"`,
      `Edge +${input.edgePct.toFixed(1)}% > floor +${input.floorPct.toFixed(1)}%`,
      `Bankroll ${money(input.bankrollUsd)} · exposure ${money(input.exposureUsd)}`,
    );
  } else {
    lines.push(
      `🛡️ DECISION: ⏭️ NO_TRADE`,
      `Why not: ${input.reason}`,
      `At stake: $${input.notionalUsd.toFixed(2)} (held)`,
    );
  }
  return lines.join("\n");
}

export class ReportDedupe {
  private readonly lastReason = new Map<string, string>();
  shouldSend(marketId: string, reasonKey: string): boolean {
    const prev = this.lastReason.get(marketId);
    if (prev === reasonKey) return false;
    this.lastReason.set(marketId, reasonKey);
    return true;
  }
}
