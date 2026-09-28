/**
 * @polyroot/runtime — System health monitor for `polyroot health`.
 *
 * Read-only: probes never write. Every probe is isolated — one failing probe
 * marks itself down/degraded without aborting the others. Network I/O is
 * bounded by short timeouts and the fetch implementation is injectable so
 * unit tests run fully offline.
 */

import type { QueryablePool } from "../mode-watcher.js";

export type ProbeStatus = "ok" | "degraded" | "down";

export interface HealthProbe {
  name: string;
  status: ProbeStatus;
  detail: string;
  latencyMs?: number | undefined;
}

export interface HealthReport {
  overall: "HEALTHY" | "DEGRADED" | "DOWN";
  probes: HealthProbe[];
}

export interface HealthDeps {
  pool: QueryablePool;
  rpcUrl?: string | undefined;
  venueBaseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  dbSlowMs?: number | undefined;
  rpcSlowMs?: number | undefined;
  venueTimeoutMs?: number | undefined;
}

const DEFAULT_VENUE = "https://clob.polymarket.com";

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - start };
}

function withTimeout(ms: number): {
  signal: AbortSignal;
  done: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    done: () => clearTimeout(timer),
  };
}

async function probeDatabase(
  pool: QueryablePool,
  dbSlowMs: number,
): Promise<HealthProbe> {
  try {
    const { ms } = await timed(() => pool.query("SELECT 1", []));
    if (ms > dbSlowMs) {
      return {
        name: "Database",
        status: "degraded",
        detail: `slow query (${ms}ms > ${dbSlowMs}ms budget)`,
        latencyMs: ms,
      };
    }
    return {
      name: "Database",
      status: "ok",
      detail: `pool query OK (${ms}ms)`,
      latencyMs: ms,
    };
  } catch (err) {
    return {
      name: "Database",
      status: "down",
      detail: `unreachable: ${(err as Error).message}`,
    };
  }
}

async function probePipeline(pool: QueryablePool): Promise<HealthProbe> {
  try {
    const res = await pool.query(
      `SELECT (SELECT max(created_at) FROM paper_log) AS paper_last,
              (SELECT max(created_at) FROM shadow_log) AS shadow_last`,
      [],
    );
    const row = res.rows[0];
    const paperLast = row?.["paper_last"];
    const shadowLast = row?.["shadow_last"];
    const latest =
      paperLast instanceof Date
        ? paperLast
        : shadowLast instanceof Date
          ? shadowLast
          : typeof paperLast === "string" || typeof shadowLast === "string"
            ? new Date((paperLast ?? shadowLast) as string)
            : null;
    if (!latest || Number.isNaN(latest.getTime())) {
      return {
        name: "Pipeline",
        status: "ok",
        detail: "no cycles recorded yet (agent never ran)",
      };
    }
    const ageSec = Math.max(
      0,
      Math.round((Date.now() - latest.getTime()) / 1000),
    );
    if (ageSec > 1800) {
      return {
        name: "Pipeline",
        status: "degraded",
        detail: `last cycle ${ageSec}s ago (stale > 30m)`,
      };
    }
    return {
      name: "Pipeline",
      status: "ok",
      detail: `last cycle ${ageSec}s ago`,
    };
  } catch (err) {
    return {
      name: "Pipeline",
      status: "degraded",
      detail: `activity unreadable: ${(err as Error).message}`,
    };
  }
}

async function probeRpc(
  rpcUrl: string | undefined,
  rpcSlowMs: number,
  fetchImpl: typeof fetch,
): Promise<HealthProbe> {
  if (!rpcUrl) {
    return { name: "RPC", status: "degraded", detail: "RPC_URL unset" };
  }
  const t = withTimeout(8000);
  try {
    const { value: res, ms } = await timed(() =>
      fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_blockNumber",
          params: [],
        }),
        signal: t.signal,
      }),
    );
    if (!res.ok) {
      return {
        name: "RPC",
        status: "degraded",
        detail: `HTTP ${res.status}`,
        latencyMs: ms,
      };
    }
    const data = (await res.json()) as { result?: unknown };
    if (ms > rpcSlowMs) {
      return {
        name: "RPC",
        status: "degraded",
        detail: `slow (${ms}ms > ${rpcSlowMs}ms budget)`,
        latencyMs: ms,
      };
    }
    return {
      name: "RPC",
      status: "ok",
      detail: `block ${String(data.result ?? "?")} (${ms}ms)`,
      latencyMs: ms,
    };
  } catch (err) {
    return {
      name: "RPC",
      status: "down",
      detail: `unreachable: ${(err as Error).message}`,
    };
  } finally {
    t.done();
  }
}

async function probeVenue(
  venueBaseUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<HealthProbe> {
  const t = withTimeout(timeoutMs);
  try {
    const { ms } = await timed(() =>
      fetchImpl(`${venueBaseUrl}/`, { signal: t.signal }),
    );
    return {
      name: "Venue",
      status: "ok",
      detail: `reachable (${ms}ms)`,
      latencyMs: ms,
    };
  } catch (err) {
    return {
      name: "Venue",
      status: "down",
      detail: `unreachable: ${(err as Error).message}`,
    };
  } finally {
    t.done();
  }
}

function probeResources(): HealthProbe {
  const mem = process.memoryUsage();
  const mb = Math.round(mem.heapUsed / 1024 / 1024);
  const upMin = Math.round(process.uptime() / 60);
  return {
    name: "Resources",
    status: "ok",
    detail: `heap ${mb} MB, uptime ${upMin}m`,
  };
}

/** Run all probes and roll up the overall status. Never throws. */
export async function collectHealth(deps: HealthDeps): Promise<HealthReport> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const probes: HealthProbe[] = [];
  probes.push(await probeDatabase(deps.pool, deps.dbSlowMs ?? 1000));
  probes.push(await probePipeline(deps.pool));
  probes.push(
    await probeRpc(deps.rpcUrl, deps.rpcSlowMs ?? 2000, fetchImpl),
  );
  probes.push(
    await probeVenue(
      deps.venueBaseUrl ?? DEFAULT_VENUE,
      deps.venueTimeoutMs ?? 8000,
      fetchImpl,
    ),
  );
  probes.push(probeResources());
  const overall = probes.some((p) => p.status === "down")
    ? "DOWN"
    : probes.some((p) => p.status === "degraded")
      ? "DEGRADED"
      : "HEALTHY";
  return { overall, probes };
}

/** Render a report as a pretty emoji table (or JSON when asked). */
export function formatHealth(report: HealthReport, asJson: boolean): string {
  if (asJson) return JSON.stringify({ ok: true, ...report }, null, 2);
  const icon = (s: ProbeStatus): string =>
    s === "ok" ? "🟢" : s === "degraded" ? "🟡" : "🔴";
  const lines = ["🏥 System Health Check", ""];
  for (const p of report.probes) {
    lines.push(`${icon(p.status)} ${p.name}: ${p.detail}`);
  }
  lines.push("");
  const overallIcon =
    report.overall === "HEALTHY"
      ? "🟢"
      : report.overall === "DEGRADED"
        ? "🟡"
        : "🔴";
  lines.push(`Overall: ${overallIcon} ${report.overall}`);
  return lines.join("\n");
}
