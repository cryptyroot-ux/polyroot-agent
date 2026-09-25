import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { Pool } from "pg";
import { deriveAddressFromPrivateKey, sealPrivateKey } from "@polyroot/signer";
import { randomBytes } from "node:crypto";
import {
  PgLiveGuardStore,
  checkShadowBaselineRow,
  decideGuardReset,
} from "./live-guard-store.js";
import { AUTONOMY_BOUNDS, resolveLossCapPusd } from "./autonomy-bounds.js";
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
  const hasRawKey = Boolean(
    env["PRIVATE_KEY_HEX"] ?? env["WALLET_PRIVATE_KEY"],
  );
  if (!hasKeystore && !hasRawKey) {
    throw new Error(
      "LIVE_ENV_MISSING: PRIVATE_KEY_HEX (or WALLET_PRIVATE_KEY) is required for MICRO_LIVE/LIVE when not using a keystore.\n" +
        "Option A: set PRIVATE_KEY_HEX or WALLET_PRIVATE_KEY.\n" +
        "Option B: use a sealed keystore (POLYROOT_KEYSTORE_JSON + POLYROOT_KEYSTORE_PASSPHRASE).",
    );
  }
  if (hasKeystore && !hasPassphrase && !hasRawKey) {
    throw new Error(
      "LIVE_ENV_MISSING: POLYROOT_KEYSTORE_PASSPHRASE is required with POLYROOT_KEYSTORE_JSON",
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
        "PolyRoot Agent — commands:\n" +
          "  polyroot                 Run the agent (mode from settings)\n" +
          "  polyroot onboard         First-time setup (new users)\n" +
          "  polyroot setup           Change mode, capital, loss cap, markets\n" +
          "  polyroot status          Show current configuration\n" +
          "  polyroot doctor          Basic health check\n" +
          "  polyroot doctor --live   LIVE readiness test, required before real money\n" +
          "  polyroot wallet verify   Check wallet with no network\n" +
          "  polyroot guard reset --loss <loss>   Unlock the loss latch\n" +
          "  polyroot --once          Run once then stop (test)",
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
  const hasKeystore = Boolean(
    getEnv("POLYROOT_KEYSTORE_JSON") || getEnv("POLYROOT_KEYSTORE_FILE"),
  );
  if (!kmsKeyId) kmsKeyId = getEnv("KMS_KEY_ID") ?? "";
  const envMode = getEnv("RUNTIME_MODE");
  if (mode === "PAPER" && envMode) mode = parseMode(envMode, "RUNTIME_MODE");

  if (!databaseUrl)
    throw new Error("DATABASE_URL required (--db or DATABASE_URL env)");
  if (!hasKeystore && !kmsKeyId)
    throw new Error(
      "KMS_KEY_ID required (--kms-key or KMS_KEY_ID env) when not using a keystore.\n" +
        "Option A: export KMS_KEY_ID + AWS credentials.\n" +
        "Option B: use a sealed keystore (POLYROOT_KEYSTORE_JSON + POLYROOT_KEYSTORE_PASSPHRASE).",
    );

  return { mode, databaseUrl, kmsKeyId, kmsEndpoint: "", kmsRegion: "", once };
}

const POLYROOT_HOME = process.env["HOME"]
  ? `${process.env["HOME"]}/.polyroot`
  : "/tmp/.polyroot";
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
  /** Owner-set capital cap in USD (LIVE only; PAPER ignores it). */
  capitalUsd: number;
  /** Owner-set daily loss latch in basis points (500 = 5%). */
  lossBps: number;
}

function ensurePolyrootHome(): void {
  if (!existsSync(POLYROOT_HOME)) {
    mkdirSync(POLYROOT_HOME, { recursive: true, mode: 0o700 });
  }
}

function isFirstRun(): boolean {
  return !existsSync(ENV_PATH);
}

/**
 * Onboarding prompts: ONE shared readline interface per interactive session.
 * A fresh interface per question breaks stdin after the first close (the
 * second prompt sees EOF and the whole flow cancels). Secrets reuse the same
 * interface with output muted, so typed characters never echo.
 */
class OnboardingCancelled extends Error {
  constructor() {
    super("Setup cancelled");
  }
}

