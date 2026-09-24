import { existsSync } from "node:fs";
import { bootstrapAgent } from "./main.js";
import { MetricsExporter } from "./metrics-exporter.js";
import { MetricsServer } from "./metrics-server.js";

/** Load .env via Node's native loader when present (never overrides real env). */
export function loadDotEnv(dotenvPath = ".env"): void {
  if (existsSync(dotenvPath)) {
    process.loadEnvFile(dotenvPath);
  }
}

/**
 * Fail-closed env validation beyond parseArgs. PAPER/SHADOW need only the
 * database; live modes additionally require an explicit wallet key and the
 * distinct deposit-wallet account/funder addresses.
 */
export function assertRuntimeEnv(
  mode: CLIConfig["mode"],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const isLive = mode === "MICRO_LIVE" || mode === "LIVE";
  if (!isLive) return;
  const hasKey = Boolean(env["PRIVATE_KEY_HEX"] ?? env["WALLET_PRIVATE_KEY"]);
  if (!hasKey) {
    throw new Error(
      "LIVE_ENV_MISSING: PRIVATE_KEY_HEX (or WALLET_PRIVATE_KEY) is required for MICRO_LIVE/LIVE",
    );
  }
  const account = env["WALLET_ACCOUNT"];
  const funder = env["WALLET_FUNDER"];
  if (!account || !funder) {
    throw new Error(
      "LIVE_ENV_MISSING: WALLET_ACCOUNT and WALLET_FUNDER are required for MICRO_LIVE/LIVE (must differ from the signer address)",
    );
  }
  if (account.toLowerCase() === funder.toLowerCase()) {
    throw new Error(
      "LIVE_ENV_INVALID: WALLET_ACCOUNT and WALLET_FUNDER must be distinct (WAL-03)",
    );
  }
}

export interface CLIConfig {
  mode: "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE";
  databaseUrl: string;
  kmsKeyId: string;
  kmsEndpoint: string;
  kmsRegion: string;
  once: boolean;
}

function getEnv(key: string): string | undefined {
  return process.env[key];
}

const MODES = ["PAPER", "SHADOW", "MICRO_LIVE", "LIVE"] as const;

function parseMode(raw: string | undefined, source: string): CLIConfig["mode"] {
  if (!raw || !(MODES as readonly string[]).includes(raw)) {
    throw new Error(
      `Invalid mode ${JSON.stringify(raw)} from ${source}; expected one of ${MODES.join(", ")}`,
    );
  }
  return raw as CLIConfig["mode"];
}

export function parseArgs(argv: string[] = process.argv.slice(2)): CLIConfig {
  let mode: CLIConfig["mode"] = "PAPER";
  let databaseUrl = "";
  let kmsKeyId = "";
  let once = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      console.log(
        "Usage: polyroot --mode PAPER --db <DATABASE_URL> --kms-key <KEY_ID> [--once]",
      );
      process.exit(0);
    } else if (a === "--mode") {
      mode = parseMode(argv[++i], "--mode");
    } else if (a === "--db" || a === "--database-url") {
      databaseUrl = argv[++i] ?? "";
    } else if (a === "--kms-key") {
      kmsKeyId = argv[++i] ?? "";
    } else if (a === "--once") {
      once = true;
    }
  }

  if (!databaseUrl) databaseUrl = getEnv("DATABASE_URL") ?? "";
  if (!kmsKeyId) kmsKeyId = getEnv("KMS_KEY_ID") ?? "";
  const envMode = getEnv("RUNTIME_MODE");
  if (mode === "PAPER" && envMode) mode = parseMode(envMode, "RUNTIME_MODE");

  if (!databaseUrl)
    throw new Error("DATABASE_URL required (--db or DATABASE_URL env)");
  if (!kmsKeyId)
    throw new Error("KMS_KEY_ID required (--kms-key or KMS_KEY_ID env)");

  return { mode, databaseUrl, kmsKeyId, kmsEndpoint: "", kmsRegion: "", once };
}

import { createSignerFromEnv } from "@polyroot/signer";
import { PolymarketVenueAdapter } from "@polyroot/venue";

export async function startAgent(config: CLIConfig): Promise<void> {
  console.log("PolyRoot Agent starting in " + config.mode + " mode");
  const isLive = config.mode === "MICRO_LIVE" || config.mode === "LIVE";
  const agent = await bootstrapAgent(
    config.databaseUrl,
    config.mode,
    isLive
      ? {
          cryptoSigner: createSignerFromEnv(),
          venueAdapter: new PolymarketVenueAdapter({}),
        }
      : {},
  );
  const pipeline = agent.pipeline as unknown as {
    runContinuous: () => Promise<void>;
    processMarket: (input: {
      market_id: string;
      bid: number;
      ask: number;
    }) => Promise<unknown>;
  };

  // Metrics HTTP server lifecycle (Task 5 follow-up). Disabled with a
  // warning when POLYROOT_METRICS_OWNER_KEY is unset — never serve
  // financial metrics without authentication.
  const metricsOwnerKey = getEnv("POLYROOT_METRICS_OWNER_KEY") ?? "";
  const metricsHost = getEnv("POLYROOT_METRICS_HOST");
  const metricsPortRaw = getEnv("POLYROOT_METRICS_PORT");
  const metricsServer = metricsOwnerKey
    ? new MetricsServer({
        exporter: new MetricsExporter(agent.metrics),
        ownerKey: metricsOwnerKey,
        ...(metricsHost !== undefined ? { host: metricsHost } : {}),
        ...(metricsPortRaw !== undefined
          ? { port: Number(metricsPortRaw) }
          : {}),
      })
    : undefined;
  if (!metricsServer) {
    console.warn(
      "POLYROOT_METRICS_OWNER_KEY unset — /metrics endpoint disabled",
    );
  }

  if (config.once) {
    const result = await pipeline.processMarket({
      market_id: "mock_market_1",
      bid: 0.45,
      ask: 0.55,
    });
    console.log("Once result: " + JSON.stringify(result));
    await agent.pool.end().catch(() => undefined);
    return;
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal} — stopping agent...`);
    const p = agent.pipeline as unknown as { stop?: () => void };
    if (typeof p.stop === "function") {
      try {
        p.stop();
      } catch (err: unknown) {
        console.error("Pipeline stop error:", err);
      }
    }
    if (metricsServer) {
      void metricsServer
        .stop()
        .catch((err: unknown) =>
          console.error("Metrics server stop error:", err),
        );
    }
    // Close the shared PG pool so the event loop can drain, then exit.
    // Without this the process hangs on open pool sockets until SIGKILL.
    void agent.pool
      .end()
      .catch((err: unknown) => console.error("Pool close error:", err))
      .finally(() => process.exit(0));
    // Failsafe: never hang forever on shutdown.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  if (metricsServer) {
    const addr = await metricsServer.start();
    console.log(`Metrics server listening on ${addr.host}:${addr.port}`);
  }
  await pipeline.runContinuous();
  // Resolved without a signal (e.g. stop() called externally):
  // close the pool so the process can exit cleanly.
  if (!stopping) {
    if (metricsServer) {
      await metricsServer.stop().catch(() => undefined);
    }
    await agent.pool.end().catch(() => undefined);
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  loadDotEnv();
  const config = parseArgs(argv);
  assertRuntimeEnv(config.mode);
  await startAgent(config);
}

const isMain =
  process.argv[1] !== undefined && process.argv[1].endsWith("cli.ts");
if (isMain) {
  main().catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
