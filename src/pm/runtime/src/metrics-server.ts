import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
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
        res
          .writeHead(405, { "content-type": "text/plain" })
          .end("method not allowed");
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
          res
            .writeHead(401, { "content-type": "text/plain" })
            .end("unauthorized");
          return;
        }
        res
          .writeHead(200, { "content-type": "text/plain; version=0.0.4" })
          .end(this.exporter.getMetrics());
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    } catch {
      res
        .writeHead(500, { "content-type": "text/plain" })
        .end("internal error");
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
