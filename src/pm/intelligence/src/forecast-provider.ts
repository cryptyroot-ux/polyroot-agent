/**
 * @polyroot/intelligence — Forecast provider wiring (PM-AI-02 portability).
 *
 * Replaces the historical hardcoded forecast stub in the runtime entrypoint.
 * Providers are thin I/O wrappers over OpenAI-compatible chat-completions
 * endpoints (OpenAI, 9Router, FreeLLMAPI). Any failure — network, timeout,
 * unparseable or out-of-range output — resolves to null (abstain/NO_TRADE),
 * never to a fabricated probability.
 */

import { normalizeOpenAICompatible, joinApiPath } from "./api-url.js";
import { DEFAULT_CODEX_BASE_URL } from "./codex-auth.js";

/** Market snapshot handed to a forecast provider. */
export interface ForecastInput {
  market_id: string;
  bid: number;
  ask: number;
  question?: string;
}

/** A pluggable probability source. Null means abstain. */
export interface ForecastProvider {
  readonly name: string;
  forecast(input: ForecastInput): Promise<number | null>;
  /** Optional rich reply (probability + stated reasoning). Absent on legacy providers. */
  forecastDetailed?(input: ForecastInput): Promise<DetailedForecast>;
}

/** Wiring for an OpenAI-compatible chat-completions provider. */
export interface OpenAICompatibleProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * Wire protocol: "chat" (default, /chat/completions) or "responses"
   * (/responses — Codex backend and Responses-API gateways).
   */
  requestStyle?: "chat" | "responses";
  /**
   * Dynamic auth headers (Codex OAuth: fresh Bearer + account per call).
   * When set, `apiKey` may be a placeholder — it is never sent.
   */
  authHeaders?: () => Promise<Record<string, string>>;
}

const FORECAST_SYSTEM_PROMPT =
  "You estimate prediction-market probabilities. Reply with JSON only, no other text: " +
  '{"p": <number 0..1 for YES>, "rationale": "<1-2 plain-English sentences: what you weighed and why>", ' +
  '"factors": ["<short factor 1>", "<short factor 2>"]}. ' +
  'If you cannot judge, still reply {"p": 0.5} with your honest rationale.';

/** Rich forecast: strict probability plus best-effort reasoning. */
export interface DetailedForecast {
  p: number | null;
  rationale: string | null;
  factors: string[];
}

/** Parse a detailed model reply. p follows the strict rules; reasoning degrades gracefully. */
export function parseDetailedForecast(text: string): DetailedForecast {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text)) as unknown;
  } catch {
    return { p: null, rationale: null, factors: [] };
  }
  const obj =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  if (!obj) return { p: null, rationale: null, factors: [] };
  const rawP = obj["p"];
  const p =
    typeof rawP === "number" && Number.isFinite(rawP) && rawP >= 0 && rawP <= 1
      ? rawP
      : null;
  const rawR = obj["rationale"];
  const rationale =
    typeof rawR === "string" && rawR.trim().length > 0
      ? rawR.trim().slice(0, 500)
      : null;
  const rawF = obj["factors"];
  const factors = Array.isArray(rawF)
    ? rawF
        .filter(
          (f): f is string => typeof f === "string" && f.trim().length > 0,
        )
        .slice(0, 3)
        .map((f) => f.trim().slice(0, 160))
    : [];
  return { p, rationale, factors };
}

/**
 * Build the per-step user prompt: book snapshot plus derived context the
 * model should weigh (midpoint fair value, spread cost, contestedness).
 * Pure and unit-tested — this IS the default PolyRoot forecaster prompt.
 */
export function buildForecastUserPrompt(input: ForecastInput): string {
  const mid = (input.bid + input.ask) / 2;
  const spread = Math.abs(input.ask - input.bid);
  const contested =
    Math.abs(mid - 0.5) < 0.1
      ? "contested (mid near 0.50 — coin flip zone, demand strong evidence)"
      : mid < 0.5
        ? "long-shot YES (cheap tickets, most expire worthless)"
        : "consensus YES (expensive tickets, small mispricings only)";
  return (
    `Market ${input.market_id}` +
    (input.question ? ` (${input.question})` : "") +
    ` — bid ${input.bid}, ask ${input.ask}.\n` +
    `Book context: midpoint ${mid.toFixed(4)} (unadjusted fair value), ` +
    `spread ${(spread * 100).toFixed(1)}¢ (round-trip cost you must beat), ` +
    `regime: ${contested}.\n` +
    `Weigh the spread as adverse selection: wide spread means the book ` +
    `knows something you do not. Probability of YES?`
  );
}

