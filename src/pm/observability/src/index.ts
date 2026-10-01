/**
 * @polyroot/observability — Metrics, logging, alerts, health (PR-OPS-05, G0/G3).
 *
 * Real in-memory implementations. Production wiring (push to Prometheus etc)
 * is expected to extend these; the core is no longer a placeholder.
 */

/* ─── Metrics ─────────────────────────────────────────────────────────────── */

export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, number[]>();

  increment(name: string, amount = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  /** Set a counter to an absolute cumulative value (pipeline snapshots). */
  setCounter(name: string, value: number): void {
    this.counters.set(name, value);
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  histogram(name: string, value: number): void {
    const arr = this.histograms.get(name) ?? [];
    arr.push(value);
    this.histograms.set(name, arr);
  }

  getCounter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  getGauge(name: string): number | undefined {
    return this.gauges.get(name);
  }

  getHistogram(name: string): number[] {
    return this.histograms.get(name) ?? [];
  }

  getHistogramPercentile(name: string, p: number): number | undefined {
    const arr = this.getHistogram(name);
    if (arr.length === 0) return undefined;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx];
  }

  snapshot(): {
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, number[]>;
  } {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: Object.fromEntries(this.histograms),
    };
  }
}

/* ─── Redacting logger ────────────────────────────────────────────────────── */

export type LogLevel = "debug" | "info" | "warn" | "error";

const REDACT_KEYS = new Set([
  "secret",
  "token",
  "key",
  "password",
  "credential",
  "private_key",
  "api_key",
  "signature",
  "mnemonic",
  "privatekey",
]);

function deepRedactValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(deepRedactValue);
  if (typeof v === "object" && v !== null) {
    return deepRedact(v as Record<string, unknown>);
  }
  return v;
}

function deepRedact(meta: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    result[k] = REDACT_KEYS.has(k.toLowerCase())
      ? redactValue(v)
      : deepRedactValue(v);
  }
  return result;
}

export interface LogEntry {
  level: LogLevel;
  msg: string;
  meta: Record<string, unknown>;
  at: number;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    // Keep a short prefix/suffix but mask the middle, never log full secret.
    if (value.length > 10) {
      return `${value.slice(0, 4)}****${value.slice(-4)}`;
    }
    return "****";
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object" && value !== null) {
    // A sensitive key holding a nested object must not leak any leaf.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}

export class Logger {
  private logs: LogEntry[] = [];

