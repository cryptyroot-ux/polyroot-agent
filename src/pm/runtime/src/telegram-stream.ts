/**
 * @polyroot/runtime — Telegram Real-Time Streaming Emitter.
 *
 * Streams the full AI agent cycle to the owner's Telegram DM:
 *   RESEARCH → FORECASTING → RISK → EXECUTION
 *
 * Uses markdown + emojis for visual categorization. Rate-limited
 * to avoid spam (max 1 message per 2s per phase, 30/min total).
 */

import { type BotApi, createBotApi, redactSecrets } from "./telegram.js";

export type StreamPhase = "research" | "forecasting" | "risk" | "execution" | "system";

export interface StreamEvent {
  phase: StreamPhase;
  marketId?: string;
  title: string;
  body: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}

export interface StreamEmitter {
  emit(event: StreamEvent): Promise<void>;
  emitResearch(data: ResearchEvent): Promise<void>;
  emitForecasting(data: ForecastingEvent): Promise<void>;
  emitRisk(data: RiskEvent): Promise<void>;
  emitExecution(data: ExecutionEvent): Promise<void>;
  emitSystem(data: SystemEvent): Promise<void>;
}

export interface ResearchEvent {
  marketId: string;
  question?: string;
  sourcesFound: number;
  primarySources: number;
  syndicatedSources: number;
  evidenceWeight: number;
  consensus: "bullish" | "bearish" | "neutral";
  universeScanned: number;
  universeQualified: number;
  universeDropped: number;
  dropReasons?: string[];
  [key: string]: unknown;
}

export interface ForecastingEvent {
  marketId: string;
  question?: string;
  modelLineage: string;
  pYes: number | null;
  pNo: number | null;
  edge: number;
  bookBid: number;
  bookAsk: number;
  spread: number;
  rationale: string;
  factors: string[];
  confidence: number;
  abstainReason?: string | undefined;
  [key: string]: unknown;
}

export interface RiskEvent {
  marketId: string;
  decision: "TRADE" | "NO_TRADE";
  reason: string;
  edge: number;
  minEdge: number;
  kellyFraction: number;
  size: number;
  bankrollUsd: number;
  exposureUsd: number;
  permitId?: string;
  [key: string]: unknown;
}

export interface ExecutionEvent {
  marketId: string;
  action: "SUBMIT" | "ACKNOWLEDGED" | "FILLED" | "REJECTED" | "CANCELLED";
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  orderId?: string;
  status: string;
  fillPrice?: number;
  [key: string]: unknown;
}

export interface SystemEvent {
  type: "mode_change" | "halt" | "error" | "startup" | "health" | "telegram";
  message: string;
  severity: "info" | "warning" | "critical";
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

const PHASE_EMOJIS: Record<StreamPhase, string> = {
  research: "🔍",
  forecasting: "🧠",
  risk: "🛡️",
  execution: "🚀",
  system: "⚙️",
};

const PHASE_LABELS: Record<StreamPhase, string> = {
  research: "RESEARCH",
  forecasting: "FORECASTING",
  risk: "RISK GATE",
  execution: "EXECUTION",
  system: "SYSTEM",
};

const SEVERITY_EMOJIS = {
  info: "ℹ️",
  warning: "⚠️",
  critical: "🔴",
};

class RateLimiter {
  private hits: number[] = [];
  private phaseHits = new Map<string, number[]>();

  constructor(
    private readonly perMinute = 30,
    private readonly perPhasePerMinute = 15,
  ) {}

