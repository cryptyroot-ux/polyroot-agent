import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OpenAICompatibleForecastProvider,
  createForecastProviderFromEnv,
  parseForecastProbability,
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
