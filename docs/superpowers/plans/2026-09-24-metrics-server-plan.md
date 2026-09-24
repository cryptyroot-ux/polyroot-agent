# Metrics Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the committed `MetricsExporter` to a minimal authenticated HTTP server exposing `GET /metrics` and public `GET /healthz`.

**Architecture:** New `MetricsServer` class in `@polyroot/runtime` built on `node:http` only (zero new deps). Bearer owner-key auth with `crypto.timingSafeEqual` for `/metrics`; `/healthz` returns status/uptime without auth. TDD with a contract test hitting real localhost sockets.

**Tech Stack:** Node.js 24, TypeScript 5 (strict, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`), `node:test` + `node:assert/strict`, `tsx` runner.

## Global Constraints

- **Node version:** >= 24.0.0
- **Strict TypeScript:** `verbatimModuleSyntax: true`, `exactOptionalPropertyTypes: true`
- **Zero Regression:** `npm run ci` must pass with 0 errors/warnings on every commit.
- **Security First:** No private keys in AI core; owner key from env `POLYROOT_METRICS_OWNER_KEY`, never hardcoded or logged.

---

### Task 1: Failing contract test for the metrics server

**Files:**
- Create: `tests/pm/contracts/metrics-server.test.ts`
- Test: `tests/pm/contracts/metrics-server.test.ts`

**Interfaces:**
- Consumes: `Metrics` from `@polyroot/observability`; `MetricsExporter`, `MetricsServer` from `@polyroot/runtime` (not yet exported — test must fail at import).
- Produces: failing test pinning the HTTP contract (401/200/Content-Type/healthz/405/clean stop).

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Metrics } from "@polyroot/observability";
import { MetricsExporter, MetricsServer } from "@polyroot/runtime";

const OWNER_KEY = "test-owner-key-12345";

async function startServer(): Promise<{ server: MetricsServer; base: string }> {
  const metrics = new Metrics();
  metrics.increment("totalOrders", 3);
  const server = new MetricsServer({
    exporter: new MetricsExporter(metrics),
    ownerKey: OWNER_KEY,
    host: "127.0.0.1",
    port: 0,
  });
  const { port } = await server.start();
  return { server, base: `http://127.0.0.1:${port}` };
}

