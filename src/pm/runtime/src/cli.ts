import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { Pool } from "pg";
import {
  deriveAddressFromPrivateKey,
  sealPrivateKey,
  resolveWalletKey,
  decimalToBase,
} from "@polyroot/signer";
import { randomBytes } from "node:crypto";
import {
  PgLiveGuardStore,
  checkShadowBaselineRow,
  decideGuardReset,
} from "./live-guard-store.js";
import { type RuntimeMode } from "./mode-watcher.js";
import {
  uiEnabled,
  theme,
  banner,
  stepper,
  box,
  kv,
  table,
  menuFrame,
  startSpinner,
} from "./console-ui.js";
import { AUTONOMY_BOUNDS, resolveLossCapPusd } from "./autonomy-bounds.js";
import { bootstrapAgent, buildWalletIdentity } from "./main.js";
import { MetricsExporter } from "./metrics-exporter.js";
import { MetricsServer } from "./metrics-server.js";
import {
  collectHealth,
  createBackup,
  explainLastDecision,
  flushStepPersistence,
  formatHealth,
  formatInsight,
  marketDeepDive,
  requestHalt,
  restoreBackup,
  topOpportunities,
} from "./observability/index.js";

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
  let loaded: string | undefined;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      loaded = candidate;
      break;
    }
  }
  if (dotenvPath !== undefined) return loaded;
  // Default resolution only: user config (~/.polyroot/.env, written by
  // onboard/setup) always wins over repo templates: apply it last with
  // override. Without this, a placeholder repo .env would shadow the
  // user's real settings. Explicit-path callers keep exact old semantics.
  try {
    const home =
      process.env["HOME"] !== undefined ? process.env["HOME"] : "/tmp";
    const userEnv = `${home}/.polyroot/.env`;
    if (existsSync(userEnv)) {
      const text = readFileSync(userEnv, "utf8");
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        if (eq <= 0) continue;
        const key = t.slice(0, eq).trim();
        let val = t.slice(eq + 1).trim();
        if (
          val.length >= 2 &&
          ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'")))
        ) {
          val = val.slice(1, -1);
        }
        if (key) process.env[key] = val;
      }
      loaded = userEnv;
    }
  } catch {
    // best-effort: a broken user .env must not crash config loading
  }
  return loaded;
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

export interface OnceTranscriptInput {
  market_id: string;
  bid: number;
  ask: number;
}

export interface OnceTranscriptResult {
  market_id: string;
  decision: "NO_TRADE" | "BUY" | "SELL";
  reason: string | undefined;
  p: number | null | undefined;
  size: number | undefined;
  edge: number | undefined;
  fill: { fillPrice: number } | undefined;
}

/**
 * Rich human-readable transcript for `polyroot run --once`, mirroring the
 * simulated terminal on the landing page. Pure formatter (no I/O) — prints
 * only values the engine actually produced, never fabrications: no
 * confidence figure exists at this layer, so none is shown.
 */
export function formatOnceTranscript(
  input: OnceTranscriptInput,
  result: OnceTranscriptResult,
): string {
  const trim = (n: number): string => String(Math.round(n * 1000) / 1000);
  const lines = [
    `book  YES ${trim(input.bid)} / NO ${trim(input.ask)} · spread ${trim(Math.abs(input.ask - input.bid))}`,
  ];
  const p =
    typeof result.p === "number" && Number.isFinite(result.p) ? result.p : null;
  if (p === null) {
    lines.push(
      `AI forecast  abstained${result.reason ? ` — ${result.reason}` : ""}`,
    );
  } else {
    lines.push(`AI forecast  p(YES) = ${trim(p)}`);
  }
  if (result.decision === "NO_TRADE") {
    lines.push(`⏭ NO_TRADE — ${result.reason ?? "no reason given"}`);
  } else {
    const price =
      result.fill?.fillPrice ??
      (result.decision === "BUY" ? input.ask : input.bid);
    const edge =
      typeof result.edge === "number" && Number.isFinite(result.edge)
        ? ` · edge ${(result.edge >= 0 ? "+" : "") + String(Math.round(result.edge * 1000) / 10) + "%"}`
        : "";
    lines.push(
      `✓ ${result.decision} ${result.size ?? "?"} @ ${trim(price)}${edge}`,
    );
  }
  return lines.join("\n");
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
  let mode: CLIConfig["mode"] = "SHADOW";
  let modeFromFlag = false;
  let databaseUrl = "";
  let kmsKeyId = "";
  let once = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      const helpThemeBold = theme().bold;
      console.log(banner("PolyRoot Agent", "Autonomous AI trading for Polymarket"));
      console.log(
        helpThemeBold("commands:") + "\n" +
          "  polyroot                 Open the interactive console\n" +
          "  polyroot run             Start the agent (mode from settings)\n" +
          "  polyroot onboard         First-time setup (new users)\n" +
          "  polyroot setup           Change mode, capital, loss cap, markets\n" +
          "  polyroot shadow-fund --amount <usd>  Credit SHADOW play bankroll\n" +
          "  polyroot markets         Browse popular markets by name\n" +
          "  polyroot status          Show current configuration\n" +
          "  polyroot explain [--last N] Explain the latest AI decision chain\n" +
          "  polyroot halt [--cancel-orders] Emergency stop + exit\n" +
          "  polyroot health [--watch]    Real-time system health\n" +
          "  polyroot insight [--market]  Market opportunities + heatmap\n" +
          "  polyroot backup [--encrypt]  Export state (keystore, config, data)\n" +
          "  polyroot restore --from DIR  Verify (and --apply) a backup\n" +
          "  polyroot doctor          Basic health check\n" +
          "  polyroot doctor --live   LIVE readiness test, required before real money\n" +
          "  polyroot wallet verify   Check wallet with no network\n" +
          "  polyroot guard reset --loss <loss>   Unlock the loss latch\n" +
          "  polyroot mode <MODE>     Switch runtime mode (PAPER|SHADOW|MICRO_LIVE|LIVE)\n" +
          "  polyroot mode            Show current runtime mode\n" +
          "  polyroot run --once      Run once then stop (test)\n" +
          "  polyroot restart         Stop the background agent, print how to start it",
      );
      process.exit(0);
    } else if (a === "--mode") {
      mode = parseMode(argv[++i], "--mode");
      modeFromFlag = true;
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
  // Explicit --mode wins; otherwise a set RUNTIME_MODE is validated
  // (invalid values throw instead of silently running the default).
  if (!modeFromFlag && envMode) mode = parseMode(envMode, "RUNTIME_MODE");

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
  mode: "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE";
  /** Owner-set capital cap in USD (MICRO_LIVE/LIVE enforce it; PAPER ignores it). */
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
  opts: { defaultValue?: string | undefined } = {},
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

/** Best-effort reachability ping for a user's own gateway. Warning-only: never blocks setup. */
async function pingModelsEndpoint(
  baseUrl: string,
  apiKey: string,
): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: ctrl.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** Numbered menu with a marked default (blank = default), Hermes `_ask_index`-style. */
async function askChoice(
  message: string,
  options: string[],
  defaultIdx = 0,
): Promise<string> {
  // Arrow-key menu on real terminals; the classic numbered list everywhere
  // else (piped stdin, tests, systemd units). Any interactive failure falls
  // back to numbered input — selection must never depend on a TTY.
  if (uiEnabled()) {
    try {
      const picked = await askChoiceArrows(message, options, defaultIdx);
      if (picked !== null) return picked;
    } catch {
      // fall through to the numbered list below
    }
  }
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

/**
 * Arrow-key menu (TTY only): ↑/↓ or j/k move, Enter selects, 1-9 jumps,
 * Esc/Ctrl-C cancels like every other prompt (OnboardingCancelled).
 * Suspends the shared readline while raw mode owns stdin; restores it in
 * `finally`. Returns null when a TTY menu is impossible (caller falls back).
 */
async function askChoiceArrows(
  message: string,
  options: string[],
  defaultIdx = 0,
): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  if (typeof process.stdin.setRawMode !== "function") return null;
  const session = await getSharedSession();
  const readline = await import("node:readline");
  const PAGE = 12;
  return await new Promise<string>((resolve, reject) => {
    let cursor = Math.min(Math.max(defaultIdx, 0), options.length - 1);
    let settled = false;
    let frameLines = 0;
    const up = (n: number): void => {
      if (n > 0) process.stdout.write(`\u001b[${n}A`);
    };
    const clearFrame = (): void => {
      up(frameLines);
      process.stdout.write("\u001b[0J");
    };
    const render = (): void => {
      const frame = menuFrame(message, options, defaultIdx, cursor, {
        pageSize: PAGE,
        hint: "↑↓ move · Enter select · 1-9 jump · Esc cancel",
      });
      process.stdout.write(`${frame}\n`);
      frameLines = frame.split("\n").length + 1;
    };
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      try {
        process.stdin.setRawMode(false);
      } catch {
        // not a TTY after all — caller falls back
      }
      try {
        process.stdin.removeListener("keypress", onKey);
      } catch {
        // listener already gone
      }
      try {
        session.rl.resume();
      } catch {
        // session teardown is best-effort
      }
      fn();
    };
    const onKey = (
      _ch: string | undefined,
      key:
        | { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }
        | undefined,
    ): void => {
      if (settled) return;
      const name = key?.name ?? "";
      if (key?.ctrl && (name === "c" || name === "d")) {
        clearFrame();
        done(() => reject(new OnboardingCancelled()));
        return;
      }
      if (name === "escape") {
        clearFrame();
        done(() => reject(new OnboardingCancelled()));
        return;
      }
      if (name === "up" || name === "k") {
        cursor = (cursor - 1 + options.length) % options.length;
        clearFrame();
        render();
        return;
      }
      if (name === "down" || name === "j") {
        cursor = (cursor + 1) % options.length;
        clearFrame();
        render();
        return;
      }
      if (name === "return" || name === "enter") {
        const picked = options[cursor];
        clearFrame();
        if (picked === undefined) {
          done(() => reject(new OnboardingCancelled()));
        } else {
          const t = theme();
          done(() => {
            console.log(`  ${t.green("→")} ${picked}`);
            resolve(picked);
          });
        }
        return;
      }
      const digit = Number.parseInt(key?.sequence ?? "", 10);
      if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
        const idx = digit - 1;
        if (idx < options.length) {
          cursor = idx;
          clearFrame();
          render();
        }
      }
    };
    try {
      session.rl.pause();
      // pause() halts the underlying stream too — resume it so keypress
      // events actually arrive; the shared session is restored in done().
      process.stdin.resume();
      readline.emitKeypressEvents(process.stdin);
      process.stdin.on("keypress", onKey);
      process.stdin.setRawMode(true);
      render();
    } catch {
      done(() => reject(new OnboardingCancelled()));
    }
  });
}

