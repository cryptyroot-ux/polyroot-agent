/**
 * @polyroot/runtime — Telegram onboarding wizard (`/onboard`).
 *
 * Full first-time setup over chat for operators who struggle with the
 * terminal. HARD RULE (shared with every Telegram handler): secrets NEVER
 * transit chat — no API keys, no private keys, no passphrases. The wizard
 * therefore:
 *   - records key-needing provider choices and tells the operator the exact
 *     terminal one-liner to finish them,
 *   - creates wallets server-side (needs a vault passphrase already stored
 *     via terminal `polyroot telegram setup`),
 *   - collects only non-secret answers (choices, caps, wallet ADDRESSES).
 *
 * Pure state machine (onboardNext) + thin persistence (applyOnboardWrites).
 * No network inside the machine: curated model lists only (`/model` stays
 * the live-catalog switcher). Per-user state with TTL; restarts only cancel.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { upsertEnvLines } from "./setup-guide.js";
import { AUTONOMY_BOUNDS, resolveLossCapPusd } from "./autonomy-bounds.js";

export type OnboardStep =
  | "provider"
  | "model"
  | "baseurl"
  | "wallet"
  | "wallet_confirm"
  | "mode"
  | "mode_confirm"
  | "account"
  | "funder"
  | "capital"
  | "loss"
  | "done"
  | "aborted";

export interface OnboardState {
  step: OnboardStep;
  provider?: string;
  forecastProvider?: string;
  baseUrl?: string;
  model?: string;
  needsTerminalKey?: boolean;
  walletAction?: "create" | "keep" | "later";
  newSignerAddress?: string;
  mode?: "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE";
  account?: string;
  funder?: string;
  capitalUsd?: number;
  lossBps?: number;
  startedAt: number;
}

export interface OnboardFacts {
  /** Vault passphrase already stored (terminal setup). */
  passphraseSet: boolean;
  /** Current signer address, when a wallet already exists. */
  signerAddress?: string;
  /** ChatGPT login detected for the codex provider. */
  codexReady: boolean;
  now?: number;
}

export interface OnboardTurn {
  state: OnboardState;
  reply: string;
  /** .env writes to persist when this turn completes a fact. */
  writes: Array<[string, string]>;
}

export const ONBOARD_TTL_MS = 30 * 60_000;

const CURATED_MODELS: Record<string, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4o"],
  codex: ["gpt-5.2", "gpt-5.1", "gpt-5-mini"],
  ollama: ["llama3.1", "qwen2.5:7b"],
};

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function abortReply(): string {
  return "Dibatalkan. Ketik /onboard kapan saja untuk mulai lagi dari awal.";
}

function numbered(items: string[]): string {
  return items.map((t, i) => `${i + 1}. ${t}`).join("\n");
}

function pickIndex(text: string, n: number): number | null {
  const t = text.trim().toLowerCase();
  const asNum = Number.parseInt(t, 10);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= n) return asNum - 1;
  return null;
}

function providerMenu(facts: OnboardFacts): string {
  return (
    "🧠 Langkah 1: Otak AI (yang membaca pasar)\n" +
    numbered([
      `OpenAI API (butuh API key — dicatat, key diisi via terminal)`,
      `ChatGPT login / Codex ${facts.codexReady ? "(terdeteksi ✅)" : "(BELUM login — `codex login` dulu di server)"}`,
      `Ollama lokal (tanpa key — butuh daemon Ollama di server)`,
      `Gateway custom OpenAI-compatible (catat URL+model, key via terminal)`,
    ]) +
    "\nBalas: nomor (1-4), atau `batal`."
  );
}

/**
 * One wizard turn. Pure: no I/O, no network, no secrets in or out.
 * Wallet creation itself happens in the handler (needs crypto + fs);
 * the machine only reaches wallet_confirm and consumes the result via
 * `createdAddress` on the confirming turn.
 */