/** Parse model output into a probability, or null when unusable. */
export function parseForecastProbability(text: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const p =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)["p"]
      : undefined;
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
    return null;
  }
  return p;
}

/**
 * First balanced {...} object in free text (moved above class).
 */
export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const start = trimmed.indexOf("{");
  if (start < 0) return trimmed;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return trimmed;
}

/**
 * Read a completion body in ANY shape this repo speaks:
 * - chat JSON: `choices[0].message.content`
 * - chat SSE: `data:` chunks with `choices[0].delta.content`
 * - Responses JSON: `output_text`, or `output[]` message items with
 *   `output_text` content parts (reasoning items skipped)
 * - Responses SSE: `response.output_text.delta` events carrying `delta`
 * Returns the stitched assistant text, or null when unusable.
 * Pure over the body text — unit-tested without network.
 */
export function readCompletionContent(bodyText: string): string | null {
  const text = bodyText.trim();
  if (!text) return null;
  if (!text.startsWith("data:") && !text.includes("\ndata:")) {
    try {
      const data = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        output_text?: unknown;
        output?: Array<{
          type?: unknown;
          content?: Array<{ type?: unknown; text?: unknown }>;
        }>;
      };
      const chat = data.choices?.[0]?.message?.content;
      if (typeof chat === "string" && chat.trim()) return chat;
      if (typeof data.output_text === "string" && data.output_text.trim()) {
        return data.output_text;
      }
      if (Array.isArray(data.output)) {
        let stitched = "";
        for (const item of data.output) {
          if (item?.type !== "message" || !Array.isArray(item.content)) {
            continue;
          }
          for (const part of item.content) {
            if (part?.type === "output_text" && typeof part.text === "string") {
              stitched += part.text;
            }
          }
        }
        if (stitched.trim()) return stitched;
      }
      return null;
    } catch {
      return null;
    }
  }
  let stitched = "";
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const chunk = JSON.parse(payload) as {
        type?: unknown;
        delta?: unknown;
        choices?: Array<{
          delta?: { content?: unknown };
          message?: { content?: unknown };
        }>;
      };
      const c = chunk.choices?.[0];
      const piece =
        (typeof chunk.delta === "string" ? chunk.delta : undefined) ??
        c?.delta?.content ??
        c?.message?.content;
      if (typeof piece === "string") stitched += piece;
    } catch {
      // one malformed chunk never poisons the rest
    }
  }
  return stitched.trim() ? stitched : null;
}

/**
 * Live model catalog for any OpenAI-compatible endpoint: GET {base}/models
 * with the owner's key. Returns deduplicated model ids (possibly empty —
 * caller falls back to its curated list). Throws on transport/HTTP failure
 * so the caller can distinguish "offline" from "empty catalog".
 */
