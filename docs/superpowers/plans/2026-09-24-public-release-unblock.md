# Public Release Unblock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the remaining public-release blockers without changing trading behavior.

**Architecture:** Decouple public Docker liveness from the private metrics key, correct stale HTTP documentation, and triage Dependabot updates by CI evidence rather than merging major upgrades blindly.

**Tech Stack:** TypeScript, Node.js test runner with `tsx`, Docker Compose, GitHub Actions.

## Global Constraints

- Node.js `>=24.0.0`.
- Mandatory gates remain `npm run ci` and secret scanning.
- `MICRO_LIVE` and `LIVE` stay fail-closed without wallet, signer, charter, and promotion evidence.
- No production secrets in examples, tests, or shell history.

---

### Task 1: Public health endpoint without a metrics key

**Files:**
- Modify: `tests/pm/contracts/metrics-server.test.ts`
- Modify: `src/pm/runtime/src/metrics-server.ts`
- Modify: `src/pm/runtime/src/cli.ts`
- Modify: `Dockerfile`
- Modify: `.env.example`
- Test: `tests/pm/contracts/metrics-server.test.ts`

**Interfaces:**
- Consumes: `Metrics`, `MetricsExporter`.
- Produces: `MetricsServer` that accepts an empty `ownerKey`, always serves public `GET /healthz`, and returns `401` for `GET /metrics` when no owner key is configured.

- [ ] **Step 1: Write the failing test**

```typescript
import { MetricsServer } from "@polyroot/runtime";

it("serves public /healthz while /metrics stays disabled without an owner key", async () => {
  let server: MetricsServer | undefined;
  try {
    server = new MetricsServer({
      exporter: new MetricsExporter(new Metrics()),
      ownerKey: "",
      host: "127.0.0.1",
      port: 0,
    });
  } catch (error) {
    assert.match(String(error), /METRICS_OWNER_KEY_REQUIRED/);
  }
  assert.ok(server, "expected MetricsServer to start without an owner key");

  const address = await server.start();
  try {
    const health = await fetch(`http://${address.host}:${address.port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");

    const metrics = await fetch(`http://${address.host}:${address.port}/metrics`);
    assert.equal(metrics.status, 401);
  } finally {
    await server.stop();
  }
});
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run:

```bash
node --test --import tsx tests/pm/contracts/metrics-server.test.ts
```

Expected: FAIL at `expected MetricsServer to start without an owner key`.

- [ ] **Step 3: Implement the minimal server change**

```typescript
export interface MetricsServerOptions {
  exporter: MetricsExporter;
  ownerKey?: string;
  host?: string;
  port?: number;
}
```

Store:

```typescript
this.ownerKey = opts.ownerKey ?? "";
```

Gate only `/metrics`:

```typescript
if (url.pathname === "/metrics") {
  if (!this.ownerKey || !this.hasValidBearer(req.headers.authorization)) {
    res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized");
    return;
  }
  // ... existing exporter response
}
```

Keep `/healthz` unchanged and public.

- [ ] **Step 4: Always start the server in the CLI**

```typescript
const metricsOwnerKey = getEnv("POLYROOT_METRICS_OWNER_KEY") ?? "";
const metricsServer = new MetricsServer({
  exporter: new MetricsExporter(agent.metrics),
  ...(metricsOwnerKey ? { ownerKey: metricsOwnerKey } : {}),
  ...(metricsHost !== undefined ? { host: metricsHost } : {}),
  ...(metricsPortRaw !== undefined ? { port: Number(metricsPortRaw) } : {}),
});
if (!metricsOwnerKey) {
  console.warn(
    "POLYROOT_METRICS_OWNER_KEY unset — /metrics endpoint disabled; /healthz remains public",
  );
}
```

Remove the old conditional that left `metricsServer` undefined.

- [ ] **Step 5: Update Docker and example-environment wording**

In `Dockerfile`, replace the health-check comment with:

```dockerfile
# Health check against the agent's public /healthz endpoint.
# The metrics owner key is optional; an unset key disables /metrics only.
```

In `.env.example`, replace the observability comment with:

```env
# OBSERVABILITY (Optional — /metrics disabled when the key is unset)
# GET /healthz is always public; GET /metrics requires the Bearer key.
```

- [ ] **Step 6: Verify the focused test**

Run:

```bash
node --test --import tsx tests/pm/contracts/metrics-server.test.ts
```

Expected: PASS.

---

### Task 2: Correct stale public HTTP documentation

**Files:**
- Modify: `docs/PUBLIC_API.md`
- Modify: `README.md`
- Modify: `SECURITY_INCIDENT_RESPONSE.md`
- Test: `npx prettier --check docs/PUBLIC_API.md README.md SECURITY_INCIDENT_RESPONSE.md` (Prettier cannot infer parsers for `Dockerfile` or `.env.example`, so omit those files.)

