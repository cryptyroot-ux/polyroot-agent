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

/** Optional observability hooks for forecasting stages. */
export interface ForecastObservability {
  /** Called when research/evidence ingestion starts. */
  onResearchStart?: (marketId: string, message: string) => void;
  /** Called when evidence is weighted/evaluated. */
  onEvidenceWeight?: (marketId: string, message: string) => void;
  /** Called when forecast is ready. */
  onForecastReady?: (marketId: string, probability: number, message: string) => void;
  /** Called when reasoning/rationale is produced. */
  onReasoningLog?: (marketId: string, rationale: string) => void;
}

/** A pluggable probability source. Null means abstain. */
export interface ForecastProvider {
  readonly name: string;
  forecast(input: ForecastInput, obs?: ForecastObservability): Promise<number | null>;
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
  'You estimate prediction-market probabilities. Reply with JSON only: {"p": <number between 0 and 1>} for the YES outcome. No other text.';

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

  async forecast(input: ForecastInput, obs?: ForecastObservability): Promise<number | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Stage 1: Research ingestion
      obs?.onResearchStart?.(input.market_id, `Memulai riset market: bid ${input.bid}, ask ${input.ask}`);

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
      if (!res.ok) return null;
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string") return null;

      // Stage 2: Parse probability
      const probability = parseForecastProbability(content);
      if (probability === null) return null;

      // Stage 3: Evidence weight (simple heuristic based on spread)
      const spread = input.ask - input.bid;
      obs?.onEvidenceWeight?.(
        input.market_id,
        `Spread ${spread.toFixed(4)} — bobot bukti: ${spread < 0.05 ? "tinggi" : "sedang"} (likuiditas ${spread < 0.05 ? "baik" : "terbatas"})`,
      );

      // Stage 4: Forecast ready
      obs?.onForecastReady?.(
        input.market_id,
        probability,
        `Probabilitas YES = ${probability.toFixed(4)} | Book Ask ${input.ask} | Edge net: ${(probability - input.ask).toFixed(4)}`,
      );

      // Stage 5: Reasoning log (we don't have full rationale from simple prompt, but log what we can)
      obs?.onReasoningLog?.(
        input.market_id,
        `Harga pasar (ask): ${input.ask}. Prediksi model: ${probability.toFixed(4)}. ${probability > input.ask ? "Edge positif — layak pertimbangan." : "Edge negatif — hindari."}`,
      );

      return probability;
    } catch {
      return null;
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
