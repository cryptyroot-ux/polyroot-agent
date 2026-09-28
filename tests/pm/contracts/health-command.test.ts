import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectHealth, formatHealth } from "@polyroot/runtime";

function okFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: string | URL | Request) => {
    return handler(String(input));
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function healthyPool() {
  return {
    query: async (text: string) => {
      if (/max\(created_at\)/.test(text)) {
        return { rows: [{ paper_last: new Date(), shadow_last: null }] };
      }
      return { rows: [{ "?column?": 1 }] };
    },
  };
}

describe("polyroot health", () => {
  it("reports HEALTHY when all probes pass", async () => {
    const report = await collectHealth({
      pool: healthyPool(),
      rpcUrl: "https://rpc.example",
      fetchImpl: okFetch((url) =>
        url.includes("rpc.example")
          ? jsonResponse({ result: "0x1234" })
          : new Response("ok", { status: 200 }),
      ),
    });
    assert.equal(report.overall, "HEALTHY");
    const names = report.probes.map((p) => p.name);
    for (const want of ["Database", "Pipeline", "RPC", "Venue", "Resources"]) {
      assert.ok(names.includes(want), `missing probe ${want}`);
    }
    const text = formatHealth(report, false);
    assert.ok(text.includes("🟢"));
    assert.ok(text.includes("HEALTHY"));
    const parsed = JSON.parse(formatHealth(report, true)) as {
      overall: string;
    };
    assert.equal(parsed.overall, "HEALTHY");
  });

  it("reports DOWN when the database is unreachable", async () => {
    const report = await collectHealth({
      pool: {
        query: async () => {
          throw new Error("connection refused");
        },
      },
      fetchImpl: okFetch(() => new Response("ok", { status: 200 })),
    });
    assert.equal(report.overall, "DOWN");
    const db = report.probes.find((p) => p.name === "Database");
    assert.equal(db?.status, "down");
    assert.ok(formatHealth(report, false).includes("🔴"));
  });

  it("reports DEGRADED on slow RPC and missing RPC_URL", async () => {
    const slowFetch = okFetch(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(jsonResponse({ result: "0x1" })), 150);
        }),
    );
    const slow = await collectHealth({
      pool: healthyPool(),
      rpcUrl: "https://rpc.example",
      rpcSlowMs: 50,
      fetchImpl: slowFetch,
    });
    assert.equal(slow.overall, "DEGRADED");
    assert.equal(slow.probes.find((p) => p.name === "RPC")?.status, "degraded");

    const unset = await collectHealth({
      pool: healthyPool(),
      rpcUrl: undefined,
      fetchImpl: okFetch(() => new Response("ok", { status: 200 })),
    });
    assert.equal(unset.overall, "DEGRADED");
    assert.ok(
      (unset.probes.find((p) => p.name === "RPC")?.detail ?? "").includes(
        "RPC_URL unset",
      ),
    );
  });
});