interface SharedSession {
  rl: import("node:readline").Interface;
  setMuted: (muted: boolean) => void;
  close: () => void;
}

let sharedSession: SharedSession | undefined;

async function getSharedSession(): Promise<SharedSession> {
  if (!sharedSession) {
    const readline = await import("node:readline");
    const { Writable } = await import("node:stream");
    let muted = false;
    const output = new Writable({
      write(chunk, _encoding, cb): void {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = readline.createInterface({
      input: process.stdin,
      output,
      terminal: true,
    });
    sharedSession = {
      rl,
      setMuted: (m: boolean): void => {
        muted = m;
      },
      close: (): void => {
        try {
          rl.close();
        } catch {
          // already closed — session teardown is best-effort
        }
      },
    };
  }
  return sharedSession;
}

function closeSharedSession(): void {
  sharedSession?.close();
  sharedSession = undefined;
}

/** Ask one question on the shared session. Ctrl-C / EOF cancels cleanly. */
async function askOnShared(
  prompt: string,
  opts: { muted: boolean },
): Promise<string> {
  const session = await getSharedSession();
  session.setMuted(opts.muted);
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const onSigint = (): void => {
        if (!settled) {
          settled = true;
          session.rl.removeListener("SIGINT", onSigint);
          reject(new OnboardingCancelled());
        }
      };
      const onClose = (): void => {
        if (!settled) {
          settled = true;
          session.rl.removeListener("SIGINT", onSigint);
          reject(new OnboardingCancelled());
        }
      };
      session.rl.once("SIGINT", onSigint);
      session.rl.once("close", onClose);
      session.rl.question(prompt, (a: string) => {
        if (!settled) {
          settled = true;
          session.rl.removeListener("SIGINT", onSigint);
          session.rl.removeListener("close", onClose);
          resolve(a ?? "");
        }
      });
    });
  } finally {
    session.setMuted(false);
    console.log("");
  }
}

/** One normal line of input. Blank accepts `defaultValue`; without one, re-ask. */
async function askText(
  message: string,
  opts: { defaultValue?: string } = {},
): Promise<string> {
  const hint = opts.defaultValue !== undefined ? ` [${opts.defaultValue}]` : "";
  for (;;) {
    const answer = await askOnShared(`${message}${hint}: `, { muted: false });
    const text = answer.trim();
    if (text) return text;
    if (opts.defaultValue !== undefined) return opts.defaultValue;
    console.log("Type a value (or press Ctrl-C to cancel).");
  }
}

/** Secret input on the shared session with output muted, so typed
 *  characters never echo. Same stdin lifetime as normal prompts. */
async function askSecret(message: string): Promise<string> {
  process.stdout.write(`${message} (typing hidden): `);
  return askOnShared("", { muted: true });
}

/** Secret input that must not be empty (loops instead of aborting setup). */
async function askRequiredSecret(message: string): Promise<string> {
  for (;;) {
    const value = (await askSecret(message)).trim();
    if (value) return value;
    console.log("A value is required (or press Ctrl-C to cancel).");
  }
}

/** Numbered menu with a marked default (blank = default), Hermes `_ask_index`-style. */
async function askChoice(
  message: string,
  options: string[],
  defaultIdx = 0,
): Promise<string> {
  console.log(message);
  options.forEach((opt, i) => {
    const marker = i === defaultIdx ? "→" : " ";
    console.log(`  ${marker} ${i + 1}. ${opt}`);
  });
  for (;;) {
    const raw = await askText(`Choice [1-${options.length}]`, {
      defaultValue: String(defaultIdx + 1),
    });
    const idx = Number.parseInt(raw, 10) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < options.length) {
      const selected = options[idx];
      if (selected !== undefined) return selected;
    }
    console.log(`Please enter 1-${options.length}`);
  }
}