export function onboardNext(
  state: OnboardState,
  text: string,
  facts: OnboardFacts,
  createdAddress?: string,
): OnboardTurn {
  const now = facts.now ?? Date.now();
  const writes: Array<[string, string]> = [];
  const t = text.trim();
  if (t.toLowerCase() === "batal") {
    return {
      state: { ...state, step: "aborted", startedAt: state.startedAt },
      reply: abortReply(),
      writes,
    };
  }
  if (now - state.startedAt > ONBOARD_TTL_MS) {
    return {
      state: { step: "provider", startedAt: now },
      reply:
        "Sesi onboarding kedaluwarsa (30 mnt) — mulai lagi dari awal.\n\n" +
        providerMenu(facts),
      writes,
    };
  }

  switch (state.step) {
    case "provider": {
      const idx = pickIndex(t, 4);
      if (idx === null) {
        return {
          state,
          reply: "Pilih 1-4 ya.\n\n" + providerMenu(facts),
          writes,
        };
      }
      if (idx === 0) {
        const ns: OnboardState = {
          ...state,
          step: "model",
          provider: "openai",
          forecastProvider: "openai",
          needsTerminalKey: true,
        };
        return {
          state: ns,
          reply:
            "Model OpenAI mana?\n" +
            numbered(CURATED_MODELS["openai"] as string[]) +
            "\nBalas: nomor, atau ketik nama model persis.",
          writes,
        };
      }
      if (idx === 1) {
        if (!facts.codexReady) {
          return {
            state,
            reply:
              "ChatGPT login belum terdeteksi di server.\n" +
              "Jalankan di server: `codex login` (browser) atau `codex login --device-auth` (headless),\n" +
              "lalu pilih 2 lagi — atau pilih provider lain sekarang.",
            writes,
          };
        }
        const ns: OnboardState = {
          ...state,
          step: "model",
          provider: "codex",
          forecastProvider: "codex",
        };
        return {
          state: ns,
          reply:
            "Model Codex mana?\n" +
            numbered(CURATED_MODELS["codex"] as string[]) +
            "\nBalas: nomor, atau ketik nama model persis.",
          writes,
        };
      }
      if (idx === 2) {
        const ns: OnboardState = {
          ...state,
          step: "model",
          provider: "ollama",
          forecastProvider: "openai",
          baseUrl: "http://localhost:11434/v1",
        };
        return {
          state: ns,
          reply:
            "Model Ollama mana? (pastikan `ollama serve` + model ter-pull di server)\n" +
            numbered(CURATED_MODELS["ollama"] as string[]) +
            "\nBalas: nomor, atau ketik nama model persis.",
          writes,
        };
      }
      const ns: OnboardState = {
        ...state,
        step: "baseurl",
        provider: "custom",
        forecastProvider: "openai",
        needsTerminalKey: true,
      };
      return {
        state: ns,
        reply:
          "Tempel base URL gateway kamu (contoh: https://gateway.contoh/v1).\n" +
          "API key-nya TIDAK di sini — isi via terminal nanti.",
        writes,
      };
    }

    case "baseurl": {
      if (!/^https?:\/\/.+/.test(t)) {
        return {
          state,
          reply:
            "Itu belum seperti alamat web (harus mulai http:// atau https://). Coba lagi.",
          writes,
        };
      }
      const ns: OnboardState = { ...state, step: "model", baseUrl: t };
      return {
        state: ns,
        reply:
          "Nama model di gateway itu apa? (ketik persis, contoh: gpt-4o-mini)",
        writes,
      };
    }

    case "model": {
      const list =
        state.provider === "custom"
          ? null
          : (CURATED_MODELS[state.provider ?? ""] ?? null);
      let chosen = "";
      if (list) {
        const idx = pickIndex(t, list.length);
        if (idx !== null) chosen = list[idx] as string;
        else if (t.length > 0 && t.length < 120) chosen = t;
      } else if (t.length > 0 && t.length < 120) {
        chosen = t;
      }
      if (!chosen) {
        return {
          state,
          reply: "Pilih nomor yang ada, atau ketik nama model.",
          writes,
        };
      }
      const ns: OnboardState = { ...state, step: "wallet", model: chosen };
      if (state.forecastProvider) {
        writes.push(["POLYROOT_FORECAST_PROVIDER", state.forecastProvider]);
      }
      writes.push(["POLYROOT_FORECAST_MODEL", chosen]);
      if (state.baseUrl) writes.push(["OPENAI_BASE_URL", state.baseUrl]);
      let extra =
        "\n\n🔐 Langkah 2: Wallet (tempat key berada — tetap di server)";
      if (state.needsTerminalKey) {
        extra +=
          "\nCatatan: API key provider diisi via terminal nanti — wizard lanjut tanpa key.";
      }
      return {
        state: ns,
        reply:
          "Model tersimpan." +
          extra +
          "\n" +
          numbered([
            "Buatkan wallet baru (server-side, tanpa kirim key)",
            "Pakai wallet yang sudah ada di server",
            "Nanti saja via terminal",
          ]) +
          "\nBalas: nomor (1-3).",
        writes,
      };
    }

    case "wallet": {
      const idx = pickIndex(t, 3);
      if (idx === null) {
        return { state, reply: "Pilih 1-3 ya.", writes };
      }
      if (idx === 1) {
        const ns: OnboardState = {
          ...state,
          step: "mode",
          walletAction: "keep",
        };
        return { state: ns, reply: modeMenu(), writes };
      }
      if (idx === 2) {
        const ns: OnboardState = {
          ...state,
          step: "mode",
          walletAction: "later",
        };
        return {
          state: ns,
          reply:
            "Siap — wallet diisi nanti via terminal (`polyroot`).\n\n" +
            modeMenu(),
          writes,
        };
      }
      if (!facts.passphraseSet) {
        return {
          state,
          reply:
            "Untuk buat wallet dari Telegram, passphrase vault harus sudah ada.\n" +
            "Jalankan SEKALI di server: `polyroot telegram setup` (minta passphrase, aman di terminal),\n" +
            "lalu pilih 1 lagi — atau pilih 2/3 untuk lanjut tanpa buat wallet.",
          writes,
        };
      }
      const cur = facts.signerAddress
        ? `\n• Signer sekarang: \`${facts.signerAddress}\` (akan diganti)`
        : "";
      const ns: OnboardState = { ...state, step: "wallet_confirm" };
      return {
        state: ns,
        reply:
          "⚠️ Buat wallet signer BARU?" +
          cur +
          "\n• Private key TIDAK akan ditampilkan di chat.\n" +
          "Balas YA untuk buat, atau `batal`.",
        writes,
      };
    }

    case "wallet_confirm": {
      if (t.toLowerCase() !== "ya") {
        const ns: OnboardState = { ...state, step: "wallet" };
        return {
          state: ns,
          reply:
            "Oke, wallet tidak dibuat.\n" +
            numbered([
              "Buatkan wallet baru (server-side, tanpa kirim key)",
              "Pakai wallet yang sudah ada di server",
              "Nanti saja via terminal",
            ]),
          writes,
        };
      }
      if (!createdAddress) {
        return {
          state,
          reply:
            "Gagal teknis membuat wallet — coba pilih 1 lagi, atau lanjut via terminal.",
          writes,
        };
      }
      const ns: OnboardState = {
        ...state,
        step: "mode",
        walletAction: "create",
        newSignerAddress: createdAddress,
      };
      return {
        state: ns,
        reply:
          `✅ Wallet dibuat! Alamat: \`${createdAddress}\`\n` +
          "Backup keystore + passphrase dari terminal server.\n\n" +
          modeMenu(),
        writes,
      };
    }

    case "mode": {
      const idx = pickIndex(t, 4);
      if (idx === null) {
        return { state, reply: "Pilih 1-4 ya.\n\n" + modeMenu(), writes };
      }
      const modes = ["SHADOW", "PAPER", "MICRO_LIVE", "LIVE"] as const;
      const mode = modes[idx] as NonNullable<OnboardState["mode"]>;
      if (mode === "SHADOW" || mode === "PAPER") {
        const ns: OnboardState = {
          ...state,
          step: "capital",
          mode,
        };
        writes.push(["RUNTIME_MODE", mode]);
        return {
          state: ns,
          reply:
            `Mode ${mode} dipilih ($0 risiko). ✅\n` +
            `Batas modal USD? (default ${AUTONOMY_BOUNDS.CAPITAL_CAP_USD}; SHADOW/PAPER tetap catat walau tak enforce)`,
          writes,
        };
      }
      const ns: OnboardState = { ...state, step: "mode_confirm", mode };
      return {
        state: ns,
        reply:
          `⚠️ ${mode} memakai UANG ASLI. Loss cap harian mematikan sistem otomatis.\n` +
          `Ketik persis \`${mode}\` untuk lanjut (apapun selain itu = batal ke SHADOW).`,
        writes,
      };
    }

    case "mode_confirm": {
      const want = state.mode ?? "MICRO_LIVE";
      if (t !== want) {
        const ns: OnboardState = { ...state, step: "capital", mode: "SHADOW" };
        writes.push(["RUNTIME_MODE", "SHADOW"]);
        return {
          state: ns,
          reply:
            "Oke, bertahan di SHADOW (aman).\n" +
            `Batas modal USD? (default ${AUTONOMY_BOUNDS.CAPITAL_CAP_USD})`,
          writes,
        };
      }
      const ns: OnboardState = { ...state, step: "account", mode: want };
      writes.push(["RUNTIME_MODE", want]);
      const signerLine = facts.signerAddress ?? state.newSignerAddress;
      return {
        state: ns,
        reply:
          `Mode ${want} dikunci. 🔐 WAL-03: butuh 3 alamat berbeda.` +
          (signerLine ? `\nSigner: \`${signerLine}\`` : "") +
          "\nAlamat Account (0x... 40 hex, beda dari Signer)?",
        writes,
      };
    }

    case "account": {
      if (!ADDR_RE.test(t)) {
        return {
          state,
          reply: "Format salah — 0x + 40 hex. Coba lagi, atau `batal`.",
          writes,
        };
      }
      const signer = facts.signerAddress ?? state.newSignerAddress;
      if (signer && t.toLowerCase() === signer.toLowerCase()) {
        return {
          state,
          reply: "Account harus beda dari Signer. Coba lagi.",
          writes,
        };
      }
      const ns: OnboardState = { ...state, step: "funder", account: t };
      writes.push(["WALLET_ACCOUNT", t]);
      return {
        state: ns,
        reply: "Alamat Funder (0x... beda dari Signer DAN Account)?",
        writes,
      };
    }

    case "funder": {
      if (!ADDR_RE.test(t)) {
        return {
          state,
          reply: "Format salah — 0x + 40 hex. Coba lagi, atau `batal`.",
          writes,
        };
      }
      const signer = facts.signerAddress ?? state.newSignerAddress;
      if (
        (signer && t.toLowerCase() === signer.toLowerCase()) ||
        (state.account && t.toLowerCase() === state.account.toLowerCase())
      ) {
        return {
          state,
          reply: "Funder harus beda dari Signer dan Account. Coba lagi.",
          writes,
        };
      }
      const ns: OnboardState = {
        ...state,
        step: "capital",
        funder: t,
      };
      writes.push(["WALLET_FUNDER", t]);
      return {
        state: ns,
        reply: `Batas modal USD? (default ${AUTONOMY_BOUNDS.CAPITAL_CAP_USD})`,
        writes,
      };
    }

    case "capital": {
      const n = Number(t);
      const capital =
        t.trim() === ""
          ? AUTONOMY_BOUNDS.CAPITAL_CAP_USD
          : Number.isFinite(n) && n > 0
            ? n
            : 0;
      if (!capital) {
        return {
          state,
          reply: "Harus angka > 0, atau kosongkan untuk default.",
          writes,
        };
      }
      const ns: OnboardState = { ...state, step: "loss", capitalUsd: capital };
      writes.push(["POLYROOT_MICRO_LIVE_CAP_USD", String(capital)]);
      return {
        state: ns,
        reply: `Daily loss cap (bps, 500 = 5%; default ${AUTONOMY_BOUNDS.DAILY_LOSS_CAP_BPS})?`,
        writes,
      };
    }

    case "loss": {
      const n = Number(t);
      const bps =
        t.trim() === ""
          ? AUTONOMY_BOUNDS.DAILY_LOSS_CAP_BPS
          : Number.isFinite(n) && n > 0
            ? n
            : 0;
      if (!bps) {
        return {
          state,
          reply: "Harus angka > 0, atau kosongkan untuk default.",
          writes,
        };
      }
      const capital = state.capitalUsd ?? AUTONOMY_BOUNDS.CAPITAL_CAP_USD;
      const lossUsd = resolveLossCapPusd(capital, bps) ?? 0;
      writes.push(["POLYROOT_MICRO_LIVE_LOSS_CAP_USD", String(lossUsd)]);
      const keyNote = state.needsTerminalKey
        ? "\n• ⏳ API key provider: isi via terminal — `OPENAI_API_KEY=...` ke ~/.polyroot/.env"
        : "";
      const ns: OnboardState = { ...state, step: "done", lossBps: bps };
      return {
        state: ns,
        reply:
          "✅ Setup selesai! Ringkasan:\n" +
          `• Provider: ${state.provider} → model ${state.model}${keyNote}\n` +
          `• Mode: ${state.mode}, modal $${capital}, stop-loss $${lossUsd}/hari\n` +
          "Lanjut: `/status` cek service, `polyroot doctor` di server untuk validasi penuh." +
          (state.mode === "MICRO_LIVE" || state.mode === "LIVE"
            ? " Untuk LIVE penuh masih perlu `polyroot live-promote` (owner sign-off)."
            : ""),
        writes,
      };
    }

    case "done":
    case "aborted":
    default:
      return {
        state: { step: "provider", startedAt: now },
        reply: providerMenu(facts),
        writes,
      };
  }
}

