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
  fetchOpenAIModels,
  fetchAnthropicModels,
  AnthropicMessagesForecastProvider,
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
    assert.equal(readCompletionContent(sse), '{"p":0.66, "rationale":"ok"}');
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

describe("Responses wire protocol (Codex backend)", () => {
  it("reads output_text and message output parts", () => {
    assert.equal(
      readCompletionContent(JSON.stringify({ output_text: "p halfway" })),
      "p halfway",
    );
    const body = JSON.stringify({
      output: [
        { type: "reasoning", summary: [] },
        {
          type: "message",
          content: [{ type: "output_text", text: '{"p":0.44}' }],
        },
      ],
    });
    assert.equal(readCompletionContent(body), '{"p":0.44}');
  });

  it("stitches response.output_text.delta SSE events", () => {
    const inner = JSON.stringify({ p: 0.5 });
    const sse = [
      "event: response.output_text.delta",
      "data: " +
        JSON.stringify({ type: "response.output_text.delta", delta: inner }),
      "event: response.completed",
      "data: " + JSON.stringify({ type: "response.completed" }),
      "",
    ].join("\n");
    assert.equal(readCompletionContent(sse), inner);
  });

  it("provider speaks /responses with per-call OAuth headers", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    let seenBody = "";
    const stub = (async (url: unknown, opts: unknown) => {
      seenUrl = String(url);
      seenHeaders = (opts as { headers: Record<string, string> }).headers;
      seenBody = (opts as { body: string }).body;
      return new Response(
        JSON.stringify({
          output_text: '{"p":0.61,"rationale":"r","factors":[]}',
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const p = new OpenAICompatibleForecastProvider({
      baseUrl: "https://chatgpt.com/backend-api/codex",
      apiKey: "unused-placeholder",
      model: "m-codex",
      requestStyle: "responses",
      authHeaders: async () => ({
        authorization: "Bearer tok123",
        "ChatGPT-Account-ID": "acc1",
      }),
      fetchImpl: stub,
    });
    const d = await p.forecastDetailed({ market_id: "m", bid: 0.5, ask: 0.55 });
    assert.equal(d.p, 0.61);
    assert.ok(seenUrl.endsWith("/responses"));
    assert.equal(seenHeaders["authorization"], "Bearer tok123");
    assert.equal(seenHeaders["ChatGPT-Account-ID"], "acc1");
    assert.ok(!("temperature" in JSON.parse(seenBody)));
  });

  it("createForecastProviderFromEnv builds the codex branch", () => {
    const prev = { ...process.env };
    try {
      process.env["POLYROOT_FORECAST_PROVIDER"] = "codex";
      process.env["POLYROOT_FORECAST_MODEL"] = "m-codex";
      delete process.env["POLYROOT_CODEX_BASE_URL"];
      const p = createForecastProviderFromEnv(process.env);
      assert.ok(p !== null);
      assert.equal(
        createForecastProviderFromEnv({ POLYROOT_FORECAST_PROVIDER: "none" }),
        null,
      );
      assert.throws(
        () =>
          createForecastProviderFromEnv({
            POLYROOT_FORECAST_PROVIDER: "codex",
          }),
        /POLYROOT_FORECAST_MODEL/,
      );
    } finally {
      process.env = prev;
    }
  });
});

describe("OpenAI model catalog discovery", () => {
  it("lists live ids, deduped; throws when refused", async () => {
    const okFetch = (async () =>
      new Response(
        JSON.stringify({
          data: [{ id: "gpt-4o" }, { id: "gpt-4o" }, { id: "" }],
        }),
        { status: 200 },
      )) as typeof fetch;
    assert.deepEqual(
      await fetchOpenAIModels("https://x.example", "k", okFetch),
      ["gpt-4o"],
    );
    const badFetch = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;
    await assert.rejects(fetchOpenAIModels("https://x.example", "k", badFetch));
  });
});

describe("Anthropic official API (Messages protocol, official key)", () => {
  it("catalog uses x-api-key header and lists live ids", async () => {
    let seenHeaders: Record<string, string> = {};
    let seenUrl = "";
    const okFetch = (async (url: unknown, init: unknown) => {
      seenUrl = String(url);
      seenHeaders = ((init as { headers: Record<string, string> }).headers ??
        {}) as Record<string, string>;
      return new Response(
        JSON.stringify({
          data: [{ id: "claude-sonnet-4-5" }, { id: "claude-sonnet-4-5" }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    assert.deepEqual(
      await fetchAnthropicModels(
        "https://api.anthropic.com",
        "sk-ant-x",
        okFetch,
      ),
      ["claude-sonnet-4-5"],
    );
    assert.ok(seenUrl.endsWith("/v1/models"));
    assert.equal(seenHeaders["x-api-key"], "sk-ant-x");
    assert.equal(seenHeaders["anthropic-version"], "2023-06-01");
    assert.ok(!("authorization" in seenHeaders));
  });

  it("forecast posts messages format and parses probability", async () => {
    let seenBody = "";
    let seenHeaders: Record<string, string> = {};
    const okFetch = (async (_url: unknown, init: unknown) => {
      const i = init as {
        headers: Record<string, string>;
        body: string;
      };
      seenHeaders = i.headers;
      seenBody = i.body;
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: '{"p":0.68,"rationale":"r"}' }],
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const p = new AnthropicMessagesForecastProvider({
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-x",
      model: "claude-sonnet-4-5",
      fetchImpl: okFetch,
    });
    assert.equal(
      await p.forecast({ market_id: "m", bid: 0.4, ask: 0.6 }),
      0.68,
    );
    const body = JSON.parse(seenBody) as {
      model: string;
      system: string;
      messages: Array<{ role: string }>;
    };
    assert.equal(body.model, "claude-sonnet-4-5");
    assert.ok(typeof body.system === "string" && body.system.length > 0);
    assert.equal(body.messages[0]?.role, "user");
    assert.equal(seenHeaders["x-api-key"], "sk-ant-x");
  });

  it("abstains (null) on HTTP error, garbage, or transport failure", async () => {
    const badFetch = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;
    const p1 = new AnthropicMessagesForecastProvider({
      baseUrl: "https://api.anthropic.com",
      apiKey: "k",
      model: "m",
      fetchImpl: badFetch,
    });
    assert.equal(
      await p1.forecast({ market_id: "m", bid: 0.4, ask: 0.6 }),
      null,
    );
    const downFetch = (async () => {
      throw new Error("boom");
    }) as typeof fetch;
    const p2 = new AnthropicMessagesForecastProvider({
      baseUrl: "https://api.anthropic.com",
      apiKey: "k",
      model: "m",
      fetchImpl: downFetch,
    });
    assert.equal(
      await p2.forecast({ market_id: "m", bid: 0.4, ask: 0.6 }),
      null,
    );
  });

  it("env factory builds anthropic branch on official key, refuses without", () => {
    const p = createForecastProviderFromEnv({
      POLYROOT_FORECAST_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-x",
      POLYROOT_FORECAST_MODEL: "claude-sonnet-4-5",
    });
    assert.ok(p !== null);
    assert.equal(p?.name, "anthropic-messages");
    assert.throws(
      () =>
        createForecastProviderFromEnv({
          POLYROOT_FORECAST_PROVIDER: "anthropic",
          POLYROOT_FORECAST_MODEL: "m",
        }),
      /ANTHROPIC_API_KEY/,
    );
  });
});