describe("MetricsServer HTTP contract", () => {
  it("GET /metrics without key returns 401", async () => {
    const { server, base } = await startServer();
    try {
      const res = await fetch(`${base}/metrics`);
      assert.equal(res.status, 401);
    } finally {
      await server.stop();
    }
  });

  it("GET /metrics with valid key returns 200 + Prometheus body", async () => {
    const { server, base } = await startServer();
    try {
      const res = await fetch(`${base}/metrics`, {
        headers: { authorization: `Bearer ${OWNER_KEY}` },
      });
      assert.equal(res.status, 200);
      assert.match(
        res.headers.get("content-type") ?? "",
        /text\/plain/,
      );
      const body = await res.text();
      assert.match(body, /g4_total_orders_total 3/);
    } finally {
      await server.stop();
    }
  });

  it("GET /healthz is public and reports ok", async () => {
    const { server, base } = await startServer();
    try {
      const res = await fetch(`${base}/healthz`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status: string };
      assert.equal(body.status, "ok");
    } finally {
      await server.stop();
    }
  });

  it("non-GET method returns 405", async () => {
    const { server, base } = await startServer();
    try {
      const res = await fetch(`${base}/metrics`, {
        method: "POST",
        headers: { authorization: `Bearer ${OWNER_KEY}` },
      });
      assert.equal(res.status, 405);
    } finally {
      await server.stop();
    }
  });

  it("stop releases the port and further requests fail", async () => {
    const { server, base } = await startServer();
    await server.stop();
    await assert.rejects(fetch(`${base}/healthz`));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx tests/pm/contracts/metrics-server.test.ts`
Expected: FAIL (SyntaxError or `MetricsServer` not exported from `@polyroot/runtime`).

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/pm/contracts/metrics-server.test.ts docs/superpowers/plans/2026-09-24-metrics-server-plan.md
git commit -m "test(obs): failing contract for metrics HTTP server"
```

### Task 2: Minimal MetricsServer implementation

**Files:**
- Create: `src/pm/runtime/src/metrics-server.ts`
- Modify: `src/pm/runtime/src/index.ts` (export `MetricsExporter`, `MetricsServer`, option types)
- Test: `tests/pm/contracts/metrics-server.test.ts`

**Interfaces:**
- Consumes: `Metrics` from `@polyroot/observability` (has `snapshot()`); `MetricsExporter` from `./metrics-exporter.js` (has `getMetrics(): string`).
- Produces: `MetricsServer` with `constructor(opts: MetricsServerOptions)`, `start(): Promise<{ host: string; port: number }>`, `stop(): Promise<void>`; `MetricsServerOptions { exporter: MetricsExporter; ownerKey: string; host?: string; port?: number }` (defaults `127.0.0.1:9090`; `port: 0` = ephemeral for tests).

- [ ] **Step 1: Write minimal implementation**

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Metrics } from "@polyroot/observability";
import type { MetricsExporter } from "./metrics-exporter.js";

/** Options for MetricsServer. Port 0 selects an ephemeral port (tests). */
export interface MetricsServerOptions {
  exporter: MetricsExporter;
  /** Owner API key (from env POLYROOT_METRICS_OWNER_KEY). Never logged. */
  ownerKey: string;
  host?: string;
  port?: number;
}

/**
 * Minimal Prometheus/health HTTP server (node:http only).
 * GET /metrics requires Bearer owner key; GET /healthz is public.
 */
export class MetricsServer {
  private readonly server: Server;
  private readonly exporter: MetricsExporter;
  private readonly ownerKey: string;
  private readonly host: string;
  private readonly port: number;
  private readonly startedAt = Date.now();
  private listeningPort: number | undefined;

  constructor(opts: MetricsServerOptions) {
    if (!opts.ownerKey) throw new Error("METRICS_OWNER_KEY_REQUIRED");
    this.exporter = opts.exporter;
    this.ownerKey = opts.ownerKey;
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port ?? 9090;
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  /** Start listening. Resolves with the bound address (port 0 => ephemeral). */
  async start(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    const addr = this.server.address();
    this.listeningPort =
      typeof addr === "object" && addr !== null ? addr.port : this.port;
    return { host: this.host, port: this.listeningPort };
  }

  /** Stop listening and release the port. */
  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "text/plain" }).end("method not allowed");
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz") {
        const body = JSON.stringify({
          status: "ok",
          uptime_s: Math.floor((Date.now() - this.startedAt) / 1000),
        });
        res.writeHead(200, { "content-type": "application/json" }).end(body);
        return;
      }
      if (url.pathname === "/metrics") {
        if (!this.hasValidBearer(req.headers.authorization)) {
          res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized");
          return;
        }
        res
          .writeHead(200, { "content-type": "text/plain; version=0.0.4" })
          .end(this.exporter.getMetrics());
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    } catch {
      res.writeHead(500, { "content-type": "text/plain" }).end("internal error");
    }
  }

  /** Timing-safe Bearer comparison; length mismatch fails closed without oracle. */
  private hasValidBearer(header: string | string[] | undefined): boolean {
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || !value.startsWith("Bearer ")) return false;
    const provided = Buffer.from(value.slice("Bearer ".length));
    const expected = Buffer.from(this.ownerKey);
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  }
}
```

index.ts additions:

```ts
export { MetricsExporter } from "./metrics-exporter.js";
export { MetricsServer, type MetricsServerOptions } from "./metrics-server.js";
```

- [ ] **Step 2: Run the contract test to verify it passes**

Run: `node --test --import tsx tests/pm/contracts/metrics-server.test.ts`
Expected: PASS (5/5).

- [ ] **Step 3: Run package typecheck + lint**

Run: `npx tsc --noEmit -p tsconfig.json && npx eslint src` from `src/pm/runtime`
Expected: exit 0, no output.

- [ ] **Step 4: Commit implementation**

```bash
git add src/pm/runtime/src/metrics-server.ts src/pm/runtime/src/index.ts
git commit -m "feat(obs): authenticated /metrics + public /healthz server"
```

### Task 3: Full gate + push

**Files:**
- Test: full `npm run ci`, `gitleaks detect`

- [ ] **Step 1: Run full CI**

Run: `npm run ci` from repo root
Expected: exit 0; contract 565+ pass, property 12 pass, 0 fail; 0 warnings; 13/13 builds.

- [ ] **Step 2: Run gitleaks**

Run: `gitleaks detect --source . --baseline-path .gitleaks_baseline.json --no-banner`
Expected: `no leaks found`.

- [ ] **Step 3: Push branch**

Run: `git push origin release/production-readiness`
Expected: push accepted; PR #22 updates automatically.