async function runOnboarding(): Promise<OnboardingConfig> {
  console.log(banner("Welcome to PolyRoot Agent — First-Time Setup"));
  console.log("  3 steps. Every step has a safe default: just press Enter.\n");

  // 1. AI Provider & Model — the brain that reads markets.
  // Hermes-style: generic OpenAI-compatible provider. The user always
  // supplies their own base URL + key; this repo ships no gateway default.
  console.log(stepper(1, 3, "AI brain"));
  console.log("📡 Step 1/3: AI brain (reads the markets)");
  const provider = await askChoice(
    "Choose AI provider (Enter = default):",
    [
      "OpenAI (GPT-4o, GPT-4o-mini, GPT-4-turbo)",
      "Qwen (Qwen Cloud / DashScope, Coding Plan, Token Plan & Qwen CLI OAuth)",
      "xAI Grok (Direct API or SuperGrok / Premium+ OAuth)",
      "Xiaomi MiMo (MiMo-V2.5 and V2 models: pro, omni, flash)",
      "Tencent Hy (Hy4 / Hy3 via TokenHub & TokenPlan)",
      "NVIDIA NIM (Nemotron models via build.nvidia.com or local NIM)",
      "GitHub Copilot ACP (Spawns copilot --acp --stdio)",
      "Hugging Face Inference Providers",
      "Google AI Studio (Native Gemini API)",
      "Google Vertex AI (Gemini via GCP; OAuth2 service account or ADC, GCP billing/quotas)",
      "DeepSeek (V3, R1, coder, direct API)",
      "Z.AI / GLM (Zhipu direct API)",
      "Kimi / Moonshot (Coding Plan, Moonshot global & China endpoints)",
      "StepFun Step Plan (Agent / coding models via Step Plan API)",
      "MiniMax (Global, OAuth Coding Plan & China endpoints)",
      "Ollama Cloud (Cloud-hosted open models, ollama.com)",
      "Arcee AI (Trinity models, direct API)",
      "GMI Cloud (Multi-model direct API)",
      "Kilo Code (Kilo Gateway API)",
      "OpenCode Go (Open models subscription)",
      "AWS Bedrock (Claude, Nova, Llama, DeepSeek; IAM or API key)",
      "Azure Foundry (OpenAI-style or Anthropic-style endpoint, your Azure AI deployment)",
      "Vercel AI Gateway (Multi-model aggregator)",
      "Actual Computer - hosted inference via api.actual.inc, or local offline inference",
      "CommandCode — 20+ models via OpenAI-compatible API",
      "CommandCode — Claude models via Anthropic Messages API",
      "custom (direct API)",
      "DeepInfra — 100+ open models, pay-per-use",
      "Meta Muse Spark family (Meta Superintelligence Labs)",
      "Nebius Token Factory — OpenAI-compatible inference",
      "Ramp Router (router.com) — routes each request to the cheapest model that clears you",
      "Upstage (Solar API)",
      "Ollama (runs on this machine)",
    ],
    0,
  );

  let model = "";
  let baseUrl = "";
  let apiKey = "";

  // Provider configurations
  const providerConfig: Record<string, {
    baseUrl?: string;
    defaultModel?: string;
    models?: string[];
    apiKeyRequired?: boolean;
    specialHandling?: 'ollama' | 'vertex' | 'bedrock' | 'custom' | 'copilot' | 'azure';
  }> = {
    "OpenAI": {
      baseUrl: "https://api.openai.com/v1",
      models: ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"],
      defaultModel: "gpt-4o-mini",
    },
    "Qwen": {
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-coder-plus"],
      defaultModel: "qwen-max",
    },
    "xAI Grok": {
      baseUrl: "https://api.x.ai/v1",
      models: ["grok-1", "grok-2", "grok-2-mini"],
      defaultModel: "grok-2",
    },
    "Xiaomi MiMo": {
      baseUrl: "https://api.mimo.xiaomi.com/v1",
      models: ["mimo-pro", "mimo-omni", "mimo-flash"],
      defaultModel: "mimo-pro",
    },
    "Tencent Hy": {
      baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
      models: ["hy4", "hy3"],
      defaultModel: "hy4",
    },
    "NVIDIA NIM": {
      baseUrl: "https://integrate.api.nvidia.com/v1",
      models: ["nemotron-3-ultra", "nemotron-3-ultra-550b", "nemotron-4-340b"],
      defaultModel: "nemotron-3-ultra",
    },
    "GitHub Copilot ACP": {
      specialHandling: "copilot",
    },
    "Hugging Face Inference Providers": {
      baseUrl: "https://api-inference.huggingface.co/v1",
      models: ["meta-llama/Meta-Llama-3.1-70B-Instruct", "mistralai/Mixtral-8x7B-Instruct-v0.1", "google/gemma-2-27b-it"],
      defaultModel: "meta-llama/Meta-Llama-3.1-70B-Instruct",
    },
    "Google AI Studio": {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      models: ["gemini-1.5-pro", "gemini-1.5-flash", "gemini-1.5-flash-8b"],
      defaultModel: "gemini-1.5-pro",
    },
    "Google Vertex AI": {
      specialHandling: "vertex",
    },
    "DeepSeek": {
      baseUrl: "https://api.deepseek.com/v1",
      models: ["deepseek-chat", "deepseek-coder", "deepseek-r1"],
      defaultModel: "deepseek-chat",
    },
    "Z.AI / GLM": {
      baseUrl: "https://api.z.ai/v1",
      models: ["glm-4", "glm-4-air", "glm-4-airx"],
      defaultModel: "glm-4",
    },
    "Kimi / Moonshot": {
      baseUrl: "https://api.moonshot.cn/v1",
      models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
      defaultModel: "moonshot-v1-8k",
    },
    "StepFun Step Plan": {
      baseUrl: "https://api.stepfun.com/v1",
      models: ["step-1", "step-2"],
      defaultModel: "step-1",
    },
    "MiniMax": {
      baseUrl: "https://api.minimax.chat/v1",
      models: ["abab6.5s-chat", "abab6.5-chat", "abab5.5-chat"],
      defaultModel: "abab6.5s-chat",
    },
    "Ollama Cloud": {
      baseUrl: "https://api.ollama.com/v1",
      models: ["llama3.1", "llama3.1:70b", "qwen2.5:72b", "codellama:34b"],
      defaultModel: "llama3.1",
    },
    "Arcee AI": {
      baseUrl: "https://api.arcee.ai/v1",
      models: ["trinity-7b", "trinity-14b"],
      defaultModel: "trinity-14b",
    },
    "GMI Cloud": {
      baseUrl: "https://api.gmi-cloud.com/v1",
      models: ["gmi-1", "gmi-2"],
      defaultModel: "gmi-1",
    },
    "Kilo Code": {
      baseUrl: "https://api.kilocode.ai/v1",
      models: ["kilocode-pro", "kilocode-lite"],
      defaultModel: "kilocode-pro",
    },
    "OpenCode Go": {
      baseUrl: "https://api.opencode.ai/v1",
      models: ["opencode-gpt", "opencode-claude"],
      defaultModel: "opencode-gpt",
    },
    "AWS Bedrock": {
      specialHandling: "bedrock",
    },
    "Azure Foundry": {
      specialHandling: "azure",
    },
    "Vercel AI Gateway": {
      baseUrl: "https://ai-gateway.vercel.sh/v1",
      models: ["gpt-4o", "claude-3.5-sonnet", "llama-3.1-70b"],
      defaultModel: "gpt-4o",
    },
    "Actual Computer": {
      baseUrl: "https://api.actual.inc/v1",
      models: ["actual-pro", "actual-lite"],
      defaultModel: "actual-pro",
    },
    "CommandCode — 20+ models via OpenAI-compatible API": {
      baseUrl: "https://api.commandcode.com/v1",
      models: ["command-r-plus", "command-r", "command-r-08-2024"],
      defaultModel: "command-r-plus",
    },
    "CommandCode — Claude models via Anthropic Messages API": {
      baseUrl: "https://api.anthropic.com/v1",
      models: ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-opus-20240229"],
      defaultModel: "claude-3-5-sonnet-20241022",
    },
    "custom (direct API)": {
      specialHandling: "custom",
    },
    "DeepInfra": {
      baseUrl: "https://api.deepinfra.com/v1/openai",
      models: ["meta-llama/Meta-Llama-3.1-70B-Instruct", "microsoft/phi-3-medium-4k-instruct", "mistralai/Mixtral-8x7B-Instruct-v0.1"],
      defaultModel: "meta-llama/Meta-Llama-3.1-70B-Instruct",
    },
    "Meta Muse Spark family": {
      baseUrl: "https://api.muse.meta.com/v1",
      models: ["muse-spark-1", "muse-spark-2"],
      defaultModel: "muse-spark-1",
    },
    "Nebius Token Factory": {
      baseUrl: "https://api.studio.nebius.ai/v1",
      models: ["meta-llama/Meta-Llama-3.1-405B-Instruct", "mistralai/Mixtral-8x7B-Instruct-v0.1"],
      defaultModel: "meta-llama/Meta-Llama-3.1-405B-Instruct",
    },
    "Ramp Router": {
      baseUrl: "https://api.ramp.router/v1",
      models: ["auto"],
      defaultModel: "auto",
    },
    "Upstage": {
      baseUrl: "https://api.upstage.ai/v1/solar",
      models: ["solar-1-mini", "solar-1-pro"],
      defaultModel: "solar-1-pro",
    },
    "Ollama": {
      specialHandling: "ollama",
    },
  };

  // Labels shown in the menu carry descriptions in parentheses; config keys
  // are the short prefixes ("OpenAI", "Ollama Cloud", ...). Match longest
  // first so "Ollama Cloud (...)" wins over "Ollama".
  const configKey = Object.keys(providerConfig)
    .sort((a, b) => b.length - a.length)
    .find((k) => provider === k || provider.startsWith(`${k} `) || provider.startsWith(`${k} (`));
  const config = (configKey ? providerConfig[configKey] : undefined) || {};

  const specialHandling = config.specialHandling;

  if (specialHandling === "ollama") {
    model = await askText("Model name", { defaultValue: "llama3.1" });
    baseUrl = await askText("Base URL", {
      defaultValue: "http://localhost:11434/v1",
    });
    apiKey = "ollama";
  } else if (specialHandling === "copilot") {
    console.log("GitHub Copilot ACP uses stdio transport. Spawning copilot --acp --stdio...");
    model = "copilot";
    baseUrl = "stdio";
    apiKey = "copilot";
  } else if (specialHandling === "vertex") {
    console.log("Google Vertex AI uses ADC (Application Default Credentials).");
    console.log("Ensure gcloud auth application-default login is set up.");
    model = await askChoice("Select model:", [
      "gemini-1.5-pro",
      "gemini-1.5-flash",
      "gemini-1.5-flash-8b",
    ], 0);
    baseUrl = "vertex";
    apiKey = "adc";
  } else if (specialHandling === "bedrock") {
    console.log("AWS Bedrock uses IAM credentials or API key.");
    console.log("Ensure AWS credentials are configured (aws configure).");
    model = await askChoice("Select model:", [
      "anthropic.claude-3-5-sonnet-20241022-v2:0",
      "anthropic.claude-3-5-haiku-20241022-v1:0",
      "meta.llama3-1-70b-instruct-v1:0",
      "amazon.nova-pro-v1:0",
    ], 0);
    baseUrl = "bedrock";
    apiKey = "aws";
  } else if (specialHandling === "azure") {
    console.log("Azure Foundry uses Azure credentials.");
    console.log("Ensure az login or service principal is configured.");
    model = await askText("Model deployment name (example: gpt-4o)");
    baseUrl = await askText("Azure OpenAI endpoint (example: https://your-resource.openai.azure.com)");
    apiKey = await askRequiredSecret("Paste your Azure OpenAI API key");
    baseUrl = "azure";
  } else if (specialHandling === "custom") {
      baseUrl = await askText(
        "Your gateway base URL (example: https://your-gateway.example/v1)",
      );
      if (!/^https?:\/\/.+/.test(baseUrl)) {
        console.log(
          "That does not look like a web address — it starts with http:// or https://.",
        );
        baseUrl = await askText(
          "Your gateway base URL (example: https://your-gateway.example/v1)",
        );
        if (!/^https?:\/\/.+/.test(baseUrl)) {
          throw new Error("A valid gateway base URL is required");
        }
      }
      model = await askText("Model name (example: gpt-4o-mini)");
      apiKey = await askRequiredSecret("Paste your gateway API key");
    } else if (specialHandling === undefined) {
      // Standard OpenAI-compatible providers
      if (config.baseUrl) {
        if (config.models && config.models.length > 0) {
          model = await askChoice(
            `Select model for ${provider}:`,
            config.models,
            0,
          );
        } else {
          model = await askText("Model name", { defaultValue: config.defaultModel });
        }
        baseUrl = config.baseUrl;
        apiKey = await askRequiredSecret(`Paste your ${provider} API key`);
      } else {
        // Fallback for unknown providers
        baseUrl = await askText(
          "Your gateway base URL (example: https://your-gateway.example/v1)",
        );
        if (!/^https?:\/\/.+/.test(baseUrl)) {
          console.log(
            "That does not look like a web address — it starts with http:// or https://.",
          );
          baseUrl = await askText(
            "Your gateway base URL (example: https://your-gateway.example/v1)",
          );
          if (!/^https?:\/\/.+/.test(baseUrl)) {
            throw new Error("A valid gateway base URL is required");
          }
        }
        model = await askText("Model name (example: gpt-4o-mini)");
      apiKey = await askRequiredSecret("Paste your gateway API key");
    }
  }

  if (!model.trim()) {
    throw new Error("Model name is required");
  }
  if (!apiKey.trim()) {
    throw new Error(
      "API key is required (Ollama on this machine uses any placeholder)",
    );
  }

  if (!provider.startsWith("Ollama")) {
    const reachable = await pingModelsEndpoint(baseUrl, apiKey);
    if (!reachable) {
      console.log(
        "⚠️  Could not reach that address with your key — corporate gateways sometimes block the check while chat still works.",
      );
      const goOn = await askText("Continue anyway? (y/n)", {
        defaultValue: "y",
      });
      if (!goOn.trim().toLowerCase().startsWith("y")) {
        throw new Error(
          "Setup stopped — double-check the base URL and key, then run `polyroot onboard` again",
        );
      }
    }
  }

  // 2. Wallet — keys are sealed in a locked vault on this machine and
  // are never sent anywhere.
  console.log(stepper(2, 3, "Wallet"));
  console.log("\n🔐 Step 2/3: Wallet (where your keys live)");
  console.log(
    "   Keys stay locked in a vault on this computer, never sent anywhere.",
  );
  const walletChoice = await askChoice(
    "Wallet (Enter = create new):",
    [
      "Create new wallet for me (recommended)",
      "I already have a wallet (import secret key)",
    ],
    0,
  );

  let privateKey = "";
  let passphrase = "";

  if (walletChoice.startsWith("Create")) {
    for (;;) {
      passphrase = await askRequiredSecret("Create a vault password");
      const confirm = await askRequiredSecret("Repeat the vault password");
      if (passphrase === confirm) break;
      console.log("Passwords do not match — try again.");
    }
    // Generate random key
    privateKey = "0x" + randomBytes(32).toString("hex");
    console.log(`\n✅ New wallet created!`);
    console.log(`   Address: ${deriveAddressFromPrivateKey(privateKey)}`);
    console.log(`   (Write this address down — it is shown only once)`);
  } else {
    for (;;) {
      privateKey = await askRequiredSecret(
        "Paste your wallet secret key (starts with 0x)",
      );
      if (/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) break;
      console.log(
        "That does not look like a wallet secret key — it is 64 letters/numbers, starting with 0x.",
      );
    }
    passphrase = await askRequiredSecret("Create a vault password");
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

  // 3. Mode selection — full PAPER → SHADOW → MICRO_LIVE → LIVE ladder.
  // SHADOW stays the default: live data, simulated fills, $0 risk.
  console.log(stepper(3, 3, "Mode"));
  console.log("\n🚀 Step 3/3: Choose Mode");
  console.log(
    "   PAPER = practice, mock data, $0 risk. SHADOW = live data, sim fills, $0 risk.",
  );
  console.log(
    "   MICRO_LIVE = small real money (needs API keys + loss cap). LIVE = full real money.",
  );
  const modeChoice = await askChoice(
    "Choose mode (Enter = SHADOW):",
    [
      "SHADOW — Live data, simulated fills, $0 risk (recommended)",
      "PAPER — Safe simulation, mock data, $0 risk",
      "MICRO_LIVE — Small real money (requires capital, API keys, loss cap)",
      "LIVE — Real trading on Polymarket (requires capital, API keys)",
    ],
    0,
  );
  let mode: "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE" = "SHADOW";
  let capitalUsd: number = AUTONOMY_BOUNDS.CAPITAL_CAP_USD;
  let lossBps: number = AUTONOMY_BOUNDS.DAILY_LOSS_CAP_BPS;

  // SHADOW, MICRO_LIVE and LIVE need capital/loss caps (SHADOW simulates with
  // real data; PAPER ignores caps and runs the mock fixture).
  const needsCapitalConfig =
    modeChoice.startsWith("SHADOW") ||
    modeChoice.startsWith("MICRO") ||
    modeChoice.startsWith("LIVE");
  if (needsCapitalConfig) {
    const isLive = modeChoice.startsWith("LIVE");
    const isMicro = modeChoice.startsWith("MICRO");
    if (isLive || isMicro) {
      const label = isLive ? "LIVE" : "MICRO_LIVE";
      mode = label;
      console.log(
        `\n${label} uses REAL MONEY. The daily loss cap shuts the system`,
        "down automatically when reached (needs your manual reset).",
      );
      if (isMicro) {
        console.log(
          "MICRO_LIVE also needs: Polymarket API keys + 3 distinct wallet",
          "addresses (signer, account, funder). `polyroot doctor --live` checks all of this.",
        );
      }
      const confirm = await askText(
        `Type ${label} to continue (anything else stays SHADOW)`,
      );
      if (confirm.trim() !== label) {
        mode = "SHADOW";
        console.log("Staying on SHADOW.");
      } else {
        mode = label;
      }
    } else {
      mode = "SHADOW";
    }

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
    mode = "PAPER";
    console.log(
      "PAPER selected: safe simulation on the mock fixture, caps ignored.",
      "Change later with: polyroot setup",
    );
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
  // Never clobber a database the user already configured (docker compose,
  // production .env, re-run onboarding): existing file value wins, then the
  // ambient env, and only then the localhost default.
  const existingDbUrl = (() => {
    try {
      if (existsSync(ENV_PATH)) {
        for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
          const m = /^DATABASE_URL=(.*)$/.exec(line.trim());
          if (m) {
            const v = (m[1] ?? "").trim();
            if (v) return v;
          }
        }
      }
    } catch {
      // unreadable file — fall through to env/default
    }
    return undefined;
  })();
  const dbUrl =
    existingDbUrl ??
    process.env["DATABASE_URL"] ??
    "postgresql://polyroot:polyroot@localhost:5432/polyroot";
  const lines = [
    "# PolyRoot Agent — Auto-generated by onboarding",
    `DATABASE_URL=${dbUrl}`,
    `RUNTIME_MODE=${config.mode}`,
    `POLYROOT_KEYSTORE_JSON=${JSON.stringify(sealPrivateKey(config.privateKey!, config.passphrase))}`,
    `POLYROOT_KEYSTORE_PASSPHRASE=${config.passphrase}`,
    `WALLET_ADDRESS=${deriveAddressFromPrivateKey(config.privateKey!)}`,
    `# WALLET_ACCOUNT and WALLET_FUNDER must be set for LIVE mode (3 distinct addresses)`,
    `RPC_URL=https://polygon-rpc.com`,
    // Every provider choice speaks the OpenAI-compatible protocol
    // (OpenAI, any custom gateway, Ollama on this machine), so the brain
    // always runs with POLYROOT_FORECAST_PROVIDER=openai + OPENAI_BASE_URL.
    `POLYROOT_FORECAST_PROVIDER=openai`,
    `POLYROOT_FORECAST_MODEL=${config.model}`,
    `OPENAI_API_KEY=${config.apiKey}`,
    ...(config.baseUrl ? [`OPENAI_BASE_URL=${config.baseUrl}`] : []),
    "",
    "# Market discovery: the agent finds liquid markets itself by default.",
    "# Change to manual curation any time via `polyroot setup`.",
    `POLYROOT_MARKET_DISCOVERY=auto`,
    `POLYROOT_DISCOVERY_MIN_VOLUME_24H=10000`,
    `POLYROOT_DISCOVERY_MAX_MARKETS=5`,
    `POLYROOT_DISCOVERY_MAX_SPREAD=0.1`,
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
    let migrateOk = true;
    try {
      const { execSync } = await import("node:child_process");
      execSync("node --import tsx scripts/migrate.ts latest", {
        cwd: process.cwd(),
        stdio: "inherit",
      });
    } catch {
      migrateOk = false;
      console.log(
        "⚠️  Database not reachable yet — run `npm run migrate:latest` then `polyroot doctor` when PostgreSQL is up (try `polyroot docker-fix`).",
      );
    }
    let doctorOk = true;
    try {
      process.env["POLYROOT_ONBOARDING"] = "1";
      doctorOk = await runDoctor();
    } catch {
      doctorOk = false;
      console.log(
        "⚠️  Doctor reported issues — fix them with the hints above, or re-run `polyroot setup` any time.",
      );
    } finally {
      delete process.env["POLYROOT_ONBOARDING"];
    }

    // Reload env for current process
    process.loadEnvFile(ENV_PATH as string);

    // Land in a running PAPER demo: one safe practice trade, then stop.
    // Offered only when the database and health check both passed.
    if (migrateOk && doctorOk) {
      const demo = await askText("Watch a 1-step demo trade now? (y/n)", {
        defaultValue: "y",
      });
      if (demo.trim().toLowerCase().startsWith("y")) {
        try {
          await startAgent({
            mode: "SHADOW",
            databaseUrl: process.env["DATABASE_URL"] ?? "",
            kmsKeyId: "",
            kmsEndpoint: "",
            kmsRegion: "",
            once: true,
          });
        } catch {
          console.log(
            "⚠️  Demo trade did not run — try `polyroot run --once` later, or re-run `polyroot setup` any time.",
          );
        }
      }
    }
    console.log(box("Setup complete", ["PolyRoot Agent is ready."]));
    console.log(formatNextSteps(config.mode));

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

/** Helper: Wallet setup flow */
async function promptWalletSetup(
  prechoice?: "create" | "import",
): Promise<void> {
  console.log("\n🔐 Setting up Wallet (keys locked in vault)...");
  const walletChoice =
    prechoice ??
    (await askChoice(
      "Wallet:",
      ["Create new wallet (generates keystore)", "Import existing private key"],
      0,
    ));
  const isCreate = prechoice === "create" || walletChoice.startsWith("Create");
  let privateKey = "";
  let passphrase = "";
  if (isCreate) {
    for (;;) {
      passphrase = await askRequiredSecret("Create a vault passphrase");
      const confirm = await askRequiredSecret("Repeat the passphrase");
      if (passphrase === confirm) break;
      console.log("Passphrases do not match — try again.");
    }
    privateKey = "0x" + randomBytes(32).toString("hex");
    console.log(`\n✅ New wallet created!`);
    console.log(`   Address: ${deriveAddressFromPrivateKey(privateKey)}`);
  } else {
    for (;;) {
      privateKey = await askRequiredSecret("Private key (0x...)");
      if (/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) break;
      console.log("Wrong format — expected 64 hex characters.");
    }
    passphrase = await askRequiredSecret("Create a vault passphrase");
  }
  const keystore = sealPrivateKey(privateKey, passphrase);
  ensurePolyrootHome();
  writeFileSync(KEYSTORE_PATH, JSON.stringify(keystore, null, 2) + "\n", {
    mode: 0o600,
  });
  chmodSync(KEYSTORE_PATH, 0o600);

  const updates = [
    `POLYROOT_KEYSTORE_JSON=${JSON.stringify(keystore)}`,
    `POLYROOT_KEYSTORE_PASSPHRASE=${passphrase}`,
    `WALLET_ADDRESS=${deriveAddressFromPrivateKey(privateKey)}`,
  ];
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  writeFileSync(ENV_PATH, upsertEnvLines(existing, updates) + "\n", {
    mode: 0o600,
  });
  console.log(`🔐 Keystore saved to ${KEYSTORE_PATH} and updated .env`);
}

/** Helper: browse popular markets by name, resolve picks to token ids. */
async function promptMarketBrowser(): Promise<string[]> {
  console.log("\n📊 Fetching popular Polymarket markets...");
  let markets;
  try {
    markets = await fetchActiveMarkets(20);
  } catch (err) {
    console.log(`⚠️  ${(err as Error).message}`);
    console.log("   Falling back to manual paste.");
    return [];
  }
  if (markets.length === 0) {
    console.log("⚠️  No markets returned — keeping the old list.");
    return [];
  }
  console.log("");
  for (let i = 0; i < markets.length; i++) {
    const m = markets[i] as { question: string; volume24h: number };
    const vol = m.volume24h > 0 ? ` (24h vol $${Math.round(m.volume24h)})` : "";
    console.log(`  ${i + 1}. ${m.question}${vol}`);
  }
  console.log("");
  const pickRaw = await askText(
    'Pick numbers, comma-separated (e.g. "1,3"), "all", or Enter = cancel',
    { defaultValue: "" },
  );
  if (!pickRaw.trim()) {
    console.log("   Cancelled — keeping the old list.");
    return [];
  }
  try {
    const picked = parseMarketPick(pickRaw, markets);
    const ids = picked.flatMap((m) => [m.yesTokenId, m.noTokenId]);
    const validated = readMarketUniverse({
      POLYROOT_MARKET_IDS: ids.join(","),
    });
    console.log(`\n✅ Picked ${picked.length} market(s):`);
    for (const m of picked) console.log(`   • ${m.question}`);
    return validated;
  } catch (err) {
    console.log(`⚠️  ${(err as Error).message} — keeping the old one.`);
    return [];
  }
}

/** One raw console line (blank allowed — blank just re-shows the prompt). */
async function askConsoleLine(): Promise<string> {
  const t = theme();
  return askOnShared(t.enabled ? t.cyan("polyroot> ") : "polyroot> ", {
    muted: false,
  });
}

/** Live snapshot for the console: DB, guard latch, reservations, universe. */
async function printConsoleSnapshot(): Promise<void> {
  loadDotEnv();
  const env = process.env;
  const mode = env["RUNTIME_MODE"] ?? "SHADOW";
  console.log(`Mode: ${mode}`);
  const dbUrl = env["DATABASE_URL"] ?? "";
  if (!dbUrl) {
    console.log("Database: ❌ not configured (run: setup)");
    return;
  }
  try {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: dbUrl });
    try {
      await pool.query("SELECT 1");
      console.log("Database: ✅ connected");
      try {
        const g = await pool.query(
          "SELECT halted, realized_loss_pusd FROM live_guard_state LIMIT 1",
        );
        const row = g.rows[0] as
          { halted: boolean; realized_loss_pusd: string } | undefined;
        console.log(
          row
            ? `Loss latch: ${row.halted ? "🛑 HALTED" : "✅ armed"} (loss ${row.realized_loss_pusd ?? 0} pUSD)`
            : "Loss latch: (no state yet)",
        );
      } catch {
        console.log("Loss latch: (not initialized)");
      }
      try {
        const r = await pool.query(
          "SELECT count(*)::text AS c FROM reservations WHERE status='ACTIVE'",
        );
        console.log(`Active reservations: ${(r.rows[0] as { c: string }).c}`);
      } catch {
        console.log("Active reservations: (unknown)");
      }
    } finally {
      await pool.end().catch(() => undefined);
    }
  } catch {
    console.log("Database: ❌ unreachable (run: doctor)");
  }
  const universe = (env["POLYROOT_MARKET_IDS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const isAuto = resolveDiscoveryMode(env) === "auto";
  if (isAuto) {
    const b = parseDiscoveryBounds(env);
    console.log(
      `Markets tracked: AUTO — top ${b.maxMarkets} by 24h volume ≥ $${b.minVolume24h}, spread ≤ ${b.maxSpread}`,
    );
  } else {
    console.log(
      universe.length > 0
        ? `Markets tracked: ${universe.length} token id(s)`
        : "Markets tracked: none (run: setup → Auto/Browse)",
    );
  }
  console.log(`Wallet: ${env["WALLET_ADDRESS"] ?? "not set"}`);
}

function printConsoleHelp(): void {
  console.log(
    "\nCommands:\n" +
      "  run [flags]    Start the agent (mode from settings). Ctrl+C stops.\n" +
      "  restart        Stop the background agent, print how to start it\n" +
      "  status         Show configuration\n" +
      "  explain        Explain the latest AI decision chain\n" +
      "  halt           Emergency stop (latch + exit)\n" +
      "  health         Real-time system health\n" +
      "  insight        Market opportunities + heatmap\n" +
      "  backup         Export state (keystore, config, data)\n" +
      "  restore        Verify (and --apply) a backup\n" +
      "  logs [N]       Show recent agent activity (default 15 lines)\n" +
      "  logs --follow  Watch activity live (Ctrl+C back to prompt)\n" +
      "  shadow-fund    Credit SHADOW play bankroll: shadow-fund --amount 1000\n" +
      "  markets        Show popular markets (add --search <text>)\n" +
      "  doctor         Basic health check (add --live for the strict gate)\n" +
      "  setup          Guided configuration (mode, caps, markets, wallet, API)\n" +
      "  update           Pull latest version + rebuild + refresh launcher\n" +
      "  snapshot       Refresh the live snapshot above\n" +
      "  help           Show this list\n" +
      "  exit           Leave the console (back to terminal)\n",
  );
}

/** Known agent log files (newest first). */
function findAgentLogs(): string[] {
  const home = process.env["HOME"] ?? "/tmp";
  return ["shadow-48h.log", "agent.log"]
    .map((f) => `${home}/.polyroot/${f}`)
    .filter((p) => existsSync(p));
}

/** Print the tail of the agent log. Follows live until Ctrl+C when asked. */
async function runConsoleLogs(args: string[]): Promise<void> {
  const logs = findAgentLogs();
  if (logs.length === 0) {
    console.log(
      "No agent log yet. Start the agent first: type `run` here, or in a terminal: polyroot run",
    );
    return;
  }
  const path = logs[0] as string;
  const follow = args.includes("--follow") || args.includes("-f");
  const nRaw = Number(args.find((a) => /^\d+$/.test(a)));
  const n =
    Number.isFinite(nRaw) && nRaw > 0 ? Math.min(Math.floor(nRaw), 200) : 15;
  if (!follow) {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    console.log(`\n── ${path} (last ${Math.min(n, lines.length)}) ──`);
    for (const line of lines.slice(-n)) console.log(line);
    console.log(
      `\nTip: \`logs --follow\` watches live. \`exit\` leaves to terminal.\n`,
    );
    return;
  }
  console.log(`\n── following ${path} (Ctrl+C back to prompt) ──`);
  let shown = readFileSync(path, "utf8").split("\n").filter(Boolean).length;
  const timer = setInterval(() => {
    try {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      for (const line of lines.slice(shown)) console.log(line);
      shown = lines.length;
    } catch {
      // log rotated mid-follow — keep watching
    }
  }, 1000);
  try {
    await askOnShared("", { muted: true });
  } catch (err) {
    if (!(err instanceof OnboardingCancelled)) throw err;
  } finally {
    clearInterval(timer);
    console.log("\n— back to prompt —");
  }
}

/** Friendly fallback for anything the console doesn't understand. */
function printUnknownHint(raw: string): void {
  if (/^(hi|hello|hai|halo|hallo|hey|hy|p|test|tes)\b/i.test(raw)) {
    console.log(
      'Hi! Type "logs" to see what the agent is doing, "status" for configuration, "help" for all commands.',
    );
    return;
  }
  console.log(
    `Unknown command "${raw}". Try: logs | status | run | help | exit.`,
  );
  if (
    raw.includes("/") ||
    /^(tail|head|cat|curl|wget|cd|ls|ps|kill|sudo|docker|npm|node|git|nano|vim|echo|export|psql|grep|chmod|mkdir)\b/.test(
      raw,
    )
  ) {
    console.log(
      "That looks like a terminal command — those run OUTSIDE this console. Type `exit` first, then run it in the terminal.",
    );
  }
}

/**
 * `polyroot` with no arguments — interactive console, Hermes-style.
 * Opens a live snapshot + prompt. Ctrl+C never kills the console, it just
 * re-shows the prompt; `exit` leaves. `run` starts the trading loop
 * (blocking; Ctrl+C there stops the process, same as before).
 */
async function runConsole(): Promise<void> {
  console.log(banner("PolyRoot Agent — Console", "live terminal · type help"));
  await printConsoleSnapshot();
  console.log(
    '\nType "help" for commands, "run" to start the agent, "exit" to leave.\n',
  );
  for (;;) {
    let line: string;
    try {
      line = await askConsoleLine();
    } catch (err) {
      if (err instanceof OnboardingCancelled) {
        console.log("");
        continue;
      }
      if ((err as { code?: string }).code === "ERR_USE_AFTER_CLOSE") {
        // stdin EOF (piped input ended) — leave quietly, not a crash.
        closeSharedSession();
        return;
      }
      throw err;
    }
    const parts = line.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const cmd = (parts[0] as string).toLowerCase();
    const args = parts.slice(1);
    try {
      if (cmd === "exit" || cmd === "quit") {
        closeSharedSession();
        return;
      } else if (cmd === "help") {
        printConsoleHelp();
      } else if (cmd === "snapshot") {
        await printConsoleSnapshot();
      } else if (cmd === "status") {
        await runStatus();
      } else if (cmd === "explain") {
        await runExplainCLI(args);
      } else if (cmd === "halt") {
        await runHaltCLI(args);
      } else if (cmd === "health") {
        await runHealthCLI(args);
      } else if (cmd === "insight") {
        await runInsightCLI(args);
      } else if (cmd === "backup") {
        await runBackupCLI(args);
      } else if (cmd === "restore") {
        await runRestoreCLI(args);
      } else if (cmd === "setup") {
        await runSetupFlow();
      } else if (cmd === "shadow-fund") {
        const aIdx = args.indexOf("--amount");
        const amountRaw =
          aIdx >= 0 && args[aIdx + 1] && !args[aIdx + 1]?.startsWith("--")
            ? (args[aIdx + 1] as string)
            : "";
        if (!amountRaw) {
          console.log("Usage: shadow-fund --amount <usd>");
        } else {
          await runShadowFund(amountRaw);
        }
      } else if (cmd === "doctor") {
        if (args.includes("--live")) await runLiveDoctor();
        else await runDoctor();
      } else if (cmd === "markets") {
        const qIdx = args.indexOf("--search");
        const query =
          qIdx >= 0 && args[qIdx + 1] && !args[qIdx + 1]?.startsWith("--")
            ? (args[qIdx + 1] as string).toLowerCase()
            : "";
        const spin = startSpinner("Fetching live markets…");
        let all: Awaited<ReturnType<typeof fetchActiveMarkets>>;
        try {
          all = await fetchActiveMarkets(50);
        } finally {
          spin.stop();
        }
        const list = query
          ? all.filter((m) => m.question.toLowerCase().includes(query))
          : all;
        const shown = list.slice(0, 10);
        if (shown.length > 0) {
          console.log(
            table(
              ["#", "Market", "24h Vol"],
              shown.map((m, i) => [
                String(i + 1),
                m.question,
                `$${Math.round(m.volume24h).toLocaleString("en-US")}`,
              ]),
            ),
          );
        }
        if (list.length === 0) console.log("No markets found.");
        console.log(
          `\nShowing ${Math.min(list.length, 10)} of ${list.length}. Pick in: setup\n`,
        );
      } else if (cmd === "logs" || cmd === "log") {
        await runConsoleLogs(args);
      } else if (cmd === "update") {
        await runUpdate();
      } else if (cmd === "restart") {
        await runRestart(args);
      } else if (cmd === "run" || cmd === "start") {
        // The loop owns stdin via readline (raw mode) which would swallow
        // Ctrl+C meant for the agent — hand the terminal back first.
        closeSharedSession();
        const config = parseArgs(args);
        assertRuntimeEnv(config.mode);
        if (config.mode === "MICRO_LIVE") {
          await assertMicroLiveReady(config.databaseUrl);
        }
        await startAgent(config);
        return;
      } else {
        printUnknownHint(parts.join(" "));
      }
    } catch (err) {
      if (err instanceof OnboardingCancelled) {
        console.log("\nCancelled.");
        continue;
      }
      console.error(`❌ ${(err as Error).message}`);
    }
  }
}

/** `polyroot shadow-fund --amount <usd>` — credit SHADOW play bankroll.
 *  Play money only: hard-refused on MICRO_LIVE/LIVE so sim funds can never
 *  touch real money. Idempotent (sets, not adds) for a clean baseline. */
async function runShadowFund(amountRaw: string): Promise<void> {
  loadDotEnv();
  const mode = (process.env["RUNTIME_MODE"] ?? "SHADOW").toUpperCase();
  if (mode === "MICRO_LIVE" || mode === "LIVE") {
    console.error(
      "❌ REFUSED: shadow-fund is play money — never on MICRO_LIVE/LIVE.",
    );
    process.exit(1);
  }
  const amount = Number(amountRaw);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    console.error(
      "Usage: polyroot shadow-fund --amount <usd>  (0 < amount ≤ 1000000)",
    );
    process.exit(1);
  }
  const dbUrl = process.env["DATABASE_URL"] ?? "";
  if (!dbUrl) {
    console.error("❌ DATABASE_URL not set");
    process.exit(1);
  }
  const wallet = buildWalletIdentity(mode === "SHADOW" ? "SHADOW" : "PAPER");
  const pool = new Pool({ connectionString: dbUrl });
  try {
    await pool.query(
      `INSERT INTO balance_entries (account, asset, available_base, committed_base, updated_at)
       VALUES ($1, 'pUSD', $2, 0, now())
       ON CONFLICT (account, asset)
       DO UPDATE SET available_base = EXCLUDED.available_base, committed_base = 0, updated_at = now()`,
      [wallet.funder, decimalToBase(amount).toString()],
    );
    console.log(
      `✅ Shadow bankroll: $${amount} play money → ${wallet.funder} (pUSD).`,
    );
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * Stop any background agent, then print the exact command to start it.
 * Print-only by design: actually starting a daemon belongs to systemd /
 * tmux / nohup at the operator's terminal, not inside this process.
 * Never touches wallets, keys, or the database, so it is safe anywhere.
 */
async function restartBackgroundAgent(): Promise<void> {
  loadDotEnv();
  const polyrootHome =
    process.env["HOME"] !== undefined
      ? `${process.env["HOME"]}/.polyroot`
      : "/tmp/.polyroot";

  console.log("🔄 Restarting PolyRoot agent...");

  const { execSync } = await import("node:child_process");
  try {
    execSync("pkill -f 'node.*cli\\.js' 2>/dev/null || true", {
      stdio: "ignore",
    });
    await new Promise((r) => setTimeout(r, 1500));
    console.log("✅ Stopped previous agent");
  } catch {
    // pkill returns non-zero when nothing matched — that is fine
  }

  const logFile = `${polyrootHome}/paper.log`;
  // Prefer the 24/7 supervisor when it owns this machine: the unit runs
  // `cli.js run` (trading loop) with Restart=always. nohup is the fallback
  // for containers/WSL/macOS without a PID-1 systemd.
  // POLYROOT_NO_SYSTEMD=1 forces the fallback (hermetic tests, manual runs).
  let systemdLoaded = false;
  if (process.env["POLYROOT_NO_SYSTEMD"] !== "1") {
    try {
      const show = execSync("systemctl show polyroot --property=LoadState 2>/dev/null", {
        encoding: "utf8",
      });
      systemdLoaded = show.trim() === "LoadState=loaded";
    } catch {
      systemdLoaded = false;
    }
  }
  if (systemdLoaded) {
    console.log("\n📋 systemd owns the 24/7 loop on this machine. Run:");
    console.log("   sudo systemctl restart polyroot");
    console.log("\n📝 Logs: sudo journalctl -u polyroot -f");
    console.log("🏥 Health: curl http://127.0.0.1:9090/healthz");
    console.log("🔍 Status: sudo systemctl status polyroot");
    return;
  }
  console.log("\n📋 To start the agent in background, run:");
  console.log(
    `   cd "${polyrootHome}" && setsid nohup polyroot run >> "${logFile}" 2>&1 &`,
  );
  console.log(`\n📝 Logs: tail -f ${logFile}`);
  console.log(`🏥 Health: curl http://127.0.0.1:9090/healthz`);
  console.log(
    "\n💡 Tip: For 24/7 production, install the supervisor: bash ~/.polyroot/scripts/install-systemd.sh",
  );
}

/** `restart` inside the interactive console. */
async function runRestart(_args: string[]): Promise<void> {
  await restartBackgroundAgent();
}

/** Top-level `polyroot restart`. */
async function runRestartCLI(): Promise<void> {
  await restartBackgroundAgent();
}

/** Helper: Polymarket API setup flow */
async function promptVenueCredentials(): Promise<void> {
  console.log("\n🏪 Setting up Polymarket API credentials...");
  const apiKey = await askText("Polymarket API Key");
  const apiSecret = await askRequiredSecret("Polymarket API Secret");
  const apiPassphrase = await askRequiredSecret("Polymarket API Passphrase");

  const updates = [
    `POLYMARKET_API_KEY=${apiKey}`,
    `POLYMARKET_API_SECRET=${apiSecret}`,
    `POLYMARKET_API_PASSPHRASE=${apiPassphrase}`,
  ];
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  writeFileSync(ENV_PATH, upsertEnvLines(existing, updates) + "\n", {
    mode: 0o600,
  });
  console.log(`✅ Polymarket credentials updated in .env`);
}

/**
 * `polyroot setup` — re-runnable guided configuration for lay operators.
 * Changes mode, capital cap, loss latch, market universe, and wallet/keys.
 * All-in-one: mode, bounds, markets, wallet, and API credentials.
 */
async function runSetupFlow(): Promise<void> {
  try {
    loadDotEnv();
    console.log(banner("PolyRoot Setup — Full Configuration", "mode · bounds · markets · wallet · credentials"));

    // 1. MODE SELECTION
    const currentMode = process.env["RUNTIME_MODE"] ?? "PAPER";
    console.log("Current mode: " + currentMode);
    console.log(
      "PAPER = practice with play money. SHADOW = live data, sim fills. LIVE = real money. MICRO_LIVE = small cap real money.\n",
    );
    const modeChoice = await askChoice(
      "Choose mode (Enter = keep current):",
      [
        "PAPER — Safe simulation, mock data, no real money",
        "SHADOW — Live Polymarket data, simulated fills, $0 risk",
        "MICRO_LIVE — Real trading with small cap (requires capital, API keys)",
        "LIVE — Real trading on Polymarket (requires capital, API keys)",
      ],
      currentMode === "LIVE"
        ? 3
        : currentMode === "MICRO_LIVE"
          ? 2
          : currentMode === "SHADOW"
            ? 1
            : 0,
    );
    const mode = (() => {
      if (modeChoice.startsWith("LIVE")) return "LIVE";
      if (modeChoice.startsWith("MICRO")) return "MICRO_LIVE";
      if (modeChoice.startsWith("SHADOW")) return "SHADOW";
      return "PAPER";
    })() as "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE";

    // 2. CAPITAL & LOSS CAP
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

    // 3. MARKET UNIVERSE — fresh users get Auto by default (one Enter and
    // the agent finds liquid markets itself); existing config is kept
    // unless the owner explicitly changes it.
    let universe: string[] = [];
    let discovery:
      | {
          mode: "auto" | "manual";
          minVolume24h?: number;
          maxMarkets?: number;
          maxSpread?: number;
        }
      | undefined;
    const currentUniverse = process.env["POLYROOT_MARKET_IDS"] ?? "";
    const alreadyAuto = resolveDiscoveryMode(process.env) === "auto";
    // Explicit config (ids or an explicit flag) keeps the "Keep current"
    // menu first; fresh installs fall through to the Auto-recommended menu.
    const hasMarketConfig =
      Boolean(currentUniverse) ||
      (process.env["POLYROOT_MARKET_DISCOVERY"] ?? "").trim().length > 0;
    if (currentUniverse) {
      console.log(`\nCurrent markets: ${currentUniverse}`);
    }
    console.log(`Discovery: ${alreadyAuto ? "Auto" : "Manual"}`);
    const marketOptions = hasMarketConfig
      ? [
          "Keep current",
          "Auto — agent finds the most liquid markets itself",
          "Browse popular markets — pick by name",
          "Paste token IDs manually (advanced)",
        ]
      : [
          "Auto — agent finds the most liquid markets itself (recommended)",
          "Browse popular markets — pick by name",
          "Paste token IDs manually (advanced)",
          "No markets (PAPER only)",
        ];
    const marketHow = await askChoice(
      hasMarketConfig
        ? "Choose markets (Enter = keep current):"
        : "Choose markets (Enter = auto):",
      marketOptions,
      0,
    );
    if (marketHow.startsWith("Auto")) {
      const bounds = parseDiscoveryBounds(process.env);
      console.log(
        "\nAuto-discovery guardrails: liquid markets only — above your",
      );
      console.log("minimum 24h volume, touch spread within your max.");
      const minRaw = await askText(
        "Minimum 24h volume in USD (Enter = 10000)",
        {
          defaultValue: String(bounds.minVolume24h),
        },
      );
      const maxRaw = await askText("Max markets, 1-20 (Enter = 5)", {
        defaultValue: String(bounds.maxMarkets),
      });
      const spreadRaw = await askText("Max spread 0.01-0.50 (Enter = 0.10)", {
        defaultValue: String(bounds.maxSpread),
      });
      const minParsed = Number(minRaw);
      const maxParsed = Number(maxRaw);
      const spreadParsed = Number(spreadRaw);
      discovery = {
        mode: "auto",
        minVolume24h:
          Number.isFinite(minParsed) && minParsed > 0
            ? Math.floor(minParsed)
            : bounds.minVolume24h,
        maxMarkets:
          Number.isFinite(maxParsed) && maxParsed > 0
            ? Math.min(Math.floor(maxParsed), 20)
            : bounds.maxMarkets,
        maxSpread:
          Number.isFinite(spreadParsed) && spreadParsed > 0
            ? Math.min(Math.max(spreadParsed, 0.01), 0.5)
            : bounds.maxSpread,
      };
      console.log(
        `\n✅ Auto-discovery on: top ${discovery.maxMarkets} markets by 24h volume ≥ $${discovery.minVolume24h}, spread ≤ ${discovery.maxSpread}.`,
      );
    } else if (marketHow.startsWith("Browse")) {
      universe = await promptMarketBrowser();
      if (universe.length > 0) discovery = { mode: "manual" };
    } else if (marketHow.startsWith("Paste")) {
      console.log("\nMarket list = Polymarket token IDs, separated by commas.");
      const universeRaw = await askText("Market list", { defaultValue: "" });
      const trimmed = universeRaw.trim();
      if (trimmed) {
        try {
          universe = readMarketUniverse({ POLYROOT_MARKET_IDS: trimmed });
          discovery = { mode: "manual" };
        } catch (err) {
          console.log(
            `⚠️  Invalid market list (${(err as Error).message}) — keeping the old one.`,
          );
        }
      }
    } else {
      console.log("   Keeping current market list.");
    }

    // 4. WALLET SETUP (skippable — Enter keeps going, never blocks)
    console.log("\n═══ Wallet & Credentials ═══");
    const hasKeystore = Boolean(process.env["POLYROOT_KEYSTORE_JSON"]);
    const hasPassphrase = Boolean(process.env["POLYROOT_KEYSTORE_PASSPHRASE"]);
    if (hasKeystore && hasPassphrase) {
      console.log("✅ Keystore already configured. Keep it? (Enter = keep)");
      const keep = await askText("", { defaultValue: "y" });
      if (!keep.trim().toLowerCase().startsWith("n")) {
        console.log("   Keeping existing keystore.");
      } else {
        await promptWalletSetup();
      }
    } else {
      const walletSkip = await askChoice(
        "Wallet (Enter = skip for now):",
        [
          "Skip for now — PAPER mode needs no wallet",
          "Create new wallet (generates keystore)",
          "Import existing private key",
        ],
        0,
      );
      if (!walletSkip.startsWith("Skip")) {
        if (walletSkip.startsWith("Create")) {
          await promptWalletSetup("create");
        } else {
          await promptWalletSetup("import");
        }
      } else {
        console.log("   Skipped — run 'polyroot setup' again to add a wallet.");
      }
    }

    // 5. VENUE API CREDENTIALS (for non-PAPER modes, skippable)
    if (mode !== "PAPER") {
      const venueSkip = await askChoice(
        "Polymarket API credentials (Enter = skip for now):",
        ["Skip for now", "Enter API credentials now"],
        0,
      );
      if (!venueSkip.startsWith("Skip")) {
        await promptVenueCredentials();
      } else {
        console.log("   Skipped — add later via 'polyroot setup'.");
      }
    }

    // 6. SAVE ALL TO .env
    const updates = buildSetupEnvUpdate({
      capitalUsd,
      lossBps,
      mode,
      universe,
      ...(discovery ? { discovery } : {}),
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
    console.log(formatNextSteps(mode as "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE"));
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
  fetchActiveMarkets,
  parseDiscoveryBounds,
  parseMarketPick,
  readMarketUniverse,
  resolveDiscoveryMode,
  resolveMarketUniverse,
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
    }) => Promise<OnceTranscriptResult>;
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
    const onceInput = { market_id: "mock_market_1", bid: 0.45, ask: 0.55 };
    const result = await pipeline.processMarket(onceInput);
    console.log(formatOnceTranscript(onceInput, result));
    console.log("Once result: " + JSON.stringify(result));
    // Flush fire-and-forget step writes before closing the pool,
    // otherwise the single cycle's rows are lost on exit.
    await flushStepPersistence();
    await agent.pool.end().catch(() => undefined);
    return;
  }

  let stopping = false;
  let stopResolutionSync: (() => void) | null = null;
  let stopArbScan: (() => void) | null = null;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal} — stopping agent...`);
    try {
      stopResolutionSync?.();
    } catch (err: unknown) {
      console.error("Resolution sync stop error:", err);
    }
    try {
      stopArbScan?.();
    } catch (err: unknown) {
      console.error("Arb scan stop error:", err);
    }
    try {
      agent.smartMoneySync?.stop();
    } catch (err: unknown) {
      console.error("Smart-money sync stop error:", err);
    }
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
    // Flush pending step writes (5s cap), then close the shared PG pool
    // so the event loop can drain, then exit. Without pool.end the
    // process hangs on open pool sockets until SIGKILL.
    void Promise.race([
      flushStepPersistence(),
      new Promise((r) => setTimeout(r, 5000)),
    ])
      .catch(() => undefined)
      .then(() => agent.pool.end())
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

  // Learning loop: record Gamma resolutions → retrain calibration.
  // Fail-open by construction (a dead learner never blocks trading);
  // disable with POLYROOT_RESOLUTION_SYNC=0.
  if (process.env["POLYROOT_RESOLUTION_SYNC"] !== "0") {
    try {
      const { startResolutionSync } = await import("./resolution-sync.js");
      const { PgCalibrationService } = await import("@polyroot/intelligence");
      const syncMs = Number(process.env["POLYROOT_RESOLUTION_SYNC_MS"]);
      const handle = startResolutionSync({
        pool: agent.pool,
        calibration: new PgCalibrationService(agent.pool),
        ...(Number.isFinite(syncMs) && syncMs > 0 ? { intervalMs: syncMs } : {}),
        onTick: (s) =>
          console.log(
            `📚 Resolution sync: ${s.decidedMarkets} decided, ${s.recordedNew} new, calibration ${s.calibrationGroups} group(s)/${s.calibrationSamples} samples`,
          ),
        onError: (e) =>
          console.log(`⚠️  Resolution sync skipped: ${e.message}`),
      });
      stopResolutionSync = handle.stop;
    } catch (err) {
      console.log(
        `⚠️  Resolution sync unavailable: ${(err as Error).message}`,
      );
    }
  }

  // Arb observation (research evidence only — never fills): scan active
  // events for sum≠1 baskets and log what it finds. Disable with
  // POLYROOT_ARB_SCAN=0.
  if (process.env["POLYROOT_ARB_SCAN"] !== "0") {
    try {
      const { startArbScan } = await import("@polyroot/venue");
      const arbMs = Number(process.env["POLYROOT_ARB_SCAN_MS"]);
      const handle = startArbScan({
        pool: agent.pool,
        ...(Number.isFinite(arbMs) && arbMs > 0 ? { intervalMs: arbMs } : {}),
        onTick: (s) =>
          console.log(
            `🔭 Arb scan: ${s.eventsScanned} events, ${s.tokensRead} touches, ${s.observations} observation(s)`,
          ),
        onError: (e) => console.log(`⚠️  Arb scan skipped: ${e.message}`),
      });
      stopArbScan = handle.stop;
    } catch (err) {
      console.log(`⚠️  Arb scan unavailable: ${(err as Error).message}`);
    }
  }

  await pipeline.runContinuous();
  // Resolved without a signal (e.g. stop() called externally):
  // flush step writes, then close the pool so the process can exit cleanly.
  if (!stopping) {
    try {
      stopResolutionSync?.();
    } catch {
      // never block shutdown on timer cleanup
    }
    try {
      stopArbScan?.();
    } catch {
      // never block shutdown on timer cleanup
    }
    try {
      agent.smartMoneySync?.stop();
    } catch {
      // never block shutdown on timer cleanup
    }
    try {
      agent.stopReservationExpiry();
    } catch {
      // never block shutdown on timer cleanup
    }
    await metricsServer.stop().catch(() => undefined);
    await flushStepPersistence().catch(() => undefined);
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
 * Mode command - displays or dynamically updates the runtime mode in database.
 */
async function runModeCommand(targetMode?: string): Promise<void> {
  loadDotEnv();
  const dbUrl = process.env["DATABASE_URL"];
  if (!dbUrl) {
    console.error("❌ DATABASE_URL required to query or update mode.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString: dbUrl });
  try {
    const { ModeWatcher } = await import("./mode-watcher.js");
    const watcher = new ModeWatcher({ pool, initialMode: "PAPER" });
    await watcher.pollOnce();

    if (!targetMode) {
      console.log(`\n🎯 Current Runtime Mode (DB): ${watcher.getMode()}`);
      console.log(
        `   Degraded Status: ${watcher.isDegraded() ? "⚠️ DEGRADED (READ_ONLY)" : "✅ HEALTHY"}\n`,
      );
      return;
    }

    const upper = targetMode.toUpperCase();
    const MODES: readonly RuntimeMode[] = [
      "PAPER",
      "SHADOW",
      "MICRO_LIVE",
      "LIVE",
    ];
    if (!(MODES as readonly string[]).includes(upper)) {
      console.error(
        `❌ Invalid mode ${targetMode}. Valid modes: ${MODES.join(", ")}`,
      );
      process.exit(1);
    }

    console.log(`🔄 Requesting mode transition -> ${upper}...`);
    const res = await watcher.requestModeChange(
      upper as RuntimeMode,
      "cli_operator",
    );
    if (!res.ok) {
      console.error(`❌ Mode transition rejected: [${res.code}] ${res.reason}`);
      process.exit(1);
    }
    console.log(`✅ Runtime mode successfully updated to: ${res.mode}\n`);

    // Also update .env file to persist the mode for CLI args parsing
    try {
      const home = process.env["HOME"] ?? "/tmp";
      const envPath = `${home}/.polyroot/.env`;
      if (existsSync(envPath)) {
        const existing = readFileSync(envPath, "utf8");
        const updated = upsertEnvLines(existing, [`RUNTIME_MODE=${res.mode}`]);
        writeFileSync(envPath, updated, "utf8");
        console.log(`💾 Persisted mode to .env: RUNTIME_MODE=${res.mode}`);
      }
    } catch (envErr) {
      console.warn(`⚠️  Failed to update .env file: ${envErr}`);
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
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

/**
 * Explain command - prints the human-readable reason chain for the latest
 * simulated decision(s). Read-only: never writes to the database.
 * Usage: polyroot explain [--last <N>] [--json]
 */
async function runExplainCLI(args: string[]): Promise<void> {
  loadDotEnv();
  const dbUrl = process.env["DATABASE_URL"] ?? "";
  if (!dbUrl) {
    console.error("❌ DATABASE_URL required (set in ~/.polyroot/.env).");
    process.exit(1);
  }
  const lIdx = args.indexOf("--last");
  const lastRaw = lIdx >= 0 ? Number(args[lIdx + 1]) : 1;
  const last =
    Number.isFinite(lastRaw) && lastRaw > 0
      ? Math.min(Math.floor(lastRaw), 20)
      : 1;
  const asJson = args.includes("--json");
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const text = await explainLastDecision(pool, last);
    if (asJson) {
      console.log(JSON.stringify({ ok: true, last, explanation: text }));
    } else {
      console.log(text);
    }
  } catch (err) {
    console.error(`❌ explain failed: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * Halt command - emergency kill switch. Engages the loss latch, optionally
 * cancels open venue orders, stops local agents, then exits(1).
 * Usage: polyroot halt [--cancel-orders] [--reason "text"] [--force] [--json]
 */
async function runHaltCLI(args: string[]): Promise<void> {
  loadDotEnv();
  const dbUrl = process.env["DATABASE_URL"] ?? "";
  if (!dbUrl) {
    console.error("❌ DATABASE_URL required (set in ~/.polyroot/.env).");
    process.exit(1);
  }
  const cancelOrders = args.includes("--cancel-orders");
  const force = args.includes("--force");
  const asJson = args.includes("--json");
  const rIdx = args.indexOf("--reason");
  const reason =
    rIdx >= 0 && args[rIdx + 1] && !args[rIdx + 1]?.startsWith("--")
      ? (args[rIdx + 1] as string)
      : "operator halt";
  if (!force) {
    const choice = await askChoice(
      "⚠️  HALT will engage the loss latch, stop local agents and exit. Continue?",
      ["Abort", "HALT NOW"],
    );
    if (choice !== "HALT NOW") {
      console.log("Aborted — nothing was changed.");
      return;
    }
  }
  let cancelVenueOrder: ((id: string) => Promise<boolean>) | undefined;
  if (cancelOrders) {
    try {
      const adapter = await buildLiveVenueAdapter();
      cancelVenueOrder = async (id: string): Promise<boolean> => {
        const res = await adapter.cancelOrder(id);
        return res.ok;
      };
    } catch {
      console.warn(
        "⚠️  Live venue credentials missing — skipping remote cancels (latch still engages).",
      );
    }
  }
  const pool = new Pool({ connectionString: dbUrl });
  try {
    await requestHalt(
      {
        pool,
        cancelVenueOrder,
        killLocalAgents: async () => {
          const { execSync } = await import("node:child_process");
          try {
            execSync("pkill -f 'node.*cli\\.js' 2>/dev/null || true", {
              stdio: "ignore",
            });
          } catch {
            // pkill non-zero when nothing matched — fine
          }
        },
        report: (r) => {
          if (asJson) {
            console.log(JSON.stringify({ ok: true, ...r }));
          } else {
            console.log("\n🛑 HALT engaged");
            console.log(`  Reason: ${r.reason}`);
            console.log(`  Open orders found: ${r.openOrders}`);
            console.log(`  Remote cancels confirmed: ${r.canceledOrders}`);
            console.log("  Exiting (supervisors should restart manually).");
          }
        },
      },
      { reason, cancelOrders },
    );
  } catch (err) {
    console.error(`❌ halt failed: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * Health command - real-time system health across DB, pipeline, RPC, venue.
 * Usage: polyroot health [--json] [--watch]
 */
async function runHealthCLI(args: string[]): Promise<void> {
  loadDotEnv();
  const dbUrl = process.env["DATABASE_URL"] ?? "";
  if (!dbUrl) {
    console.error("❌ DATABASE_URL required (set in ~/.polyroot/.env).");
    process.exit(1);
  }
  const asJson = args.includes("--json");
  const watch = args.includes("--watch");
  const rpcUrl = process.env["RPC_URL"];
  const pool = new Pool({ connectionString: dbUrl });
  try {
    for (;;) {
      const report = await collectHealth({ pool, rpcUrl });
      if (watch) console.clear();
      console.log(formatHealth(report, asJson));
      if (!watch) {
        if (report.overall === "DOWN") process.exit(1);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (err) {
    console.error(`❌ health failed: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * Insight command - strategic market intelligence: opportunity ranking,
 * single-market deep dive, or risk heatmap. Read-only.
 * Usage: polyroot insight [--market <token-id>] [--heatmap] [--json]
 */
async function runInsightCLI(args: string[]): Promise<void> {
  loadDotEnv();
  const dbUrl = process.env["DATABASE_URL"] ?? "";
  if (!dbUrl) {
    console.error("❌ DATABASE_URL required (set in ~/.polyroot/.env).");
    process.exit(1);
  }
  const asJson = args.includes("--json");
  const heatmap = args.includes("--heatmap");
  const mIdx = args.indexOf("--market");
  const marketId =
    mIdx >= 0 && args[mIdx + 1] && !args[mIdx + 1]?.startsWith("--")
      ? (args[mIdx + 1] as string)
      : "";
  const pool = new Pool({ connectionString: dbUrl });
  try {
    if (marketId) {
      const text = await marketDeepDive(pool, marketId);
      console.log(asJson ? JSON.stringify({ ok: true, marketId, text }) : text);
      return;
    }
    const rows = await topOpportunities(pool, heatmap ? 20 : 10);
    if (heatmap) {
      const risks = ["Low", "Med", "High"] as const;
      const labels = ["BUY", "WATCH", "AVOID"] as const;
      const lines = ["🌡️ Risk Heatmap (label × risk)", ""];
      lines.push("        Low   Med   High");
      for (const label of labels) {
        const cells = risks.map((risk) =>
          String(
            rows.filter((r) => r.label === label && r.risk === risk).length,
          ).padStart(5),
        );
        const icon = label === "BUY" ? "🟢" : label === "WATCH" ? "🟡" : "🔴";
        lines.push(`${icon} ${label.padEnd(5)}${cells.join("")}`);
      }
      console.log(
        asJson
          ? JSON.stringify({ ok: true, heatmap: true, markets: rows })
          : lines.join("\n"),
      );
      return;
    }
    console.log(formatInsight(rows, asJson));
  } catch (err) {
    console.error(`❌ insight failed: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * Backup command - export operator state + reference data to a directory.
 * Usage: polyroot backup [--output <dir>] [--encrypt] [--json]
 */
async function runBackupCLI(args: string[]): Promise<void> {
  loadDotEnv();
  const dbUrl = process.env["DATABASE_URL"] ?? "";
  if (!dbUrl) {
    console.error("❌ DATABASE_URL required (set in ~/.polyroot/.env).");
    process.exit(1);
  }
  const oIdx = args.indexOf("--output");
  const home = process.env["HOME"] ?? "/tmp";
  const defaultDir = `${home}/.polyroot/backups/backup-${new Date().toISOString().slice(0, 10)}`;
  const outDir =
    oIdx >= 0 && args[oIdx + 1] && !args[oIdx + 1]?.startsWith("--")
      ? (args[oIdx + 1] as string)
      : defaultDir;
  const encrypt = args.includes("--encrypt");
  const asJson = args.includes("--json");
  const passphrase = process.env["POLYROOT_BACKUP_PASSPHRASE"];
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const { manifestPath, files } = await createBackup(
      { pool, homeDir: `${home}/.polyroot` },
      { outDir, encrypt, passphrase },
    );
    if (asJson) {
      console.log(JSON.stringify({ ok: true, manifestPath, files }));
    } else {
      console.log(`\n✅ Backup complete: ${manifestPath}`);
      console.log(
        `   Files: ${files.length} (${encrypt ? "encrypted" : "redacted"})`,
      );
      for (const f of files) console.log(`   • ${f}`);
      if (!encrypt) {
        console.log(
          "\n💡 Tip: re-run with --encrypt + POLYROOT_BACKUP_PASSPHRASE",
        );
        console.log("   so a future restore can bring secrets back.");
      }
    }
  } catch (err) {
    console.error(`❌ backup failed: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * Restore command - verify a backup, optionally apply it.
 * Usage: polyroot restore --from <dir> [--apply] [--json]
 */
async function runRestoreCLI(args: string[]): Promise<void> {
  loadDotEnv();
  const dbUrl = process.env["DATABASE_URL"] ?? "";
  if (!dbUrl) {
    console.error("❌ DATABASE_URL required (set in ~/.polyroot/.env).");
    process.exit(1);
  }
  const fIdx = args.indexOf("--from");
  const fromDir =
    fIdx >= 0 && args[fIdx + 1] && !args[fIdx + 1]?.startsWith("--")
      ? (args[fIdx + 1] as string)
      : "";
  if (!fromDir) {
    console.error("Usage: polyroot restore --from <backup-dir> [--apply]");
    process.exit(1);
  }
  const apply = args.includes("--apply");
  const asJson = args.includes("--json");
  const passphrase = process.env["POLYROOT_BACKUP_PASSPHRASE"];
  const home = process.env["HOME"] ?? "/tmp";
  const pool = new Pool({ connectionString: dbUrl });
  try {
    const result = await restoreBackup(
      { pool, homeDir: `${home}/.polyroot` },
      { fromDir, apply, passphrase },
    );
    if (asJson) {
      console.log(JSON.stringify({ ok: true, ...result }));
    } else {
      console.log(
        `\n✅ Verified ${result.verified.length} file(s) — checksums OK`,
      );
      if (result.apply) {
        console.log(
          `   Restored: ${result.restored.join(", ") || "(nothing)"}`,
        );
      } else {
        console.log("   Dry-run only — pass --apply to write files.");
      }
      for (const n of result.notes) console.log(`   • ${n}`);
    }
  } catch (err) {
    console.error(`❌ restore failed: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/** Status command - shows current configuration and health. */
async function runStatus(): Promise<void> {
  loadDotEnv();
  const env = process.env;
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

  const t = theme();
  console.log(banner("PolyRoot Agent — Status"));
  console.log(t.bold("📋 Configuration:"));
  console.log(
    kv(
      [
        ["Mode:", mode],
        ["Database:", dbUrl],
        ["RPC URL:", rpc],
        ["Metrics:", metricsKey],
      ],
      t,
    ),
  );
  console.log("");
  console.log(t.bold("🔐 Wallet:"));
  console.log(
    kv(
      [
        ["Keystore:", hasKeystore ? "✅ Set" : "❌ Missing"],
        ["Passphrase:", hasPassphrase ? "✅ Set" : "❌ Missing"],
        ["Raw Key:", hasRawKey ? "✅ Set" : "❌ Missing"],
        ["Address:", walletAddr],
        ["Account:", account],
        ["Funder:", funder],
      ],
      t,
    ),
  );
  console.log("");
  console.log(t.bold("🏪 Venue (Polymarket):"));
  console.log(
    kv(
      [
        ["API Key:", venueKey],
        ["API Secret:", venueSecret],
        ["Passphrase:", venuePassphrase],
      ],
      t,
    ),
  );
  console.log("");
  console.log(t.bold("🛡️  Live Caps:"));
  console.log(
    kv(
      [
        ["Loss Cap (pUSD):", lossCap],
        ["Exposure Cap (pUSD):", expCap],
      ],
      t,
    ),
  );
  console.log("");
  console.log(t.bold("⚙️  Supervisor (24/7):"));
  console.log(kv([["Service:", await supervisorState()]], t));
  console.log("");
  console.log(`📁 Config: ${t.dim("~/.polyroot/.env")}`);
  console.log(`🔐 Keystore: ${t.dim("~/.polyroot/keystore.json")}`);
  console.log("\n═══════════════════════════════════════════════\n");
}

/**
 * One-line systemd state for `polyroot status`: active/enabled/loaded,
 * missing-unit, or unavailable (non-systemd hosts). Static command, no
 * user input — execSync is safe here. Never throws.
 */
async function supervisorState(): Promise<string> {
  if (process.env["POLYROOT_NO_SYSTEMD"] === "1") return "skipped (manual mode)";
  try {
    const { execSync } = await import("node:child_process");
    const show = execSync(
      "systemctl show polyroot --property=LoadState,ActiveState,UnitFileState 2>/dev/null",
      { encoding: "utf8" },
    ) as string;
    const get = (k: string): string => {
      const m = new RegExp(`^${k}=(.*)$`, "m").exec(show);
      return (m?.[1] ?? "").trim();
    };
    if (get("LoadState") !== "loaded") return "❌ unit not installed";
    const active = get("ActiveState");
    const enabled = get("UnitFileState");
    const icon = active === "active" ? "✅" : "⚠️ ";
    return `${icon} ${active} / ${enabled}`;
  } catch {
    return "unavailable (no systemd)";
  }
}

/** Update command - git pull, rebuild, refresh launcher, remind migrations. */
async function runUpdate(): Promise<void> {
  console.log("\n🔄 Updating PolyRoot Agent...\n");
  const { execSync } = await import("node:child_process");
  const home = process.env["HOME"] ?? "/tmp";
  const installDir = process.env["POLYROOT_AGENT_DIR"] || `${home}/.polyroot`;
  // Launcher already cds here, so this loads the install's own .env —
  // auto-migrate below then targets the REAL database, not the script default.
  loadDotEnv();

  try {
    console.log(`📥 Pulling latest changes in ${installDir}...`);
    execSync("git pull", { cwd: installDir, stdio: "inherit" });

    console.log("\n📦 Installing dependencies...");
    execSync("npm ci", { cwd: installDir, stdio: "inherit" });

    console.log("\n🔨 Building...");
    execSync("npx turbo run build", { cwd: installDir, stdio: "inherit" });

    // Refresh the launcher so already-installed users pick up launcher
    // fixes (e.g. tsx → compiled node). Best-effort: never fail update.
    try {
      const {
        copyFileSync,
        chmodSync: chmod,
        existsSync: exists,
      } = await import("node:fs");
      const src = `${installDir}/scripts/launcher.sh`;
      const dest = `${home}/.local/bin/polyroot`;
      if (exists(src)) {
        copyFileSync(src, dest);
        chmod(dest, 0o755);
        console.log("\n✅ Launcher refreshed: ~/.local/bin/polyroot");
      }
    } catch (err) {
      console.log(`\n⚠️  Launcher refresh skipped: ${(err as Error).message}`);
    }

    // Auto-migrate (idempotent). On failure keep the manual fallback below.
    let migrateOk = true;
    try {
      console.log("\n🗄️  Running migrations...");
      execSync("npm run migrate:latest", { cwd: installDir, stdio: "inherit" });
    } catch (err) {
      migrateOk = false;
      console.log(`\n⚠️  Auto-migrate skipped: ${(err as Error).message}`);
    }

    // Refresh the 24/7 supervisor unit so `polyroot update` alone delivers
    // unit fixes (paths, entrypoint, restart policy). Best-effort.
    await refreshSupervisorUnit(installDir);

    console.log(
      box("Update complete", [
        migrateOk
          ? "Launcher, build, migrations and supervisor unit refreshed."
          : "Launcher, build and supervisor refreshed. Migrations changed — run: npm run migrate:latest (safe, idempotent)",
      ]),
    );
  } catch (err) {
    console.error("❌ Update failed:", (err as Error).message);
    process.exit(1);
  }
}

/**
 * Re-render + reload the systemd unit after an update, then `try-restart`
 * (restarts only a RUNNING service — never starts a stopped one).
 * Skipped with POLYROOT_NO_SYSTEMD=1. Never throws: update must survive
 * hosts without systemd/root. Exported for tests (SYSTEMD_DIR override).
 */
export async function refreshSupervisorUnit(installDir: string): Promise<{
  refreshed: boolean;
  restarted: boolean;
}> {
  const out = { refreshed: false, restarted: false };
  if (process.env["POLYROOT_NO_SYSTEMD"] === "1") return out;
  const { execSync } = await import("node:child_process");
  const script = `${installDir}/scripts/install-systemd.sh`;
  try {
    const { existsSync } = await import("node:fs");
    if (!existsSync(script)) return out;
    execSync(
      `bash ${JSON.stringify(script)} --home ${JSON.stringify(installDir)} --user ${JSON.stringify(ownerUser())}`,
      {
        // Tests point SYSTEMD_DIR at a temp dir (no sudo/daemon touch).
        env: {
          ...process.env,
          ...(process.env["POLYROOT_SYSTEMD_DIR"]
            ? { SYSTEMD_DIR: process.env["POLYROOT_SYSTEMD_DIR"] as string }
            : {}),
        },
        stdio: "inherit",
      },
    );
    out.refreshed = true;
  } catch (err) {
    console.log(`\n⚠️  Supervisor refresh skipped: ${(err as Error).message}`);
    return out;
  }
  try {
    const show = execSync("systemctl show polyroot --property=LoadState 2>/dev/null", {
      encoding: "utf8",
    });
    // SYSTEMD_DIR override = render-only test mode: never touch real systemd.
    if (!process.env["POLYROOT_SYSTEMD_DIR"] && show.trim() === "LoadState=loaded") {
      execSync("systemctl try-restart polyroot 2>/dev/null", { stdio: "ignore" });
      out.restarted = true;
      console.log("\n✅ Supervisor unit refreshed (service try-restarted if active)");
    } else if (out.refreshed) {
      console.log("\n✅ Supervisor unit refreshed");
    }
  } catch {
    // No systemd / no privileges — update itself already succeeded.
  }
  return out;
}

/** OS user that should own the service (sudo-aware). */
function ownerUser(): string {
  return (
    process.env["SUDO_USER"] ||
    process.env["USER"] ||
    process.env["LOGNAME"] ||
    "root"
  );
}

/** Doctor command - health checks. */
async function runDoctor(): Promise<boolean> {
  console.log(banner("\U0001F3E5 PolyRoot Agent \u2014 Doctor"));
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
  if (!allOk && process.env["POLYROOT_ONBOARDING"] !== "1") process.exit(1);
  return allOk;
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
      readUniverse: async () => resolveMarketUniverse(process.env),
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
  // Sealed keystore first (never requires the raw key on disk), raw key
  // second. Either path must yield a usable 64-hex key.
  let rawKey: string;
  try {
    rawKey = resolveWalletKey(env);
  } catch {
    rawKey = "";
  }
  if (!rawKey) {
    checks.push({
      name: "key-present",
      ok: false,
      detail:
        "no wallet key: set POLYROOT_KEYSTORE_JSON + POLYROOT_KEYSTORE_PASSPHRASE, or PRIVATE_KEY_HEX (or WALLET_PRIVATE_KEY)",
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
  if (argv[0] === "markets") {
    const qIdx = argv.indexOf("--search");
    const query =
      qIdx >= 0 && argv[qIdx + 1] && !argv[qIdx + 1]?.startsWith("--")
        ? (argv[qIdx + 1] as string).toLowerCase()
        : "";
    const lIdx = argv.indexOf("--limit");
    const limRaw = lIdx >= 0 ? Number(argv[lIdx + 1]) : 20;
    const limit =
      Number.isFinite(limRaw) && limRaw > 0
        ? Math.min(Math.floor(limRaw), 50)
        : 20;
    try {
      const all = await fetchActiveMarkets(50);
      const list = query
        ? all.filter((m) => m.question.toLowerCase().includes(query))
        : all;
      for (const m of list.slice(0, limit)) {
        const vol =
          m.volume24h > 0 ? ` (24h vol $${Math.round(m.volume24h)})` : "";
        console.log(`• ${m.question}${vol}`);
        console.log(`  YES ${m.yesTokenId} / NO ${m.noTokenId}`);
      }
      if (list.length === 0) console.log("No markets found.");
    } catch (err) {
      console.error(`❌ ${(err as Error).message}`);
      process.exit(1);
    }
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
  if (argv[0] === "explain") {
    await runExplainCLI(argv.slice(1));
    return;
  }
  if (argv[0] === "halt") {
    await runHaltCLI(argv.slice(1));
    return;
  }
  if (argv[0] === "health") {
    await runHealthCLI(argv.slice(1));
    return;
  }
  if (argv[0] === "insight") {
    await runInsightCLI(argv.slice(1));
    return;
  }
  if (argv[0] === "backup") {
    await runBackupCLI(argv.slice(1));
    return;
  }
  if (argv[0] === "restore") {
    await runRestoreCLI(argv.slice(1));
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
  if (argv[0] === "restart") {
    await runRestartCLI();
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
  if (argv[0] === "mode") {
    await runModeCommand(argv[1]);
    return;
  }
  if (argv[0] === "shadow-fund") {
    const aIdx = argv.indexOf("--amount");
    const amountRaw =
      aIdx >= 0 && argv[aIdx + 1] && !argv[aIdx + 1]?.startsWith("--")
        ? (argv[aIdx + 1] as string)
        : "";
    if (!amountRaw) {
      console.error("Usage: polyroot shadow-fund --amount <usd>");
      process.exit(1);
    }
    await runShadowFund(amountRaw);
    return;
  }

  // Bare `polyroot` opens the interactive console (Hermes-style).
  if (argv.length === 0) {
    await runFirstTimeSetup();
    await runConsole();
    return;
  }

  // Explicit `polyroot run` starts the trading loop (old bare behavior).
  if (argv[0] === "run" || argv[0] === "start") {
    await runFirstTimeSetup();
    const runConfig = parseArgs(argv.slice(1));
    assertRuntimeEnv(runConfig.mode);
    if (runConfig.mode === "MICRO_LIVE") {
      await assertMicroLiveReady(runConfig.databaseUrl);
    }
    await startAgent(runConfig);
    return;
  }

  // First-run onboarding (skip for subcommands)
  if (
    argv[0] !== "wallet" &&
    argv[0] !== "venue" &&
    argv[0] !== "markets" &&
    argv[0] !== "guard" &&
    argv[0] !== "status" &&
    argv[0] !== "explain" &&
    argv[0] !== "halt" &&
    argv[0] !== "health" &&
    argv[0] !== "insight" &&
    argv[0] !== "backup" &&
    argv[0] !== "restore" &&
    argv[0] !== "update" &&
    argv[0] !== "doctor" &&
    argv[0] !== "docker-fix" &&
    argv[0] !== "restart" &&
    argv[0] !== "onboard" &&
    argv[0] !== "setup" &&
    argv[0] !== "shadow-fund"
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