**Interfaces:**
- Consumes: Actual runtime behavior from Task 1.
- Produces: Documentation that no longer advertises unavailable gateway routes.

- [ ] **Step 1: Fix the API overview**

Replace:

```markdown
including configuration, runtime modes, gateway endpoints, and integration points
```

with:

```markdown
including configuration, runtime modes, health/metrics endpoints, and integration points
```

Replace TOC entry:

```markdown
4. [Gateway API](#gateway-api)
```

with:

```markdown
4. [HTTP Surface](#http-surface)
```

- [ ] **Step 2: Replace unavailable integration examples**

Delete the Node.js `http://localhost:3000/intents` and `http://localhost:3000/runtime/status` examples. Replace them with:

```markdown
## Integration Examples

### Check liveness

```bash
curl http://127.0.0.1:9090/healthz
```

### Read Prometheus metrics

```bash
curl \
  -H "Authorization: Bearer $POLYROOT_METRICS_OWNER_KEY" \
  http://127.0.0.1:9090/metrics
```
```

- [ ] **Step 3: Correct the claimed public surface**

Replace:

```markdown
Public API surface: Gateway endpoints, `TradeIntent` schema, `VenueAdapter` interface, error codes.
```

with:

```markdown
Public API surface: `/healthz`, `/metrics`, `TradeIntent` schema, `VenueAdapter` interface, error codes.
```

- [ ] **Step 4: Correct README wording**

Replace:

```markdown
See [`docs/PUBLIC_API.md`](docs/PUBLIC_API.md) for full API reference, runtime modes, observability, and integration examples.
```

with:

```markdown
See [`docs/PUBLIC_API.md`](docs/PUBLIC_API.md) for full API reference, runtime modes, and observability.
```

Replace:

```markdown
| `POLYROOT_METRICS_OWNER_KEY`         | Bearer key for `GET /metrics` (`/healthz` public) | _(unset = endpoint disabled)_ |
```

with:

```markdown
| `POLYROOT_METRICS_OWNER_KEY`         | Bearer key for `GET /metrics` (`/healthz` public) | _(unset = `/metrics` disabled)_ |
```

- [ ] **Step 5: Correct the security advisory URL**

Replace:

```markdown
- [GitHub Security Advisories](https://github.com/your-org/polyroot-agent/security/advisories)
```

with:

```markdown
- [GitHub Security Advisories](https://github.com/cryptyroot-ux/polyroot-agent/security/advisories)
```

- [ ] **Step 6: Verify formatting**

Run:

```bash
npx prettier --check docs/PUBLIC_API.md README.md SECURITY_INCIDENT_RESPONSE.md
```

Expected: PASS. Do not add `Dockerfile` or `.env.example`; Prettier has no inferred parser for those paths.

---

### Task 3: Triage open Dependabot PRs by CI evidence

**Files:**
- Modify: none unless a PR is accepted.
- Test: use GitHub check runs and, for accepted dependency changes, `npm run ci`.

**Interfaces:**
- Consumes: PR numbers, changed files, check-run conclusions, and mergeable state.
- Produces: A merge/close/update decision for each open Dependabot PR.

- [ ] **Step 1: Inspect checks and mergeability**

For each open PR, retrieve:
- changed files;
- CI check-run conclusions;
- mergeable state;
- base commit.

- [ ] **Step 2: Merge only unambiguous green maintenance PRs**

Merge only when:
- all required checks are green;
- the PR is mergeable without conflict;
- the change is a patch/minor maintenance update or a compatible CI action update.

- [ ] **Step 3: Do not blindly merge major upgrades**

Hold or close/supersede major upgrades affecting:
- TypeScript;
- ESLint;
- OpenAI SDK;
- Pino;
- Express;
- Node.js types;
- GitHub Actions major versions with changed runtime requirements.

Each held PR needs a recorded reason and follow-up.

- [ ] **Step 4: Run repository verification for accepted changes**

Run:

```bash
npm run ci
```

Expected: exit code `0`.

---

### Task 4: Draft the public announcement

**Files:**
- Create: none.
- Test: verify every public claim against `README.md`, `docs/PUBLIC_API.md`, and release `v0.1.1`.

**Interfaces:**
- Consumes: Completed Tasks 1–3 and release evidence.
- Produces: A concise announcement that says framework, self-hosted, PAPER-first, live-gated, and required infrastructure.

- [ ] **Step 1: Draft the announcement**
- [ ] **Step 2: Verify each claim in the draft**
- [ ] **Step 3: Present the draft without publishing it**