async function runOnboarding(): Promise<OnboardingConfig> {
  console.log("\n═══════════════════════════════════════════════");
  console.log("  Welcome to PolyRoot Agent — First-Time Setup");
  console.log("  3 steps. Every step has a safe default: just press Enter.");
  console.log("═══════════════════════════════════════════════\n");

  // 1. AI Provider & Model — the brain that reads markets.
  console.log("📡 Step 1/3: AI brain (reads the markets)");
  const provider = await askChoice(
    "Choose AI provider (Enter = default):",
    [
      "OpenAI (GPT-4o, GPT-4o-mini)",
      "9Router / OpenAI-compatible",
      "Ollama (local)",
      "Custom OpenAI-compatible endpoint",
    ],
    1,
  );

  let model = "";
  let baseUrl = "";
  let apiKey = "";

  if (provider === "OpenAI (GPT-4o, GPT-4o-mini)") {
    model = await askChoice(
      "Select model:",
      ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo"],
      0,
    );
    apiKey = await askRequiredSecret("OpenAI API key");
  } else if (provider === "9Router / OpenAI-compatible") {
    model = await askText("Model name", { defaultValue: "gpt-4o-mini" });
    baseUrl = await askText("Base URL", {
      defaultValue: "https://files.pango.fun/v1",
    });
    apiKey = await askRequiredSecret("9Router API key");
  } else if (provider === "Ollama (local)") {
    model = await askText("Model name", { defaultValue: "llama3.1" });
    baseUrl = await askText("Base URL", {
      defaultValue: "http://localhost:11434/v1",
    });
    apiKey = "ollama"; // dummy
  } else {
    model = await askText("Model name");
    baseUrl = await askText("Base URL");
    apiKey = await askRequiredSecret("API key");
  }

  if (!model.trim()) {
    throw new Error("Model name is required");
  }
  if (!apiKey.trim()) {
    throw new Error("API key is required (Ollama local uses any placeholder)");
  }

  // 2. Wallet — keys are sealed in a locked vault on this machine and
  // are never sent anywhere.
  console.log("\n🔐 Step 2/3: Wallet (where your keys live)");
  console.log(
    "   Keys stay locked in a vault on this computer, never sent anywhere.",
  );
  const walletChoice = await askChoice(
    "Wallet (Enter = create new):",
    ["Create new wallet (generates keystore)", "Import existing private key"],
    0,
  );

  let privateKey = "";
  let passphrase = "";

  if (walletChoice.startsWith("Create")) {
    for (;;) {
      passphrase = await askRequiredSecret("Create a vault passphrase");
      const confirm = await askRequiredSecret("Repeat the passphrase");
      if (passphrase === confirm) break;
      console.log("Passphrases do not match — try again.");
    }
    // Generate random key
    privateKey = "0x" + randomBytes(32).toString("hex");
    console.log(`\n✅ New wallet created!`);
    console.log(`   Address: ${deriveAddressFromPrivateKey(privateKey)}`);
    console.log(`   (Write this down — it is shown only once)`);
  } else {
    for (;;) {
      privateKey = await askRequiredSecret("Private key (0x...)");
      if (/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) break;
      console.log("Wrong format — expected 64 hex characters.");
    }
    passphrase = await askRequiredSecret("Create a vault passphrase");
    console.log(
      `\n✅ Wallet imported. Address: ${deriveAddressFromPrivateKey(privateKey)}`,
    );
  }

  // Seal keystore
  const keystore = sealPrivateKey(privateKey, passphrase);
  ensurePolyrootHome();
  writeFileSync(KEYSTORE_PATH, JSON.stringify(keystore, null, 2) + "\n", {
    mode: 0o600,
  });
  chmodSync(KEYSTORE_PATH, 0o600);
  console.log(`🔐 Keystore saved to ${KEYSTORE_PATH} (encrypted, 600 perms)`);

  // 3. Mode selection — PAPER = practice with play money (100% safe).
  console.log("\n🚀 Step 3/3: Choose Mode");
  console.log(
    "   PAPER = practice, play money (100% safe). LIVE = real money.",
  );
  const modeChoice = await askChoice(
    "Choose mode (Enter = PAPER):",
    [
      "PAPER — Safe simulation, mock data, no real money",
      "LIVE — Real trading on Polymarket (requires capital, API keys)",
    ],
    0,
  );
  let mode: "PAPER" | "LIVE" = "PAPER";
  let capitalUsd: number = AUTONOMY_BOUNDS.CAPITAL_CAP_USD;
  let lossBps: number = AUTONOMY_BOUNDS.DAILY_LOSS_CAP_BPS;
  if (modeChoice.startsWith("LIVE")) {
    console.log(
      "\nLIVE uses REAL MONEY. The daily loss cap shuts the system",
      "down automatically when reached (needs your manual reset).",
    );
    const confirm = await askText(
      "Type LIVE to continue (anything else stays PAPER)",
    );
    if (confirm.trim() === "LIVE") {
      mode = "LIVE";
      const capitalRaw = await askText(
        `Capital cap in USD — max money allowed in play (default ${AUTONOMY_BOUNDS.CAPITAL_CAP_USD})`,
        { defaultValue: String(AUTONOMY_BOUNDS.CAPITAL_CAP_USD) },
      );
      const capitalParsed = Number(capitalRaw);
      capitalUsd =
        Number.isFinite(capitalParsed) && capitalParsed > 0
          ? capitalParsed
          : AUTONOMY_BOUNDS.CAPITAL_CAP_USD;
      const bpsRaw = await askText(
        `Daily loss cap in bps, 500 = 5% (default ${AUTONOMY_BOUNDS.DAILY_LOSS_CAP_BPS})`,
        { defaultValue: String(AUTONOMY_BOUNDS.DAILY_LOSS_CAP_BPS) },
      );
      const bpsParsed = Number(bpsRaw);
      lossBps =
        Number.isFinite(bpsParsed) && bpsParsed > 0
          ? bpsParsed
          : AUTONOMY_BOUNDS.DAILY_LOSS_CAP_BPS;
      const lossCap = resolveLossCapPusd(capitalUsd, lossBps) ?? 0;
      console.log(
        `\n✅ Your limits: capital $${capitalUsd}, stop-loss $${lossCap}/day.`,
      );
    } else {
      console.log("Staying on PAPER. Change later with: polyroot setup");
    }
  }

  return {
    provider,
    model,
    apiKey,
    baseUrl,
    walletType: walletChoice.startsWith("Create") ? "create" : "import",
    privateKey,
    passphrase,
    mode,
    capitalUsd,
    lossBps,
  };
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
    `POLYROOT_FORECAST_PROVIDER=${config.provider === "OpenAI (GPT-4o, GPT-4o-mini)" ? "openai" : "custom"}`,
    `POLYROOT_FORECAST_MODEL=${config.model}`,
    `OPENAI_API_KEY=${config.apiKey}`,
    ...(config.baseUrl ? [`OPENAI_BASE_URL=${config.baseUrl}`] : []),
    "",
    "# Owner-set autonomy bounds (managed via `polyroot setup`; the AI path is read-only):",
    `POLYROOT_MICRO_LIVE_CAP_USD=${config.capitalUsd}`,
    `POLYROOT_MICRO_LIVE_LOSS_CAP_USD=${resolveLossCapPusd(config.capitalUsd, config.lossBps) ?? 0}`,
    "",
    "# For LIVE mode, uncomment and configure:",
    "# POLYMARKET_API_KEY=",
    "# POLYMARKET_API_SECRET=",
    "# POLYMARKET_API_PASSPHRASE=",
    "# WALLET_ACCOUNT=",
    "# WALLET_FUNDER=",
  ];
  writeFileSync(ENV_PATH, lines.join("\n"), { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);
  console.log(`\n✅ Configuration saved to ${ENV_PATH} (600 perms)`);
}