function modeMenu(): string {
  return (
    "🚀 Langkah 3: Mode\n" +
    "PAPER = simulasi mock, $0. SHADOW = data live + fill simulasi, $0 (disarankan).\n" +
    "MICRO_LIVE/LIVE = uang asli (butuh API key + 3 alamat + loss cap).\n" +
    numbered([
      "SHADOW — live data, sim fills, $0 (disarankan)",
      "PAPER — simulasi mock, $0",
      "MICRO_LIVE — uang asli kecil",
      "LIVE — trading asli",
    ]) +
    "\nBalas: nomor (1-4)."
  );
}

/* ─── sealed signer minting (shared with /wallet create) ───────────────── */

import { randomBytes } from "node:crypto";
import { deriveAddressFromPrivateKey, sealPrivateKey } from "@polyroot/signer";

export interface MintedSigner {
  privateKey: string;
  address: string;
  keystoreJson: string;
}

/**
 * Generate + seal a fresh signer. Returns key material to the CALLER ONLY
 * (server memory) — callers must persist the keystore and must NEVER put
 * the private key into chat text (router redacts + refuses secrets anyway).
 */
export function mintSealedSigner(passphrase: string): MintedSigner {
  const privateKey = "0x" + randomBytes(32).toString("hex");
  const address = deriveAddressFromPrivateKey(privateKey);
  const keystoreJson = JSON.stringify(sealPrivateKey(privateKey, passphrase));
  return { privateKey, address, keystoreJson };
}

