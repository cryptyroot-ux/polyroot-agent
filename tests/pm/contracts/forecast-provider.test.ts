import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OpenAICompatibleForecastProvider,
  buildForecastUserPrompt,
  createForecastProviderFromEnv,
  parseForecastProbability,
  parseDetailedForecast,
  extractJsonObject,
  readCompletionContent,
} from "@polyroot/intelligence";

function stubFetch(content: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

const BASE = {
  baseUrl: "https://llm.example/v1",
  apiKey: "k",
  model: "m",
};

describe("forecast provider (fail-closed abstain)", () => {
  it("parses valid probabilities, rejects the rest", () => {
    assert.equal(parseForecastProbability('{"p":0.7}'), 0.7);
    assert.equal(parseForecastProbability('{"p":0}'), 0);
    assert.equal(parseForecastProbability('{"p":1}'), 1);
    assert.equal(parseForecastProbability("nope"), null);
    assert.equal(parseForecastProbability('{"p":2}'), null);
    assert.equal(parseForecastProbability('{"p":"high"}'), null);
    assert.equal(parseForecastProbability('{"q":0.5}'), null);
  });
  it("returns the model probability on success", async () => {
    const p = new OpenAICompatibleForecastProvider({
      ...BASE,
      fetchImpl: stubFetch('{"p":0.62}'),
    });
    assert.equal(
      await p.forecast({ market_id: "m", bid: 0.6, ask: 0.65 }),
      0.62,
    );
  });
  it("resolves null on transport failure or bad output", async () => {
    const failing = new OpenAICompatibleForecastProvider({
      ...BASE,
      fetchImpl: (async () => {
        throw new Error("down");
      }) as typeof fetch,
    });
    assert.equal(
      await failing.forecast({ market_id: "m", bid: 0.6, ask: 0.65 }),
      null,
    );
    const garbage = new OpenAICompatibleForecastProvider({
      ...BASE,
      fetchImpl: stubFetch("hello"),
    });
    assert.equal(
      await garbage.forecast({ market_id: "m", bid: 0.6, ask: 0.65 }),
      null,
    );
  });
  it("factory returns null when unconfigured, throws on half config", () => {
    assert.equal(createForecastProviderFromEnv({}), null);
    assert.equal(
      createForecastProviderFromEnv({ POLYROOT_FORECAST_PROVIDER: "none" }),
      null,
    );
    assert.throws(
      () =>
        createForecastProviderFromEnv({
          POLYROOT_FORECAST_PROVIDER: "openai",
          POLYROOT_FORECAST_MODEL: "m",
        }),
      /OPENAI_API_KEY/,
    );
    const p = createForecastProviderFromEnv({
      POLYROOT_FORECAST_PROVIDER: "openai",
      OPENAI_API_KEY: "k",
      POLYROOT_FORECAST_MODEL: "m",
    });
    assert.ok(p !== null);
  });
});

describe("default forecaster prompt (book context)", () => {
  it("embeds midpoint, spread cost and regime guidance", () => {
    const prompt = buildForecastUserPrompt({
      market_id: "m",
      bid: 0.45,
      ask: 0.55,
    });
    assert.ok(prompt.includes("midpoint 0.5000"));
    assert.ok(prompt.includes("spread 10.0¢"));
    assert.ok(prompt.includes("contested"));
    assert.ok(prompt.includes("adverse selection"));
    const withQ = buildForecastUserPrompt({
      market_id: "m",
      bid: 0.9,
      ask: 0.92,
      question: "Will it rain?",
    });
    assert.ok(withQ.includes("Will it rain?"));
    assert.ok(withQ.includes("consensus YES"));
  });
});

describe("forecast provider (stated reasoning)", () => {
  it("parses p + rationale + factors, degrades gracefully", async () => {
    const full = parseDetailedForecast(
      '{"p":0.62,"rationale":"Order flow favors YES into the close.","factors":["bid depth","late volume"]}',
    );
    assert.equal(full.p, 0.62);
    assert.equal(full.rationale, "Order flow favors YES into the close.");
    assert.deepEqual(full.factors, ["bid depth", "late volume"]);

    const pOnly = parseDetailedForecast('{"p":0.4}');
    assert.equal(pOnly.p, 0.4);
    assert.equal(pOnly.rationale, null);
    assert.deepEqual(pOnly.factors, []);

    const bad = parseDetailedForecast("hello");
    assert.deepEqual(bad, { p: null, rationale: null, factors: [] });

    const badP = parseDetailedForecast('{"p":9,"rationale":"x"}');
    assert.equal(badP.p, null);
    assert.equal(badP.rationale, "x");
  });

  it("forecast() keeps returning p-only; forecastDetailed carries reasoning", async () => {
    const p = new OpenAICompatibleForecastProvider({
      ...BASE,
      fetchImpl: stubFetch(
        '{"p":0.71,"rationale":"Why here.","factors":["a"]}',
      ),
    });
    assert.equal(
      await p.forecast({ market_id: "m", bid: 0.6, ask: 0.65 }),
      0.71,
    );
    const detailed = await p.forecastDetailed({
      market_id: "m",
      bid: 0.6,
      ask: 0.65,
    });
    assert.equal(detailed.p, 0.71);
    assert.equal(detailed.rationale, "Why here.");
    assert.deepEqual(detailed.factors, ["a"]);
  });
});

describe("reasoning-model robustness (SSE + wrapped JSON)", () => {
  it("extractJsonObject finds balanced JSON inside thinking prose", () => {
    const prose =
      'Hmm, let me think... {"a": {"b": "x { not json"}, "c": [1,2]} trailing words';
    assert.equal(
      extractJsonObject(prose),
      '{"a": {"b": "x { not json"}, "c": [1,2]}',
    );
    assert.equal(extractJsonObject('{"p":0.5}'), '{"p":0.5}');
    assert.equal(extractJsonObject("no json here"), "no json here");
  });

  it("parseDetailedForecast reads through thinking prose", () => {
    const r = parseDetailedForecast(
      'My analysis: price looks soft. {"p": 0.62, "rationale": "soft book", "factors": ["spread"]} done.',
    );
    assert.equal(r.p, 0.62);
    assert.equal(r.rationale, "soft book");
    assert.deepEqual(r.factors, ["spread"]);
  });

  it("readCompletionContent stitches SSE deltas", () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"{\\"p\\":"}}]}',
      'data: {"choices":[{"delta":{"content":"0.66, \\"rationale\\":\\"ok\\"}"}}]}',
      "data: [DONE]",
      "",
    ].join("\n");
    assert.equal(
      readCompletionContent(sse),
      '{"p":0.66, "rationale":"ok"}',
    );
  });

  it("readCompletionContent keeps plain JSON bodies working", () => {
    const body = JSON.stringify({
      choices: [{ message: { content: '{"p":0.4}' } }],
    });
    assert.equal(readCompletionContent(body), '{"p":0.4}');
    assert.equal(readCompletionContent(""), null);
    assert.equal(readCompletionContent("not json"), null);
  });

  it("forecastDetailed survives an SSE-streaming gateway", async () => {
    const inner = JSON.stringify({ p: 0.58 });
    const sse = [
      "data: " + JSON.stringify({ choices: [{ delta: { content: inner } }] }),
      "data: [DONE]",
    ].join("\n");
    const sseFetch = (async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;
    const p = new OpenAICompatibleForecastProvider({
      ...BASE,
      fetchImpl: sseFetch,
    });
    const detailed = await p.forecastDetailed({
      market_id: "m",
      bid: 0.5,
      ask: 0.55,
    });
    assert.equal(detailed.p, 0.58);
  });
});
