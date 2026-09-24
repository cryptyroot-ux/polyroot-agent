import { existsSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from "node:fs";
import { Pool } from "pg";
import { deriveAddressFromPrivateKey, sealPrivateKey } from "@polyroot/signer";
import { randomBytes } from "node:crypto";
import {
  PgLiveGuardStore,
  checkShadowBaselineRow,
  decideGuardReset,
} from "./live-guard-store.js";
import { bootstrapAgent } from "./main.js";
import { MetricsExporter } from "./metrics-exporter.js";
import { MetricsServer } from "./metrics-server.js";

/**
 * Load .env via Node's native loader when present (never overrides real env).
 * Resolves from the current directory upward so `npm start` (workspace cwd)
 * and repo-root invocations both find the repo .env.
 */
export function loadDotEnv(dotenvPath?: string): string | undefined {
  const candidates =
    dotenvPath !== undefined
      ? [dotenvPath]
      : [".env", "../.env", "../../.env", "../../../.env"];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
  }
  return undefined;
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
  const hasKeystore = Boolean(env["POLYROOT_KEYSTORE_JSON"]);
  const hasPassphrase = Boolean(env["POLYROOT_KEYSTORE_PASSPHRASE"]);
  const hasRawKey = Boolean(env["PRIVATE_KEY_HEX"] ?? env["WALLET_PRIVATE_KEY"]);
  if (!hasKeystore && !hasRawKey) {
    throw new Error(
      "LIVE_ENV_MISSING: PRIVATE_KEY_HEX (or WALLET_PRIVATE_KEY) is required for MICRO_LIVE/LIVE when not using a keystore.\n" +
      "Option A: set PRIVATE_KEY_HEX or WALLET_PRIVATE_KEY.\n" +
      "Option B: use a sealed keystore (POLYROOT_KEYSTORE_JSON + POLYROOT_KEYSTORE_PASSPHRASE)."
    );
  }
  if (hasKeystore && !hasPassphrase && !hasRawKey) {
    throw new Error("LIVE_ENV_MISSING: POLYROOT_KEYSTORE_PASSPHRASE is required with POLYROOT_KEYSTORE_JSON");
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
  // KMS is not used: key custody is keystore + dedicated wallet + caps.
  // The flag stays accepted for backwards compatibility but is optional.
  const hasKeystore = Boolean(getEnv("POLYROOT_KEYSTORE_JSON") || getEnv("POLYROOT_KEYSTORE_FILE"));
  if (!kmsKeyId) kmsKeyId = getEnv("KMS_KEY_ID") ?? "";
  const envMode = getEnv("RUNTIME_MODE");
  if (mode === "PAPER" && envMode) mode = parseMode(envMode, "RUNTIME_MODE");

  if (!databaseUrl)
    throw new Error("DATABASE_URL required (--db or DATABASE_URL env)");
  if (!hasKeystore && !kmsKeyId)
    throw new Error(
      "KMS_KEY_ID required (--kms-key or KMS_KEY_ID env) when not using a keystore.\n" +
      "Option A: export KMS_KEY_ID + AWS credentials.\n" +
      "Option B: use a sealed keystore (POLYROOT_KEYSTORE_JSON + POLYROOT_KEYSTORE_PASSPHRASE)."
    );

  return { mode, databaseUrl, kmsKeyId, kmsEndpoint: "", kmsRegion: "", once };
}

const POLYROOT_HOME = process.env["HOME"] ? `${process.env["HOME"]}/.polyroot` : "/tmp/.polyroot";
const ENV_PATH = `${POLYROOT_HOME}/.env`;
const KEYSTORE_PATH = `${POLYROOT_HOME}/keystore.json`;

interface OnboardingConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  walletType: "create" | "import";
  privateKey?: string;
  passphrase: string;
  mode: "PAPER" | "LIVE";
}

function ensurePolyrootHome(): void {
  if (!existsSync(POLYROOT_HOME)) {
    mkdirSync(POLYROOT_HOME, { recursive: true, mode: 0o700 });
  }
}

function isFirstRun(): boolean {
  return !existsSync(ENV_PATH);
}

function prompt(message: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(message);
    process.stdin.once("data", (data) => {
      resolve(data.toString().trim());
    });
  });
}