async function runOnboardingFlow(): Promise<void> {
  try {
    const config = await runOnboarding();
    writeEnv(config);
    console.log("\n═══════════════════════════════════════════════");
    console.log("  Setup complete! PolyRoot Agent is ready.");
    console.log("═══════════════════════════════════════════════");
    console.log(formatNextSteps(config.mode));

    // Reload env for current process
    process.loadEnvFile(ENV_PATH as string);
    closeSharedSession();
  } catch (err) {
    closeSharedSession();
    if (err instanceof OnboardingCancelled) {
      console.log("\nCancelled. Run 'polyroot onboard' any time.");
      process.exit(0);
    }
    console.error("\n❌ Setup failed:", (err as Error).message);
    process.exit(1);
  }
}

async function runFirstTimeSetup(): Promise<void> {
  if (!isFirstRun()) return;

  console.log("\n🎉 First run — starting interactive setup...\n");
  await runOnboardingFlow();
}

/**
 * `polyroot setup` — re-runnable guided configuration for lay operators.
 * Changes mode, capital cap, loss latch and market universe. NEVER touches
 * the wallet or keys (use `polyroot onboard` for a full reset).
 */
async function runSetupFlow(): Promise<void> {
  try {
    loadDotEnv();
    console.log("\n═══════════════════════════════════════════════");
    console.log("  PolyRoot Setup — Change Settings (safe)");
    console.log("  Wallet & keys are NEVER touched here.");
    console.log("═══════════════════════════════════════════════\n");

    const currentMode = process.env["RUNTIME_MODE"] ?? "PAPER";
    console.log("Current mode: " + currentMode);
    console.log("PAPER = practice with play money. LIVE = real money.\n");
    const modeChoice = await askChoice(
      "Choose mode (Enter = keep current):",
      [
        "PAPER — Safe simulation, mock data, no real money",
        "LIVE — Real trading on Polymarket (requires capital, API keys)",
      ],
      currentMode === "LIVE" ? 1 : 0,
    );
    const mode = (modeChoice.startsWith("LIVE") ? "LIVE" : "PAPER") as
      "PAPER" | "LIVE";

    const bounds = parseBoundsEnv(process.env);
    const capitalRaw = await askText(
      `Capital cap in USD (current ${bounds.capUsd ?? AUTONOMY_BOUNDS.CAPITAL_CAP_USD}, Enter = keep)`,
      {
        defaultValue: String(bounds.capUsd ?? AUTONOMY_BOUNDS.CAPITAL_CAP_USD),
      },
    );
    const capitalParsed = Number(capitalRaw);
    const capitalUsd =
      Number.isFinite(capitalParsed) && capitalParsed > 0
        ? Math.floor(capitalParsed)
        : (bounds.capUsd ?? AUTONOMY_BOUNDS.CAPITAL_CAP_USD);

    console.log(
      "\nDaily loss cap: when losses reach this, the system STOPS automatically.",
    );
    const bpsRaw = await askText("Loss cap in bps, 500 = 5% (Enter = keep)", {
      defaultValue: String(AUTONOMY_BOUNDS.DAILY_LOSS_CAP_BPS),
    });
    const bpsParsed = Number(bpsRaw);
    const lossBps =
      Number.isFinite(bpsParsed) && bpsParsed > 0
        ? Math.floor(bpsParsed)
        : AUTONOMY_BOUNDS.DAILY_LOSS_CAP_BPS;

    const currentUniverse = process.env["POLYROOT_MARKET_IDS"] ?? "";
    console.log("\nMarket list = Polymarket token IDs, separated by commas.");
    console.log("Leave empty to keep unchanged.");
    const universeRaw = await askText(
      `Market list${currentUniverse ? " (current: " + currentUniverse + ")" : ""}`,
      { defaultValue: currentUniverse },
    );
    let universe: string[] = [];
    const trimmed = universeRaw.trim();
    if (trimmed) {
      try {
        universe = readMarketUniverse({ POLYROOT_MARKET_IDS: trimmed });
      } catch (err) {
        console.log(
          `⚠️  Invalid market list (${(err as Error).message}) — keeping the old one.`,
        );
      }
    }

    const updates = buildSetupEnvUpdate({
      capitalUsd,
      lossBps,
      mode,
      universe,
    });
    ensurePolyrootHome();
    const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
    writeFileSync(ENV_PATH, upsertEnvLines(existing, updates) + "\n", {
      mode: 0o600,
    });
    chmodSync(ENV_PATH, 0o600);
    const lossCap = resolveLossCapPusd(capitalUsd, lossBps) ?? 0;
    console.log(
      `\n✅ Saved: mode ${mode}, capital $${capitalUsd}, stop-loss $${lossCap}/day.`,
    );
    if (universe.length > 0) {
      console.log(`   Markets: ${universe.join(", ")}`);
    }
    console.log(formatNextSteps(mode));
    process.loadEnvFile(ENV_PATH as string);
    closeSharedSession();
  } catch (err) {
    closeSharedSession();
    if (err instanceof OnboardingCancelled) {
      console.log(
        "\nCancelled, nothing changed. Run 'polyroot setup' any time.",
      );
      process.exit(0);
    }
    console.error("\n❌ Setup failed:", (err as Error).message);
    process.exit(1);
  }
}

