/**
 * @polyroot/intelligence — Forecast provider wiring (PM-AI-02 portability).
 *
 * Replaces the historical hardcoded forecast stub in the runtime entrypoint.
 * Providers are thin I/O wrappers over OpenAI-compatible chat-completions
 * endpoints (OpenAI, 9Router, FreeLLMAPI). Any failure — network, timeout,
 * unparseable or out-of-range output — resolves to null (abstain/NO_TRADE),
 * never to a fabricated probability.
 */

import { normalizeOpenAICompatible, joinApiPath } from "./index.js";

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
    parsed = JSON.parse(text) as unknown;
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

export class OpenAICompatibleForecastProvider implements ForecastProvider {
  readonly name = "openai-compatible";
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenAICompatibleProviderConfig) {
    if (!config.apiKey) throw new Error("FORECAST_CONFIG: apiKey required");
    if (!config.model) throw new Error("FORECAST_CONFIG: model required");
    this.baseUrl = normalizeOpenAICompatible(config.baseUrl);
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 15000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async forecast(input: ForecastInput): Promise<number | null> {
    return (await this.forecastDetailed(input)).p;
  }

  /** Full reply: probability plus the model's stated reasoning (nullable). */
  async forecastDetailed(input: ForecastInput): Promise<DetailedForecast> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const user =
        `Market ${input.market_id}` +
        (input.question ? ` (${input.question})` : "") +
        ` — bid ${input.bid}, ask ${input.ask}. Probability of YES?`;
      const res = await this.fetchImpl(
        joinApiPath(this.baseUrl, "chat/completions"),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: "system", content: FORECAST_SYSTEM_PROMPT },
              { role: "user", content: user },
            ],
            temperature: 0,
          }),
          signal: controller.signal,
        },
      );
      if (!res.ok) return { p: null, rationale: null, factors: [] };
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string")
        return { p: null, rationale: null, factors: [] };
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
 * POLYROOT_FORECAST_PROVIDER=openai enables; OPENAI_API_KEY +
 * POLYROOT_FORECAST_MODEL are then required (throws). OPENAI_BASE_URL
 * selects any OpenAI-compatible gateway (default api.openai.com).
 */
export function createForecastProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ForecastProvider | null {
  if (
    (env["POLYROOT_FORECAST_PROVIDER"] ?? "none").toLowerCase() !== "openai"
  ) {
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
