# Design: MetricsExporter Gateway Wiring (`/metrics` + `/healthz`)

- Status: approved (§1–§3, 24 Sep 2026)
- Scope: wire committed-but-unwired `MetricsExporter` (Task 5 follow-up). Separate PR, never merged into PR #22.

## §1 Architecture & Data Flow

- New file `src/pm/runtime/src/metrics-server.ts` using only `node:http` (zero new dependencies, consistent with the framework-free codebase).
- `MetricsServer` receives the shared observability `Metrics`, the existing `MetricsExporter`, and the owner API key (env `POLYROOT_METRICS_OWNER_KEY`, never hardcoded, never logged).
- `G4Pipeline` / `G4Loop` construct, start, and stop the server with their own lifecycle.
- `GET /metrics` (Bearer owner key required) → `200`, `Content-Type: text/plain; version=0.0.4`, body = `MetricsExporter.getMetrics()`. Missing/invalid key → `401` with no detail leakage.
- `GET /healthz` (public, no auth) → `200` JSON `{status:"ok", uptime_s}` — no sensitive data. Serves Docker `HEALTHCHECK` and staging compose.

## §2 Error Handling & Security

- Owner key compared with `crypto.timingSafeEqual` (same primitive as `SecurityProxy.verifyApiKey`); length mismatch handled without oracle leakage.
- Default bind `127.0.0.1:9090`; host/port overridable via config/env (`POLYROOT_METRICS_HOST`, `POLYROOT_METRICS_PORT`).
- Non-GET → `405`; unknown path → `404`; internal error → generic `500` + redacted log via the observability logger.
- No financial values on `/healthz`; `/metrics` never reachable without a valid key.

## §3 Testing (TDD)

New contract test `tests/pm/contracts/metrics-server.test.ts`:
1. No key → `401`.
2. Valid key → `200`, correct Content-Type, body contains `g4_total_orders_total`.
3. `/healthz` → `200` without auth.
4. Non-GET method → `405`.
5. Start/stop releases the port cleanly.

Gate: full `npm run ci` (0 errors, 0 warnings, all tests pass) before commit.