import { createSignerFromEnv } from "@polyroot/signer";
import {
  buildLiveVenueAdapter,
  buildPublicVenueAdapter,
  readMarketUniverse,
  runVenueCheck,
} from "@polyroot/venue";
import { parseBoundsEnv } from "./autonomy-bounds.js";
import { runLivePreflight } from "./live-preflight.js";
import {
  buildSetupEnvUpdate,
  formatNextSteps,
  upsertEnvLines,
} from "./setup-guide.js";

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

  // Restart idempotency gate: load durable seen_orders BEFORE the pipeline
  // accepts any intent. Fail-closed in live modes (throws after closing the
  // pool); PAPER/SHADOW warn and continue.
  await agent.hydrateSeen();

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
    try {
      agent.stopReservationExpiry();
    } catch (err: unknown) {
      console.error("Expiry job stop error:", err);
    }
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
    try {
      agent.stopReservationExpiry();
    } catch {
      // never block shutdown on timer cleanup
    }
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

/** Status command - shows current configuration and health. */
async function runStatus(): Promise<void> {
  loadDotEnv();
  const env = process.env;
  console.log("\n═══════════════════════════════════════════════");
  console.log("  PolyRoot Agent — Status");
  console.log("═══════════════════════════════════════════════\n");

  // Config
  const mode = env["RUNTIME_MODE"] || "PAPER";
  const dbUrl = env["DATABASE_URL"] ? "✅ Set" : "❌ Missing";
  const rpc = env["RPC_URL"] || "https://polygon-rpc.com";
  const metricsKey = env["POLYROOT_METRICS_OWNER_KEY"]
    ? "✅ Set"
    : "❌ Missing (metrics disabled)";

  // Wallet
  const hasKeystore = Boolean(env["POLYROOT_KEYSTORE_JSON"]);
  const hasPassphrase = Boolean(env["POLYROOT_KEYSTORE_PASSPHRASE"]);
  const hasRawKey = Boolean(
    env["PRIVATE_KEY_HEX"] ?? env["WALLET_PRIVATE_KEY"],
  );
  const walletAddr = env["WALLET_ADDRESS"] || "Not set";
  const account = env["WALLET_ACCOUNT"] || "Not set";
  const funder = env["WALLET_FUNDER"] || "Not set";

  // Venue
  const venueKey = env["POLYMARKET_API_KEY"] ? "✅ Set" : "❌ Missing";
  const venueSecret = env["POLYMARKET_API_SECRET"] ? "✅ Set" : "❌ Missing";
  const venuePassphrase = env["POLYMARKET_API_PASSPHRASE"]
    ? "✅ Set"
    : "❌ Missing";

  // Live caps
  const lossCap = env["POLYROOT_MICRO_LIVE_LOSS_CAP_USD"] || "Not set";
  const expCap = env["POLYROOT_MICRO_LIVE_CAP_USD"] || "500 (default)";

  console.log("📋 Configuration:");
  console.log(`  Mode:              ${mode}`);
  console.log(`  Database:          ${dbUrl}`);
  console.log(`  RPC URL:           ${rpc}`);
  console.log(`  Metrics:           ${metricsKey}`);
  console.log("");
  console.log("🔐 Wallet:");
  console.log(`  Keystore:          ${hasKeystore ? "✅ Set" : "❌ Missing"}`);
  console.log(
    `  Passphrase:        ${hasPassphrase ? "✅ Set" : "❌ Missing"}`,
  );
  console.log(`  Raw Key:           ${hasRawKey ? "✅ Set" : "❌ Missing"}`);
  console.log(`  Address:           ${walletAddr}`);
  console.log(`  Account:           ${account}`);
  console.log(`  Funder:            ${funder}`);
  console.log("");
  console.log("🏪 Venue (Polymarket):");
  console.log(`  API Key:           ${venueKey}`);
  console.log(`  API Secret:        ${venueSecret}`);
  console.log(`  Passphrase:        ${venuePassphrase}`);
  console.log("");
  console.log("🛡️  Live Caps:");
  console.log(`  Loss Cap (pUSD):   ${lossCap}`);
  console.log(`  Exposure Cap (pUSD): ${expCap}`);
  console.log("");
  console.log("📁 Config: ~/.polyroot/.env");
  console.log("🔐 Keystore: ~/.polyroot/keystore.json");
  console.log("\n═══════════════════════════════════════════════\n");
}