function promptSecret(message: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdin.setRawMode(true);
    stdout.write(message);
    let input = "";
    stdin.on("data", (char) => {
      const c = char.toString();
      if (c === "\n" || c === "\r") {
        stdin.setRawMode(false);
        stdout.write("\n");
        stdin.pause();
        resolve(input);
        return;
      }
      if (c === "\u0003") {
        stdin.setRawMode(false);
        process.exit(1);
      }
      if (c === "\u007f" || c === "\b") {
        if (input.length > 0) {
          input = input.slice(0, -1);
          stdout.write("\b \b");
        }
        return;
      }
      input += c;
      stdout.write("*");
    });
    stdin.resume();
  });
}

function selectOption(message: string, options: string[]): Promise<string> {
  return new Promise((resolve) => {
    console.log(message);
    options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
    const ask = () => {
      process.stdout.write("Select [1-" + options.length + "]: ");
      process.stdin.once("data", (data) => {
        const idx = parseInt(data.toString().trim(), 10) - 1;
        if (idx >= 0 && idx < options.length) {
          const selected = options[idx];
          if (selected) resolve(selected);
          else ask();
        } else {
          console.log("Invalid selection. Try again.");
          ask();
        }
      });
    };
    ask();
  });
}

async function runOnboarding(): Promise<OnboardingConfig> {
  console.log("\n═══════════════════════════════════════════════");
  console.log("  Welcome to PolyRoot Agent — First Run Setup");
  console.log("═══════════════════════════════════════════════\n");

  // 1. AI Provider & Model
  console.log("📡 Step 1/3: Choose AI Provider & Model");
  const provider = await selectOption("Select provider:", [
    "OpenAI (GPT-4o, GPT-4o-mini)",
    "9Router / OpenAI-compatible",
    "Ollama (local)",
    "Custom OpenAI-compatible endpoint",
  ]);

  let model = "";
  let baseUrl = "";
  let apiKey = "";

  if (provider.includes("OpenAI")) {
    model = await selectOption("Select model:", ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo"]);
    apiKey = await promptSecret("Enter OpenAI API Key (sk-...): ");
  } else if (provider.includes("9Router")) {
    model = await prompt("Model name (e.g., gpt-4o-mini): ");
    baseUrl = await prompt("Base URL [https://files.pango.fun/v1]: ") || "https://files.pango.fun/v1";
    apiKey = await promptSecret("Enter 9Router API Key: ");
  } else if (provider.includes("Ollama")) {
    model = await prompt("Model name (e.g., llama3.1): ");
    baseUrl = await prompt("Base URL [http://localhost:11434/v1]: ") || "http://localhost:11434/v1";
    apiKey = "ollama"; // dummy
  } else {
    model = await prompt("Model name: ");
    baseUrl = await prompt("Base URL: ");
    apiKey = await promptSecret("API Key: ");
  }

  // 2. Wallet
  console.log("\n🔐 Step 2/3: Wallet Setup");
  const walletChoice = await selectOption("Wallet:", [
    "Create new wallet (generates keystore)",
    "Import existing private key",
  ]);

  let privateKey = "";
  let passphrase = "";

  if (walletChoice.startsWith("Create")) {
    passphrase = await promptSecret("Set keystore passphrase: ");
    const confirm = await promptSecret("Confirm passphrase: ");
    if (passphrase !== confirm) {
      throw new Error("Passphrases do not match");
    }
    // Generate random key
    privateKey = "0x" + randomBytes(32).toString("hex");
    console.log(`\n✅ New wallet generated!`);
    console.log(`   Address: ${deriveAddressFromPrivateKey(privateKey)}`);
    console.log(`   Private Key: ${privateKey}`);
    console.log(`   (Save these — they are shown only once)`);
  } else {
    privateKey = await promptSecret("Enter private key (0x...): ");
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new Error("Invalid private key format");
    }
    passphrase = await promptSecret("Set keystore passphrase: ");
    console.log(`\n✅ Wallet imported. Address: ${deriveAddressFromPrivateKey(privateKey)}`);
  }

  // Seal keystore
  const keystore = sealPrivateKey(privateKey, passphrase);
  ensurePolyrootHome();
  writeFileSync(KEYSTORE_PATH, JSON.stringify(keystore, null, 2) + "\n", { mode: 0o600 });
  chmodSync(KEYSTORE_PATH, 0o600);
  console.log(`🔐 Keystore saved to ${KEYSTORE_PATH} (encrypted, 600 perms)`);

  // 3. Mode selection
  console.log("\n🚀 Step 3/3: Select Mode");
  const mode = await selectOption("Run mode:", [
    "PAPER — Safe simulation, mock data, no real money",
    "LIVE — Real trading on Polymarket (requires capital, API keys)",
  ]) === "PAPER — Safe simulation, mock data, no real money" ? "PAPER" : "LIVE";

  return { provider, model, apiKey, baseUrl, walletType: walletChoice.startsWith("Create") ? "create" : "import", privateKey, passphrase, mode };
}