export function onboardIntro(facts: OnboardFacts): string {
  return (
    "👋 Selamat datang di PolyRoot Agent!\n" +
    "Setup 3 langkah via chat (tanpa secret — key/API key tetap via terminal).\n\n" +
    providerMenu(facts)
  );
}

/* ─── persistence (HOME-fresh paths, test-redirectable) ─────────────────── */

export function onboardPaths(): { home: string; envPath: string } {
  const home = process.env["HOME"]
    ? `${process.env["HOME"]}/.polyroot`
    : "/tmp/.polyroot";
  return { home, envPath: `${home}/.env` };
}

export function applyOnboardWrites(writes: Array<[string, string]>): void {
  if (writes.length === 0) return;
  const { home, envPath } = onboardPaths();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  writeFileSync(
    envPath,
    upsertEnvLines(
      existing,
      writes.map(([k, v]) => `${k}=${v}`),
    ) + "\n",
    { mode: 0o600 },
  );
}

/* ─── per-user session registry ─────────────────────────────────────────── */

const sessions = new Map<string, OnboardState>();

export function onboardSessionGet(
  userId: string,
  now = Date.now(),
): OnboardState | null {
  const s = sessions.get(userId);
  if (!s) return null;
  if (now - s.startedAt > ONBOARD_TTL_MS) {
    sessions.delete(userId);
    return null;
  }
  return s;
}

export function onboardSessionSet(userId: string, state: OnboardState): void {
  if (state.step === "done" || state.step === "aborted") {
    sessions.delete(userId);
    return;
  }
  sessions.set(userId, state);
}

export function onboardSessionReset(
  userId: string,
  now = Date.now(),
): OnboardState {
  const fresh: OnboardState = { step: "provider", startedAt: now };
  sessions.set(userId, fresh);
  return fresh;
}