  allow(phase: string, nowMs = Date.now()): boolean {
    const window = nowMs - 60_000;

    this.hits = this.hits.filter((t) => t > window);
    if (this.hits.length >= this.perMinute) return false;

    const phaseHits = this.phaseHits.get(phase) ?? [];
    const recent = phaseHits.filter((t) => t > window);
    if (recent.length >= this.perPhasePerMinute) return false;

    this.hits.push(nowMs);
    this.phaseHits.set(phase, [...recent, nowMs]);
    return true;
  }
}

function formatResearch(e: ResearchEvent): string {
  const lines = [
    `**Market:** \`${e.marketId}\` ${e.question ? `(${e.question.slice(0, 60)})` : ""}`,
    `**Sources:** ${e.sourcesFound} total · ${e.primarySources} primary · ${e.syndicatedSources} syndicated`,
    `**Evidence Weight:** ${e.evidenceWeight.toFixed(2)} | **Consensus:** ${e.consensus.toUpperCase()}`,
    `**Universe:** ${e.universeScanned} scanned → ${e.universeQualified} qualified · ${e.universeDropped} dropped`,
  ];
  if (e.dropReasons && e.dropReasons.length > 0) {
    lines.push(`**Drop Reasons:** ${e.dropReasons.slice(0, 3).join(", ")}`);
  }
  return lines.join("\n");
}

function formatForecasting(e: ForecastingEvent): string {
  const lines = [
    `**Market:** \`${e.marketId}\` ${e.question ? `(${e.question.slice(0, 60)})` : ""}`,
    `**Model Lineage:** \`${e.modelLineage}\``,
  ];
  if (e.pYes !== null) {
    lines.push(
      `**p(YES):** ${(e.pYes * 100).toFixed(1)}% | **p(NO):** ${(e.pNo! * 100).toFixed(1)}%`,
      `**Edge:** ${(e.edge * 100).toFixed(2)}% | **Book:** ${e.bookBid.toFixed(3)}/${e.bookAsk.toFixed(3)} | **Spread:** ${(e.spread * 100).toFixed(1)}¢`,
      `**Confidence:** ${(e.confidence * 100).toFixed(0)}%`,
    );
  } else {
    lines.push(`**Status:** ABSTAINED — ${e.abstainReason ?? "unknown"}`);
  }
  if (e.rationale) {
    lines.push(`**Reasoning:** ${e.rationale.slice(0, 200)}`);
  }
  if (e.factors && e.factors.length > 0) {
    lines.push(`**Factors:** ${e.factors.slice(0, 3).map(f => `• ${f}`).join("\n")}`);
  }
  return lines.join("\n");
}

function formatRisk(e: RiskEvent): string {
  const emoji = e.decision === "TRADE" ? "✅" : "⏭️";
  const lines = [
    `**Market:** \`${e.marketId}\``,
    `**Decision:** ${emoji} ${e.decision} — ${e.reason}`,
    `**Edge:** ${(e.edge * 100).toFixed(2)}% (min ${(e.minEdge * 100).toFixed(2)}%) | **Kelly:** ${(e.kellyFraction * 100).toFixed(0)}%`,
    `**Size:** ${e.size} shares | **Bankroll:** $${e.bankrollUsd.toFixed(2)} | **Exposure:** $${e.exposureUsd.toFixed(2)}`,
  ];
  if (e.permitId) lines.push(`**Permit:** \`${e.permitId}\``);
  return lines.join("\n");
}

function formatExecution(e: ExecutionEvent): string {
  const statusEmoji: Record<string, string> = {
    SUBMIT: "📤",
    ACKNOWLEDGED: "✅",
    FILLED: "🎯",
    REJECTED: "❌",
    CANCELLED: "🚫",
  };
  const emoji = statusEmoji[e.action] ?? "📋";
  const lines = [
    `**Market:** \`${e.marketId}\``,
    `**Action:** ${emoji} ${e.action} ${e.side} ${e.shares} shares @ ${e.price.toFixed(4)}`,
    `**Status:** ${e.status}`,
  ];
  if (e.orderId) lines.push(`**Order ID:** \`${e.orderId}\``);
  if (e.fillPrice !== undefined) lines.push(`**Fill Price:** ${e.fillPrice.toFixed(4)}`);
  return lines.join("\n");
}

function formatSystem(e: SystemEvent): string {
  const emoji = SEVERITY_EMOJIS[e.severity];
  const lines = [
    `**Type:** ${e.type.toUpperCase().replace("_", " ")}`,
    `**Message:** ${e.message}`,
  ];
  if (e.details) {
    lines.push(`**Details:** \`${JSON.stringify(e.details).slice(0, 200)}\``);
  }
  return lines.join("\n");
}

function formatEvent(e: StreamEvent): string {
  const header = `${PHASE_EMOJIS[e.phase]} **${PHASE_LABELS[e.phase]}** ${new Date(e.timestamp).toLocaleTimeString()}`;
  let body: string;
  switch (e.phase) {
    case "research": body = formatResearch(e.meta as ResearchEvent); break;
    case "forecasting": body = formatForecasting(e.meta as ForecastingEvent); break;
    case "risk": body = formatRisk(e.meta as RiskEvent); break;
    case "execution": body = formatExecution(e.meta as ExecutionEvent); break;
    case "system": body = formatSystem(e.meta as SystemEvent); break;
    default: body = e.body;
  }
  return `${header}\n${body}`;
}

export function createTelegramStreamEmitter(
  token: string,
  ownerId: string,
  apiBase = "https://api.telegram.org",
): StreamEmitter {
  const api = createBotApi(token, apiBase);
  const chatId = ownerId;
  const limiter = new RateLimiter();

  async function send(text: string): Promise<void> {
    const clean = redactSecrets(text);
    const parts = chunkMessage(clean);
    for (const part of parts) {
      try {
        await api.call("sendMessage", {
          chat_id: chatId,
          text: part,
          parse_mode: "Markdown",
        });
      } catch (err) {
        console.error("Telegram stream send failed:", err);
      }
    }
  }

  async function emit(event: StreamEvent): Promise<void> {
    if (!limiter.allow(event.phase)) return;
    const formatted = formatEvent(event);
    await send(formatted);
  }

  return {
    async emit(event: StreamEvent): Promise<void> {
      await emit(event);
    },
    async emitResearch(data: ResearchEvent): Promise<void> {
      await emit({ phase: "research", marketId: data.marketId, title: "Research Complete", body: "", timestamp: Date.now(), meta: data });
    },
    async emitForecasting(data: ForecastingEvent): Promise<void> {
      await emit({ phase: "forecasting", marketId: data.marketId, title: "Forecast Ready", body: "", timestamp: Date.now(), meta: data });
    },
    async emitRisk(data: RiskEvent): Promise<void> {
      await emit({ phase: "risk", marketId: data.marketId, title: "Risk Decision", body: "", timestamp: Date.now(), meta: data });
    },
    async emitExecution(data: ExecutionEvent): Promise<void> {
      await emit({ phase: "execution", marketId: data.marketId, title: "Execution", body: "", timestamp: Date.now(), meta: data });
    },
    async emitSystem(data: SystemEvent): Promise<void> {
      await emit({ phase: "system", title: "System Event", body: "", timestamp: Date.now(), meta: data });
    },
  };
}

function chunkMessage(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  const lines = text.split("\n");
  let cur = "";
  for (const line of lines) {
    if ((cur + "\n" + line).length > limit && cur) {
      parts.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) parts.push(cur);
  return parts.length > 0 ? parts : [text.slice(0, limit)];
}

export class NullStreamEmitter implements StreamEmitter {
  async emit(): Promise<void> {}
  async emitResearch(): Promise<void> {}
  async emitForecasting(): Promise<void> {}
  async emitRisk(): Promise<void> {}
  async emitExecution(): Promise<void> {}
  async emitSystem(): Promise<void> {}
}

export function createNullStreamEmitter(): StreamEmitter {
  return new NullStreamEmitter();
}

export { createStreamingObservability } from "./streaming-observability.js";
export { createIntelligenceStreamHooks } from "./streaming-observability.js";
export type { StreamingObservabilityConfig, IntelligenceStreamHooks } from "./streaming-observability.js";