/** Update command - git pull and rebuild. */
async function runUpdate(): Promise<void> {
  console.log("\n🔄 Updating PolyRoot Agent...\n");
  const { execSync } = await import("node:child_process");
  const installDir = process.env["HOME"]
    ? `${process.env["HOME"]}/.polyroot`
    : "/tmp/.polyroot";

  try {
    console.log("📥 Pulling latest changes...");
    execSync("git pull", { cwd: installDir, stdio: "inherit" });

    console.log("\n📦 Installing dependencies...");
    execSync("npm ci", { cwd: installDir, stdio: "inherit" });

    console.log("\n🔨 Building...");
    execSync("npx turbo run build", { cwd: installDir, stdio: "inherit" });

    console.log("\n✅ Update complete!");
  } catch (err) {
    console.error("❌ Update failed:", (err as Error).message);
    process.exit(1);
  }
}

/** Doctor command - health checks. */
async function runDoctor(): Promise<void> {
  console.log("\n🏥 PolyRoot Agent — Doctor\n");
  let allOk = true;

  // 1. Check DATABASE_URL
  loadDotEnv();
  const dbUrl = process.env["DATABASE_URL"];
  if (!dbUrl) {
    console.log("❌ DATABASE_URL not set");
    allOk = false;
  } else {
    console.log("✅ DATABASE_URL set");
    // Test connection
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: dbUrl });
    try {
      await pool.query("SELECT 1");
      await pool.end();
      console.log("✅ Database connection OK");
    } catch (e) {
      console.log("❌ Database connection failed:", (e as Error).message);
      allOk = false;
    }
  }

  // 2. Check wallet
  const hasKeystore = Boolean(process.env["POLYROOT_KEYSTORE_JSON"]);
  const hasPassphrase = Boolean(process.env["POLYROOT_KEYSTORE_PASSPHRASE"]);
  const hasRawKey = Boolean(
    process.env["PRIVATE_KEY_HEX"] ?? process.env["WALLET_PRIVATE_KEY"],
  );
  if (!hasKeystore && !hasRawKey) {
    console.log("❌ No wallet key configured (keystore or raw)");
    allOk = false;
  } else {
    console.log("✅ Wallet key present");
    if (hasKeystore && !hasPassphrase) {
      console.log("⚠️  Keystore set but passphrase missing");
      allOk = false;
    }
  }

  // 3. Check RPC
  const rpc = process.env["RPC_URL"] || "https://polygon-rpc.com";
  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_blockNumber",
        params: [],
        id: 1,
      }),
    });
    if (res.ok) console.log("✅ RPC reachable");
    else {
      console.log("❌ RPC unreachable");
      allOk = false;
    }
  } catch {
    console.log("❌ RPC unreachable");
    allOk = false;
  }

  // 4. Venue credentials (only for live modes)
  const mode = process.env["RUNTIME_MODE"] || "PAPER";
  if (mode !== "PAPER") {
    const venueOk = Boolean(
      process.env["POLYMARKET_API_KEY"] &&
      process.env["POLYMARKET_API_SECRET"] &&
      process.env["POLYMARKET_API_PASSPHRASE"],
    );
    if (!venueOk) {
      console.log(
        "⚠️  Polymarket API credentials incomplete (required for " + mode + ")",
      );
    } else {
      console.log("✅ Polymarket API credentials present");
    }
  }

  // 5. Live caps
  if (mode !== "PAPER") {
    const lossCap = process.env["POLYROOT_MICRO_LIVE_LOSS_CAP_USD"];
    if (!lossCap) {
      console.log(
        "⚠️  POLYROOT_MICRO_LIVE_LOSS_CAP_USD not set (required for " +
          mode +
          ")",
      );
      allOk = false;
    } else {
      console.log("✅ Loss cap configured: " + lossCap + " pUSD");
    }
  }

  console.log(
    "\n" + (allOk ? "✅ All checks passed" : "❌ Some checks failed"),
  );
  if (!allOk) process.exit(1);
}