export async function fetchOpenAIModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`model catalog HTTP ${res.status}`);
    const data = (await res.json()) as {
      data?: Array<{ id?: unknown }>;
    };
    const ids = Array.isArray(data.data)
      ? data.data
          .map((m) => (typeof m?.id === "string" ? m.id : ""))
          .filter((id) => id.length > 0)
      : [];
    return [...new Set(ids)];
  } catch (err) {
    throw new Error(
      `model catalog unreachable (${(err as Error).message ?? err})`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export class OpenAICompatibleForecastProvider implements ForecastProvider {
  readonly name = "openai-compatible";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly requestStyle: "chat" | "responses";
  private readonly authHeaders?: () => Promise<Record<string, string>>;

  constructor(config: OpenAICompatibleProviderConfig) {
    if (!config.apiKey && !config.authHeaders) {
      throw new Error("FORECAST_CONFIG: apiKey or authHeaders required");
    }
    if (!config.model) throw new Error("FORECAST_CONFIG: model required");
    this.baseUrl = normalizeOpenAICompatible(config.baseUrl);
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 15000;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.requestStyle = config.requestStyle ?? "chat";
    if (config.authHeaders) this.authHeaders = config.authHeaders;
  }

  async forecast(input: ForecastInput): Promise<number | null> {
    return (await this.forecastDetailed(input)).p;
  }

  /** Full reply: probability plus the model's stated reasoning (nullable). */
  async forecastDetailed(input: ForecastInput): Promise<DetailedForecast> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const user = buildForecastUserPrompt(input);
      const headers: Record<string, string> = this.authHeaders
        ? await this.authHeaders()
        : { authorization: `Bearer ${this.apiKey}` };
      headers["content-type"] = "application/json";
      const isResponses = this.requestStyle === "responses";
      const res = await this.fetchImpl(
        joinApiPath(
          this.baseUrl,
          isResponses ? "responses" : "chat/completions",
        ),
        {
          method: "POST",
          headers,
          body: JSON.stringify(
            isResponses
              ? {
                  model: this.model,
                  store: false,
                  input: [
                    { role: "system", content: FORECAST_SYSTEM_PROMPT },
                    { role: "user", content: user },
                  ],
                }
              : {
                  model: this.model,
                  messages: [
                    { role: "system", content: FORECAST_SYSTEM_PROMPT },
                    { role: "user", content: user },
                  ],
                  temperature: 0,
                },
          ),
          signal: controller.signal,
        },
      );
      if (!res.ok) return { p: null, rationale: null, factors: [] };
      const content = readCompletionContent(await res.text());
      if (content === null) return { p: null, rationale: null, factors: [] };
      return parseDetailedForecast(content);
    } catch {
      return { p: null, rationale: null, factors: [] };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build a provider from env, or null when forecasting is not configured.
 * Provider names:
 * - "codex"  : ChatGPT subscription login (Codex OAuth). No API key.
 * - "9router": 9Router gateway (files.pango.fun/v1). Uses OPENAI_API_KEY.
 * - "openai" : Generic OpenAI-compatible endpoint. Uses OPENAI_API_KEY.
 *
 * Returns null for unknown/unsupported providers (fail-closed).
 */
export function createForecastProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ForecastProvider | null {
  const provider = (env["POLYROOT_FORECAST_PROVIDER"] ?? "none").toLowerCase();
  if (provider === "codex") {
    // ChatGPT subscription login (Codex OAuth): no API key. Token is
    // resolved fresh per call (read + refresh-on-expiry), so a 24/7 loop
    // survives the ~1h access-token lifetime without restarts.
    const model = env["POLYROOT_FORECAST_MODEL"] ?? "";
    if (!model) {
      throw new Error(
        "FORECAST_CONFIG: POLYROOT_FORECAST_MODEL required when POLYROOT_FORECAST_PROVIDER=codex",
      );
    }
    const baseUrl = env["POLYROOT_CODEX_BASE_URL"] ?? DEFAULT_CODEX_BASE_URL;
    return new OpenAICompatibleForecastProvider({
      baseUrl,
      apiKey: "codex-oauth",
      model,
      requestStyle: "responses",
      authHeaders: async () => {
        const { loadCodexAuth, codexHeaders } = await import("./codex-auth.js");
        return codexHeaders(await loadCodexAuth());
      },
    });
  }
  if (provider === "9router") {
    // 9Router: OpenAI-compatible API via files.pango.fun gateway.
    // Uses OPENAI_API_KEY for authentication.
    const model = env["POLYROOT_FORECAST_MODEL"] ?? "";
    if (!model) {
      throw new Error(
        "FORECAST_CONFIG: POLYROOT_FORECAST_MODEL required when POLYROOT_FORECAST_PROVIDER=9router",
      );
    }
    const baseUrl = env["OPENAI_BASE_URL"] ?? "https://files.pango.fun/v1";
    const apiKey = env["OPENAI_API_KEY"] ?? "";
    if (!apiKey) {
      throw new Error(
        "FORECAST_CONFIG: OPENAI_API_KEY required when POLYROOT_FORECAST_PROVIDER=9router",
      );
    }
    if (!model) {
      throw new Error(
        "FORECAST_CONFIG: POLYROOT_FORECAST_MODEL required when POLYROOT_FORECAST_PROVIDER=9router",
      );
    }
    return new OpenAICompatibleForecastProvider({
      baseUrl,
      apiKey,
      model,
      requestStyle: "chat",
      // Measured 9Router latency 0.5–14s; the 15s default amputates
      // slow-but-good responses into abstains during gateway slow spells.
      timeoutMs: 30_000,
    });
  }
  if (provider !== "openai") {
    return null;
  }
  const apiKey = env["OPENAI_API_KEY"] ?? "";
  const model = env["POLYROOT_FORECAST_MODEL"] ?? "";
  if (!apiKey) {
    throw new Error(
      "FORECAST_CONFIG: OPENAI_API_KEY required when POLYROOT_FORECAST_PROVIDER=openai",
    );
  }
  if (!model) {
    throw new Error(
      "FORECAST_CONFIG: POLYROOT_FORECAST_MODEL required when POLYROOT_FORECAST_PROVIDER=openai",
    );
  }
  return new OpenAICompatibleForecastProvider({
    baseUrl: normalizeOpenAICompatible(env["OPENAI_BASE_URL"]),
    apiKey,
    model,
  });
}
