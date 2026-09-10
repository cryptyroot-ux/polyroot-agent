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

  snapshot(): { counters: Record<string, number>; gauges: Record<string, number>; histograms: Record<string, number[]> } {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: Object.fromEntries(this.histograms),
    };
  }
}

/* ─── Redacting logger ────────────────────────────────────────────────────── */

export type LogLevel = "debug" | "info" | "warn" | "error";

const REDACT_KEYS = new Set(["secret", "token", "key", "password", "credential", "private_key", "api_key", "signature", "mnemonic", "privatekey"]);

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
  return value;
}

export class Logger {
  private logs: LogEntry[] = [];

  private log(level: LogLevel, msg: string, meta: Record<string, unknown> = {}): void {
    const redacted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      redacted[k] = REDACT_KEYS.has(k.toLowerCase()) ? redactValue(v) : v;
    }
    this.logs.push({ level, msg, meta: redacted, at: Date.now() });
  }

  debug(msg: string, meta?: Record<string, unknown>): void { this.log("debug", msg, meta); }
  info(msg: string, meta?: Record<string, unknown>): void { this.log("info", msg, meta); }
  warn(msg: string, meta?: Record<string, unknown>): void { this.log("warn", msg, meta); }
  error(msg: string, meta?: Record<string, unknown>): void { this.log("error", msg, meta); }

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

export class HealthCheck implements HealthCheckEngine {
  isHealthy(opts?: { metrics?: Metrics }): boolean {
    const metrics = opts?.metrics;
    if (!metrics) return true;
    const errors = metrics.getCounter("errors");
    const jobFailures = metrics.getCounter("jobs.failed");
    return errors === 0 && jobFailures === 0;
  }

  check(opts?: { metrics?: Metrics }): HealthResult {
    const ok = this.isHealthy(opts);
    const details: Record<string, unknown> = { metrics: opts?.metrics?.snapshot() ?? {} };
    return {
      status: ok ? "healthy" : "unhealthy",
      details,
    };
  }
}