import { bootstrapAgent } from "./main.js";

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

export function parseArgs(argv: string[] = process.argv.slice(2)): CLIConfig {
  let mode: CLIConfig["mode"] = "PAPER";
  let databaseUrl = "";
  let kmsKeyId = "";
  let once = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      console.log("Usage: polyroot --mode PAPER --db <DATABASE_URL> --kms-key <KEY_ID> [--once]");
      process.exit(0);
    } else if (a === "--mode") {
      mode = argv[++i] as CLIConfig["mode"];
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
  const envMode = getEnv("RUNTIME_MODE") as CLIConfig["mode"] | undefined;
  if (mode === "PAPER" && envMode) mode = envMode;

  if (!databaseUrl) throw new Error("DATABASE_URL required (--db or DATABASE_URL env)");
  if (!kmsKeyId) throw new Error("KMS_KEY_ID required (--kms-key or KMS_KEY_ID env)");

  return { mode, databaseUrl, kmsKeyId, kmsEndpoint: "", kmsRegion: "", once };
}

export async function startAgent(config: CLIConfig): Promise<void> {
  console.log("PolyRoot Agent starting in " + config.mode + " mode");
  const agent = await bootstrapAgent(config.databaseUrl, config.mode);
  const pipeline = agent.pipeline as unknown as {
    runContinuous: () => Promise<void>;
    processMarket: (input: { market_id: string; bid: number; ask: number }) => Promise<unknown>;
  };

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

  const shutdown = () => {
    const p = agent.pipeline as unknown as { stop?: () => void };
    if (typeof p.stop === "function") p.stop();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await pipeline.runContinuous();
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const config = parseArgs(argv);
  await startAgent(config);
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith("cli.ts");
if (isMain) {
  main().catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