  private log(
    level: LogLevel,
    msg: string,
    meta: Record<string, unknown> = {},
  ): void {
    const redacted: Record<string, unknown> = deepRedact(meta);
    this.logs.push({ level, msg, meta: redacted, at: Date.now() });
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.log("debug", msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.log("info", msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.log("warn", msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.log("error", msg, meta);
  }

  getLogs(level?: LogLevel): LogEntry[] {
    return level ? this.logs.filter((l) => l.level === level) : [...this.logs];
  }
}

/* ─── Alert manager ───────────────────────────────────────────────────────── */

export interface AlertCheckInput {
  metric: string;
  value: number;
  threshold: number;
}

export class AlertManager {
  private listeners = new Map<string, (alert: AlertCheckInput) => void>();
  private lastValue = new Map<string, number>();

  on(metric: string, cb: (alert: AlertCheckInput) => void): void {
    this.listeners.set(metric, cb);
  }

  check(input: AlertCheckInput): void {
    this.lastValue.set(input.metric, input.value);
    if (input.value > input.threshold) {
      const cb = this.listeners.get(input.metric);
      if (cb) cb(input);
    }
  }

  reset(metric: string): void {
    this.lastValue.set(metric, 0);
  }

  getLastValue(metric: string): number {
    return this.lastValue.get(metric) ?? 0;
  }
}

/* ─── Health check ────────────────────────────────────────────────────────── */

export interface HealthResult {
  status: "healthy" | "degraded" | "unhealthy";
  details: Record<string, unknown>;
}

export interface HealthCheckEngine {
  /** Return true when the subsystem is healthy. */
  isHealthy(deps?: { metrics?: Metrics }): boolean;
}

export interface HealthCheckDependencies {
  metrics?: Metrics;
  /** Check DB connectivity and latency */
  db?: { healthy: boolean; latencyMs?: number };
  /** Check venue (Polymarket CLOB) connectivity */
  venue?: { healthy: boolean; orderbookAgeMs?: number };
  /** Check forecast freshness */
  forecast?: { healthy: boolean; maxAgeSec?: number };
  /** Check signer availability */
  signer?: { healthy: boolean };
  /** Check reconciliation state */
  reconciliation?: { healthy: boolean; unknownOrders?: number };
  /** Check lease/fencing */
  lease?: { healthy: boolean; epoch?: number };
  /** Check clock sync */
  clock?: { healthy: boolean; skewMs?: number };
  /** Check live guard state */
  liveGuard?: { healthy: boolean; mode?: string };
  /** Check risk latch */
  riskLatch?: { healthy: boolean };
}

export class HealthCheck implements HealthCheckEngine {
  isHealthy(deps?: HealthCheckDependencies): boolean {
    // Backward compat: if only metrics passed (legacy tests), just check errors/jobs
    const hasExplicitDeps = !!(
      deps &&
      (deps.db !== undefined ||
        deps.venue !== undefined ||
        deps.forecast !== undefined ||
        deps.signer !== undefined ||
        deps.reconciliation !== undefined ||
        deps.lease !== undefined ||
        deps.clock !== undefined ||
        deps.liveGuard !== undefined ||
        deps.riskLatch !== undefined)
    );

    const metrics = deps?.metrics;
    if (!metrics) return false;
    const errors = metrics.getCounter("errors");
    const jobFailures = metrics.getCounter("jobs.failed");
    if (errors > 0 || jobFailures > 0) return false;

    // If only metrics provided (legacy), consider healthy
    if (!hasExplicitDeps) return true;

    // All critical dependencies must be healthy
    if (!deps.db?.healthy) return false;
    if (!deps.venue?.healthy) return false;
    if (!deps.forecast?.healthy) return false;
    if (!deps.signer?.healthy) return false;
    if (!deps.reconciliation?.healthy) return false;
    if (!deps.lease?.healthy) return false;
    if (!deps.clock?.healthy) return false;
    if (!deps.liveGuard?.healthy) return false;
    if (!deps.riskLatch?.healthy) return false;

    // Additional thresholds
    if (
      deps.forecast &&
      deps.forecast.maxAgeSec !== undefined &&
      deps.forecast.maxAgeSec > 300
    )
      return false;
    if (
      deps.clock &&
      deps.clock.skewMs !== undefined &&
      deps.clock.skewMs > 500
    )
      return false;
    if (
      deps.reconciliation &&
      deps.reconciliation.unknownOrders !== undefined &&
      deps.reconciliation.unknownOrders > 10
    )
      return false;

    return true;
  }

  check(deps?: HealthCheckDependencies): HealthResult {
    const ok = this.isHealthy(deps);
    const details: Record<string, unknown> = {
      metrics: deps?.metrics?.snapshot() ?? {},
      checks: {
        db: deps?.db ?? { healthy: false, reason: "not provided" },
        venue: deps?.venue ?? { healthy: false, reason: "not provided" },
        forecast: deps?.forecast ?? { healthy: false, reason: "not provided" },
        signer: deps?.signer ?? { healthy: false, reason: "not provided" },
        reconciliation: deps?.reconciliation ?? {
          healthy: false,
          reason: "not provided",
        },
        lease: deps?.lease ?? { healthy: false, reason: "not provided" },
        clock: deps?.clock ?? { healthy: false, reason: "not provided" },
        liveGuard: deps?.liveGuard ?? {
          healthy: false,
          reason: "not provided",
        },
        riskLatch: deps?.riskLatch ?? {
          healthy: false,
          reason: "not provided",
        },
      },
    };
    return {
      status: ok ? "healthy" : "unhealthy",
      details,
    };
  }
}

export * from "./status-board.js";
export * from "./telegram-stream.js";

export {
  formatBatchedDigest,
  formatTradeAlert,
  formatRiskGateAlert,
  DigestThrottle,
} from "./telegram-stream.js";