/**
 * Strict LIVE preflight: `polyroot doctor --live`.
 * Proves production infrastructure before real money moves. Unlike `doctor`
 * (informational warnings), EVERY check here is a hard gate — any failure
 * exits non-zero. Passing proves readiness, never authorization: the owner
 * sign-off for LIVE is still required out of band.
 */
async function runLiveDoctor(): Promise<void> {
  console.log("\n🏥 PolyRoot Agent — LIVE Preflight (strict)\n");
  loadDotEnv();
  const dbUrl = process.env["DATABASE_URL"] ?? "";
  if (!dbUrl) {
    console.log("❌ db-connect: DATABASE_URL is not set");
    console.log("\n❌ LIVE preflight REFUSED (database unconfigured)");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const venue = buildPublicVenueAdapter();
    const result = await runLivePreflight({
      queryDb: (text: string, params?: unknown[]) =>
        pool.query(text, params as never[]) as never,
      readBounds: async () => parseBoundsEnv(process.env),
      readUniverse: async () => readMarketUniverse(process.env),
      verifyWallet: async () => {
        const w = runWalletVerify();
        return {
          ok: w.ok,
          detail: w.ok
            ? `wallet verified${w.address ? `: ${w.address}` : ""}`
            : w.checks
                .filter((c) => !c.ok)
                .map((c) => `${c.name}: ${c.detail}`)
                .join("; "),
        };
      },
      venueCredsPresent: async () =>
        Boolean(
          process.env["POLYMARKET_API_KEY"] &&
          process.env["POLYMARKET_API_SECRET"] &&
          process.env["POLYMARKET_API_PASSPHRASE"],
        ),
      fetchBook: async (marketId: string) => {
        const snap = await venue.getOrderBook(marketId);
        if (snap.yes_price === undefined || snap.no_price === undefined)
          return null;
        return { bid: snap.yes_price, ask: snap.no_price };
      },
      metricsKeyPresent: async () =>
        Boolean(process.env["POLYROOT_METRICS_OWNER_KEY"]),
    });
    for (const c of result.checks) {
      console.log(`${c.ok ? "✅" : "❌"} ${c.name}: ${c.detail}`);
    }
    console.log(
      "\n" +
        (result.ok
          ? "✅ LIVE preflight PASSED — infrastructure proven (owner sign-off still required to trade)"
          : "❌ LIVE preflight REFUSED — fix the failed checks above; no real money moves until all pass"),
    );
    if (!result.ok) process.exit(1);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** Docker fix - restart postgres container. */
async function runDockerFix(): Promise<void> {
  console.log("\n🐳 Fixing Docker PostgreSQL...\n");
  const { execSync } = await import("node:child_process");
  try {
    console.log("🔄 Restarting postgres container...");
    execSync("docker compose restart postgres", { stdio: "inherit" });
    console.log("\n✅ PostgreSQL restarted");
  } catch (e) {
    console.error("❌ Failed:", (e as Error).message);
    process.exit(1);
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

  if (argv[0] === "status") {
    await runStatus();
    return;
  }
  if (argv[0] === "update") {
    await runUpdate();
    return;
  }
  if (argv[0] === "doctor") {
    if (argv.includes("--live")) {
      await runLiveDoctor();
    } else {
      await runDoctor();
    }
    return;
  }
  if (argv[0] === "docker-fix") {
    await runDockerFix();
    return;
  }
  if (argv[0] === "onboard") {
    await runOnboardingFlow();
    return;
  }
  if (argv[0] === "setup") {
    await runSetupFlow();
    return;
  }

  // First-run onboarding (skip for subcommands)
  if (
    argv[0] !== "wallet" &&
    argv[0] !== "venue" &&
    argv[0] !== "guard" &&
    argv[0] !== "status" &&
    argv[0] !== "update" &&
    argv[0] !== "doctor" &&
    argv[0] !== "docker-fix" &&
    argv[0] !== "onboard" &&
    argv[0] !== "setup"
  ) {
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