function writeEnv(config: OnboardingConfig): void {
  ensurePolyrootHome();
  const lines = [
    "# PolyRoot Agent — Auto-generated by onboarding",
    `DATABASE_URL=postgresql://polyroot:polyroot@localhost:5432/polyroot`,
    `RUNTIME_MODE=${config.mode}`,
    `POLYROOT_KEYSTORE_JSON=${JSON.stringify(sealPrivateKey(config.privateKey!, config.passphrase))}`,
    `POLYROOT_KEYSTORE_PASSPHRASE=${config.passphrase}`,
    `WALLET_ADDRESS=${deriveAddressFromPrivateKey(config.privateKey!)}`,
    `# WALLET_ACCOUNT and WALLET_FUNDER must be set for LIVE mode (3 distinct addresses)`,
    `RPC_URL=https://polygon-rpc.com`,
    `POLYROOT_FORECAST_PROVIDER=${config.provider.includes("OpenAI") ? "openai" : "custom"}`,
    `POLYROOT_FORECAST_MODEL=${config.model}`,
    `OPENAI_API_KEY=${config.apiKey}`,
    ...(config.baseUrl ? [`OPENAI_BASE_URL=${config.baseUrl}`] : []),
    "",
    "# For LIVE mode, uncomment and configure:",
    "# POLYMARKET_API_KEY=",
    "# POLYMARKET_API_SECRET=",
    "# POLYMARKET_API_PASSPHRASE=",
    "# WALLET_ACCOUNT=",
    "# WALLET_FUNDER=",
    "# POLYROOT_MICRO_LIVE_LOSS_CAP_USD=100",
  ];
  writeFileSync(ENV_PATH, lines.join("\n"), { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);
  console.log(`\n✅ Configuration saved to ${ENV_PATH} (600 perms)`);
}

async function runFirstTimeSetup(): Promise<void> {
  if (!isFirstRun()) return;

  console.log("\n🎉 First run detected — launching interactive setup...\n");
  try {
    const config = await runOnboarding();
    writeEnv(config);
    console.log("\n═══════════════════════════════════════════════");
    console.log("  Setup complete! Starting PolyRoot Agent...");
    console.log("═══════════════════════════════════════════════\n");

    // Reload env for current process
    process.loadEnvFile(ENV_PATH as string);
  } catch (err) {
    console.error("\n❌ Setup failed:", (err as Error).message);
    process.exit(1);
  }
}

import { createSignerFromEnv } from "@polyroot/signer";
import {
  buildLiveVenueAdapter,
  buildPublicVenueAdapter,
  runVenueCheck,
} from "@polyroot/venue";

export async function startAgent(config: CLIConfig): Promise<void> {
  console.log("PolyRoot Agent starting in " + config.mode + " mode");
  const isLive = config.mode === "MICRO_LIVE" || config.mode === "LIVE";
  const agent = await bootstrapAgent(
    config.databaseUrl,
    config.mode,
    isLive
      ? {
          cryptoSigner: createSignerFromEnv(),
          // Authenticated secure client (reads live books; submission of
          // domain SignedOrders stays refused until CLOB translation lands).
          venueAdapter: await buildLiveVenueAdapter(),
        }
      : config.mode === "SHADOW"
        ? { venueAdapter: buildPublicVenueAdapter() }
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

  // Metrics/health HTTP server for agent runs. The server is started for
  // continuous runs so public /healthz is available; /metrics stays disabled
  // without POLYROOT_METRICS_OWNER_KEY. `--once` exits before `start()`.
  const metricsOwnerKey = getEnv("POLYROOT_METRICS_OWNER_KEY") ?? "";
  const metricsHost = getEnv("POLYROOT_METRICS_HOST");
  const metricsPortRaw = getEnv("POLYROOT_METRICS_PORT");
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
    void metricsServer
      .stop()
      .catch((err: unknown) =>
        console.error("Metrics server stop error:", err),
      );
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
    await metricsServer.stop().catch(() => undefined);
    await agent.pool.end().catch(() => undefined);
  }
}

/**
 * MICRO_LIVE startup gate: refuse to start without SHADOW baseline
 * evidence (30 days / 100 resolved clusters) in the database.
 */
export async function assertMicroLiveReady(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const res = await pool.query(
      `SELECT observed_days, resolved_clusters FROM shadow_baseline
       WHERE id = '00000000-0000-0000-0000-000000000001'`,
    );
    const verdict = checkShadowBaselineRow(
      (res.rows[0] ?? null) as {
        observed_days: unknown;
        resolved_clusters: unknown;
      } | null,
    );
    if (!verdict.ok) {
      throw new Error(`${verdict.code}: ${verdict.reason}`);
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export interface GuardResetResult {
  ok: boolean;
  detail: string;
}

/**
 * Explicit owner latch reset: clears a halted breach ONLY when the
 * owner-measured realized loss is back under the configured loss cap.
 */
export async function runGuardReset(
  databaseUrl: string,
  realizedLossPusd: number,
  lossCapPusd: number,
): Promise<GuardResetResult> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const store = new PgLiveGuardStore(pool);
    const state = await store.load();
    const verdict = decideGuardReset(state, realizedLossPusd, lossCapPusd);
    if (!verdict.ok) {
      return { ok: false, detail: `${verdict.code}: ${verdict.reason}` };
    }
    if (state?.halted) {
      await store.save({ halted: false, realizedLossPusd });
    }
    return { ok: true, detail: verdict.reason };
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** Single wallet verification check result. */
export interface WalletCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Result of `polyroot wallet verify` (no agent started, no network). */
export interface WalletVerifyResult {
  ok: boolean;
  address?: string;
  checks: WalletCheck[];
}

/**
 * Verify wallet env without starting the agent: key format, derived
 * address vs WALLET_ADDRESS, and WAL-03 account/funder distinctness.
 */
export function runWalletVerify(
  env: NodeJS.ProcessEnv = process.env,
): WalletVerifyResult {
  const checks: WalletCheck[] = [];
  const rawKey = env["PRIVATE_KEY_HEX"] ?? env["WALLET_PRIVATE_KEY"] ?? "";
  if (!rawKey) {
    checks.push({
      name: "key-present",
      ok: false,
      detail: "PRIVATE_KEY_HEX (or WALLET_PRIVATE_KEY) is not set",
    });
    return { ok: false, checks };
  }
  checks.push({ name: "key-present", ok: true, detail: "wallet key is set" });
  let address: string;
  try {
    address = deriveAddressFromPrivateKey(rawKey);
  } catch {
    checks.push({
      name: "key-format",
      ok: false,
      detail: "key is not 64 hex characters",
    });
    return { ok: false, checks };
  }
  checks.push({
    name: "key-format",
    ok: true,
    detail: `derived address ${address}`,
  });
  const declared = env["WALLET_ADDRESS"];
  if (declared) {
    const match = declared.toLowerCase() === address.toLowerCase();
    checks.push({
      name: "address-match",
      ok: match,
      detail: match
        ? "WALLET_ADDRESS matches the derived address"
        : `WALLET_ADDRESS ${declared} does NOT match derived ${address}`,
    });
  } else {
    checks.push({
      name: "address-match",
      ok: true,
      detail: `WALLET_ADDRESS unset — derived address is ${address}`,
    });
  }
  const account = env["WALLET_ACCOUNT"] ?? "";
  const funder = env["WALLET_FUNDER"] ?? "";
  if (!account || !funder) {
    checks.push({
      name: "account-funder",
      ok: false,
      detail: "WALLET_ACCOUNT and WALLET_FUNDER must both be set",
    });
  } else {
    const lower = (a: string): string => a.toLowerCase();
    const distinct =
      lower(account) !== lower(address) &&
      lower(funder) !== lower(address) &&
      lower(account) !== lower(funder);
    checks.push({
      name: "account-funder",
      ok: distinct,
      detail: distinct
        ? "signer, account and funder are three distinct addresses (WAL-03)"
        : "signer, account and funder must be three distinct addresses (WAL-03)",
    });
  }
  return { ok: checks.every((c) => c.ok), address, checks };
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  loadDotEnv();
  if (argv[0] === "wallet" && argv[1] === "verify") {
    const result = runWalletVerify();
    for (const c of result.checks) {
      console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
    }
    if (!result.ok) process.exit(1);
    return;
  }
  if (argv[0] === "wallet" && argv[1] === "seal") {
    const rawKey =
      process.env["PRIVATE_KEY_HEX"] ?? process.env["WALLET_PRIVATE_KEY"] ?? "";
    const passphrase = process.env["POLYROOT_KEYSTORE_PASSPHRASE"] ?? "";
    if (!rawKey || !passphrase) {
      console.error(
        "Usage: PRIVATE_KEY_HEX=0x... POLYROOT_KEYSTORE_PASSPHRASE=... " +
          "polyroot wallet seal [--out <path>] " +
          "(prints the sealed envelope; the raw key is never printed)",
      );
      process.exit(1);
    }
    const envelope = sealPrivateKey(rawKey, passphrase);
    const outIdx = argv.indexOf("--out");
    const outPath =
      outIdx >= 0 && argv[outIdx + 1] && !argv[outIdx + 1]?.startsWith("--")
        ? (argv[outIdx + 1] as string)
        : "";
    if (outPath) {
      writeFileSync(outPath, JSON.stringify(envelope, null, 2) + "\n", {
        mode: 0o600,
      });
      try {
        chmodSync(outPath, 0o600);
      } catch {
        // best-effort hardening on platforms without chmod semantics
      }
      console.log(`PASS wallet-seal: envelope written to ${outPath}`);
    } else {
      console.log(JSON.stringify(envelope));
    }
    return;
  }
  if (argv[0] === "venue" && argv[1] === "check") {
    const assetId = argv[argv.indexOf("--asset") + 1] ?? "";
    if (!assetId || assetId.startsWith("--")) {
      console.error("Usage: polyroot venue check --asset <token-id>");
      process.exit(1);
    }
    const result = await runVenueCheck(assetId);
    console.log(
      `${result.ok ? "PASS" : "FAIL"} venue-check ${result.assetId}: ${result.detail}`,
    );
    if (!result.ok) process.exit(1);
    return;
  }
  if (argv[0] === "guard" && argv[1] === "reset") {
    const lossRaw = argv[argv.indexOf("--loss") + 1] ?? "";
    const loss = Number(lossRaw);
    const capRaw = process.env["POLYROOT_MICRO_LIVE_LOSS_CAP_USD"] ?? "";
    const cap = Number(capRaw);
    const dbUrl = process.env["DATABASE_URL"] ?? "";
    if (!dbUrl || !Number.isFinite(loss) || !Number.isFinite(cap)) {
      console.error(
        "Usage: polyroot guard reset --loss <realized-loss-pusd> " +
          "(requires DATABASE_URL + POLYROOT_MICRO_LIVE_LOSS_CAP_USD)",
      );
      process.exit(1);
    }
    const result = await runGuardReset(dbUrl, loss, cap);
    console.log(`${result.ok ? "PASS" : "FAIL"} guard-reset: ${result.detail}`);
    if (!result.ok) process.exit(1);
    return;
  }

  // First-run onboarding (skip for subcommands)
  if (argv[0] !== "wallet" && argv[0] !== "venue" && argv[0] !== "guard") {
    await runFirstTimeSetup();
  }

  const config = parseArgs(argv);
  assertRuntimeEnv(config.mode);
  if (config.mode === "MICRO_LIVE") {
    await assertMicroLiveReady(config.databaseUrl);
  }
  await startAgent(config);
}

const isMain =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("cli.js"));
if (isMain) {
  main().catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
