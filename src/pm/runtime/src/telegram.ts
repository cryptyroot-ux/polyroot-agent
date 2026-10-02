/**
 * @polyroot/runtime — Telegram transport (read-first remote control).
 *
 * Long-polling Bot API over native fetch (zero new dependencies), DM-only,
 * owner-gated, audited. Design rules, all load-bearing:
 *
 * 1. DM ONLY — group/supergroup/channel traffic is silently dropped.
 *    A trading bot must never be triggerable by a room full of strangers.
 * 2. NUMERIC IDS ONLY — Telegram usernames are mutable/recyclable
 *    (CVE-2026-28480 class). Pairing + allowlist match digits or nothing.
 * 3. READ-FIRST TIERS — read commands run free; state-changing commands
 *    need an in-chat YES; money-escalating actions (mode up, secrets,
 *    key handling) are refused outright with terminal instructions.
 * 4. NO SECRETS IN CHAT — inbound text matching key patterns is refused;
 *    every outbound message passes redactSecrets() (keys, tokens, hex
 *    secrets never leave in echoes or error dumps).
 * 5. STALE COMMANDS DIE — pending updates are dropped on boot (a queued
 *    "halt" from yesterday must never execute today); confirmations
 *    expire in 5 minutes.
 * 6. FAIL-OPEN TRANSPORT, FAIL-CLOSED TRADING — a dead Telegram layer
 *    never blocks the loop; every trading gate stays enforced.
 */

import { createHash, randomBytes } from "node:crypto";

export const TELEGRAM_API = "https://api.telegram.org";
const PAIRING_CODE_TTL_MS = 60 * 60_1000;
const CONFIRM_TTL_MS = 5 * 60_1000;
const RATE_LIMIT_PER_MIN = 20;
const MAX_OUT_CHARS = 4000;

/* ─── secrets ─────────────────────────────────────────────────────── */

const SECRET_PATTERNS: RegExp[] = [
  /0x[0-9a-fA-F]{64}/, // private keys
  /sk-[A-Za-z0-9_-]{8,}/, // API keys
  /xox[bap]-[A-Za-z0-9-]+/, // slack-style tokens (defense in depth)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM blocks
  /["']?(?:api[_-]?key|secret|passphrase|mnemonic)["']?\s*[:=]\s*\S+/i,
];

/** True when inbound text looks like credential material — refuse it. */
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/** Scrub secrets from ANY outbound text (echoes, errors, dumps). */
export function redactSecrets(text: string): string {
  let out = text;
  out = out.replace(/0x[0-9a-fA-F]{64}/g, "0x…[redacted]");
  out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-…[redacted]");
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[redacted-block]",
  );
  out = out.replace(
    /(["']?(?:api[_-]?key|secret|passphrase|mnemonic)["']?\s*[:=]\s*)\S+/gi,
    "$1[redacted]",
  );
  return out;
}

/* ─── identities ──────────────────────────────────────────────────── */

/** Numeric Telegram user id or null (usernames NEVER accepted). */
export function normalizeTelegramId(raw: unknown): string | null {
  const s = String(raw ?? "")
    .trim()
    .replace(/^(tg:|telegram:)/i, "");
  return /^\d{1,20}$/.test(s) ? s : null;
}

/* ─── pairing codes ───────────────────────────────────────────────── */

const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 8-char code from an unambiguous alphabet (no 0/O/1/I). */
export function makePairingCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (const b of bytes)
    code += PAIR_ALPHABET[(b as number) % PAIR_ALPHABET.length];
  return code;
}

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(`polyroot-pair|${code}`).digest("hex");
}

/* ─── rate limit (memory, per user) ───────────────────────────────── */

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly perMinute: number = RATE_LIMIT_PER_MIN) {}

  allow(key: string, nowMs = Date.now()): boolean {
    const window = nowMs - 60_000;
    const list = (this.hits.get(key) ?? []).filter((t) => t > window);
    if (list.length >= this.perMinute) {
      this.hits.set(key, list);
      return false;
    }
    list.push(nowMs);
    this.hits.set(key, list);
    return true;
  }
}

/* ─── minimal pool surface (pg Pool satisfies it) ─────────────────── */

export interface TelegramPool {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/* ─── pairing store ───────────────────────────────────────────────── */

export async function requestPairing(
  pool: TelegramPool,
  userId: string,
  username: string,
  nowMs = Date.now(),
): Promise<{ code: string; deduped: boolean }> {
  const existing = await pool.query(
    `SELECT code_hash FROM telegram_pairing
      WHERE user_id = $1 AND status = 'pending' AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (existing.rows.length > 0) {
    // One live code per stranger: re-issuing spams new codes every message.
    // Return no code; the caller tells them to check the earlier DM.
    return { code: "", deduped: true };
  }
  // Cap pending backlog (abuse brake).
  const pending = await pool.query(
    `SELECT COUNT(*)::int AS c FROM telegram_pairing WHERE status = 'pending'`,
  );
  if (Number((pending.rows[0] as { c?: unknown } | undefined)?.c ?? 0) >= 50) {
    throw new Error("pairing backlog full — operator must clear it first");
  }
  const code = makePairingCode();
  await pool.query(
    `INSERT INTO telegram_pairing (user_id, username, code_hash, status, expires_at)
     VALUES ($1, $2, $3, 'pending', $4)`,
    [
      userId,
      username.slice(0, 64),
      hashPairingCode(code),
      new Date(nowMs + PAIRING_CODE_TTL_MS).toISOString(),
    ],
  );
  return { code, deduped: false };
}

export async function approvePairing(
  pool: TelegramPool,
  code: string,
): Promise<{ userId: string; username: string } | null> {
  const res = await pool.query(
    `UPDATE telegram_pairing SET status = 'approved'
      WHERE code_hash = $1 AND status = 'pending' AND expires_at > now()
      RETURNING user_id, username`,
    [hashPairingCode(code.trim().toUpperCase())],
  );
  const row = res.rows[0] as
    { user_id?: unknown; username?: unknown } | undefined;
  if (!row || typeof row["user_id"] !== "string") return null;
  const userId = row["user_id"] as string;
  await pool.query(
    `INSERT INTO telegram_allowlist (user_id, username) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username`,
    [userId, typeof row["username"] === "string" ? row["username"] : ""],
  );
  return {
    userId,
    username: typeof row["username"] === "string" ? row["username"] : "",
  };
}

export async function listPendingPairings(
  pool: TelegramPool,
): Promise<Array<{ userId: string; username: string; expiresAt: string }>> {
  const res = await pool.query(
    `SELECT user_id, username, expires_at FROM telegram_pairing
      WHERE status = 'pending' AND expires_at > now()
      ORDER BY created_at DESC`,
  );
  return res.rows.map((r) => ({
    userId: String(r["user_id"] ?? ""),
    username: String(r["username"] ?? ""),
    expiresAt: String(r["expires_at"] ?? ""),
  }));
}

export async function revokeUser(
  pool: TelegramPool,
  userId: string,
): Promise<boolean> {
  await pool.query(`DELETE FROM telegram_allowlist WHERE user_id = $1`, [
    userId,
  ]);
  const res = await pool.query(
    `UPDATE telegram_pairing SET status = 'revoked'
      WHERE user_id = $1 AND status IN ('pending', 'approved')`,
    [userId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function allowUserDirect(
  pool: TelegramPool,
  userId: string,
  username = "",
): Promise<void> {
  await pool.query(
    `INSERT INTO telegram_allowlist (user_id, username) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username`,
    [userId, username.slice(0, 64)],
  );
}

export async function isAllowed(
  pool: TelegramPool,
  userId: string,
  staticOwners: string[],
): Promise<boolean> {
  if (staticOwners.includes(userId)) return true;
  try {
    const res = await pool.query(
      `SELECT 1 FROM telegram_allowlist WHERE user_id = $1`,
      [userId],
    );
    return res.rows.length > 0;
  } catch {
    // Fail-closed on DB trouble for authz: deny (trading unaffected).
    // Static owners above already passed, so this only gates pairing adds.
    return false;
  }
}

export async function auditCommand(
  pool: TelegramPool,
  userId: string,
  command: string,
  argsRedacted: string,
  result: string,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO telegram_audit (user_id, command, args_redacted, result)
       VALUES ($1, $2, $3, $4)`,
      [
        userId,
        command.slice(0, 64),
        argsRedacted.slice(0, 500),
        result.slice(0, 500),
      ],
    );
  } catch {
    // audit must never break command handling
  }
}

/* ─── Bot API client (native fetch, zero new dependencies) ────────── */

export interface BotApi {
  call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}

export function createBotApi(
  token: string,
  apiBase = TELEGRAM_API,
  timeoutMs = 30_000,
  fetchImpl: typeof fetch = fetch,
): BotApi {
  return {
    async call<T>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(
          `${apiBase.replace(/\/+$/, "")}/bot${token}/${method}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(params),
            signal: ctrl.signal,
          },
        );
        const data = (await res.json()) as {
          ok?: boolean;
          result?: T;
          description?: string;
        };
        if (!res.ok || data.ok !== true) {
          throw new Error(
            `Telegram API ${method} failed: ${data.description ?? `HTTP ${res.status}`}`,
          );
        }
        return data.result as T;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function chunkMessage(text: string, limit = MAX_OUT_CHARS): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  const pushLine = (line: string): void => {
    // Single overlong lines (AI rationale blobs) split hard mid-word.
    for (let i = 0; i < line.length; i += limit) {
      parts.push(line.slice(i, i + limit));
    }
  };
  const lines = text.split("\n");
  let cur = "";
  for (const line of lines) {
    if (line.length > limit) {
      if (cur) {
        parts.push(cur);
        cur = "";
      }
      pushLine(line);
      continue;
    }
    if ((cur + "\n" + line).length > limit && cur) {
      parts.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) parts.push(cur);
  return parts.length > 0 ? parts : [text.slice(0, limit)];
}

export async function sendReply(
  api: BotApi,
  chatId: number | string,
  text: string,
): Promise<void> {
  for (const part of chunkMessage(redactSecrets(text))) {
    await api.call("sendMessage", { chat_id: chatId, text: part });
  }
}

/* ─── command tiers ───────────────────────────────────────────────── */

export type CommandTier = "read" | "confirm" | "forbidden";

/** Explicitly refused with terminal instructions (never silently unknown). */
export const FORBIDDEN_COMMANDS = new Set([
  "setup",
  "guard",
  "run",
  "start",
  "backup",
  "restore",
  "shadow-fund",
  "seal",
]);

export interface PendingConfirm {
  command: string;
  args: string[];
  expiresAtMs: number;
}

/** In-memory confirmation + rate state (per process; restarts clear it — safe). */
export class TelegramSession {
  readonly limiter = new RateLimiter();
  private readonly pending = new Map<string, PendingConfirm>();

  requestConfirm(
    userId: string,
    command: string,
    args: string[],
    nowMs = Date.now(),
  ): void {
    this.pending.set(userId, {
      command,
      args,
      expiresAtMs: nowMs + CONFIRM_TTL_MS,
    });
  }

  /** Consume a YES for this user (single-use, expiring). */
  takeConfirm(
    userId: string,
    text: string,
    nowMs = Date.now(),
  ): PendingConfirm | null {
    const p = this.pending.get(userId);
    if (!p) return null;
    this.pending.delete(userId);
    if (nowMs > p.expiresAtMs) return null;
    const t = text.trim().toLowerCase();
    if (t === "ya" || t === "yes" || t === "y") return p;
    return null;
  }

  clearConfirm(userId: string): void {
    this.pending.delete(userId);
  }
}

export type TelegramUpdate = {
  update_id?: number;
  message?: {
    message_id?: number;
    from?: { id?: number; username?: string; first_name?: string };
    chat?: { id?: number; type?: string };
    text?: string;
  };
};

export function parseTelegramText(raw: string): {
  command: string;
  args: string[];
} {
  const text = raw.trim().replace(/^\//, "");
  const parts = text.split(/\s+/).filter(Boolean);
  const [command = "", ...args] = parts;
  // Strip @botname suffix (group-style /cmd@bot) — DMs only anyway.
  return { command: command.toLowerCase().replace(/@.+$/, ""), args };
}

/**
 * Run an existing console-style handler (which prints) and capture its
 * output as text for chat delivery. Sequential event loop makes the
 * temporary console patch safe; always restored.
 */
export async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const orig = {
    log: console.log,
    error: console.error,
    warn: console.warn,
  };
  let out = "";
  const push = (...a: unknown[]): void => {
    out += `${a.map((x) => String(x)).join(" ")}\n`;
  };
  console.log = push as never;
  console.error = push as never;
  console.warn = push as never;
  try {
    await fn();
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
  }
  return out.trimEnd() || "(tidak ada output)";
}

/* ─── setup wizard helpers (pure, unit-tested) ─────────────────────── */

/** BotFather token shape: digits, colon, 35+ secret chars. */
export function isValidBotTokenFormat(token: string): boolean {
  return /^\d+:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}

/**
 * Owner auto-detect: first human sender in fresh updates (Hermes-style —
 * the operator just DMs the bot "halo" instead of looking up numeric IDs).
 * Bots' own messages and non-message updates are skipped. Null = nobody
 * new yet (caller keeps waiting or falls back to manual entry).
 */
export function detectOwnerFromUpdates(
  updates: TelegramUpdate[],
): { userId: string; username: string } | null {
  for (const u of updates) {
    const m = extractInbound(u);
    if (!m) continue;
    if (m.chatType !== "private") continue;
    if (/bot$/i.test(m.username)) continue;
    return { userId: m.userId, username: m.username || "(tanpa nama)" };
  }
  return null;
}

export interface InboundMessage {
  updateId: number;
  chatId: number;
  chatType: string;
  userId: string;
  username: string;
  text: string;
}

export function extractInbound(update: TelegramUpdate): InboundMessage | null {
  const m = update.message;
  if (!m || typeof m.text !== "string") return null;
  const chatId = m.chat?.id;
  const userId = m.from?.id;
  if (chatId === undefined || userId === undefined) return null;
  const username =
    typeof m.from?.username === "string"
      ? m.from.username
      : typeof m.from?.first_name === "string"
        ? m.from.first_name
        : "";
  return {
    updateId: typeof update.update_id === "number" ? update.update_id : 0,
    chatId,
    chatType: m.chat?.type ?? "private",
    userId: String(userId),
    username,
    text: m.text,
  };
}

export type CommandHandler = (
  args: string[],
  ctx: { userId: string; username: string },
) => Promise<string | string[]>;

export interface RouterDeps {
  pool: TelegramPool;
  staticOwners: string[];
  session: TelegramSession;
  /** Concrete command implementations (injected by cli.ts). */
  handlers: Record<string, CommandHandler>;
  readCommands: Set<string>;
  confirmCommands: Set<string>;
  onDenied?: (userId: string, reason: string) => void;
}

export interface RouteResult {
  replies: string[];
  /** offset to ack (always ack processed updates to avoid replays) */
  ackUpdateId: number;
}

/**
 * Route one inbound message. Returns replies (already redacted by
 * sendReply, but redacted here too for defense in depth).
 */
export async function routeTelegramMessage(
  deps: RouterDeps,
  msg: InboundMessage,
): Promise<RouteResult> {
  const ack = { replies: [] as string[], ackUpdateId: msg.updateId };
  // Rule 1: DMs only. Groups/channels die silently (no existence signal).
  if (msg.chatType !== "private") return ack;
  if (!deps.session.limiter.allow(msg.userId)) {
    await auditCommand(
      deps.pool,
      msg.userId,
      "<rate>",
      "",
      "denied:rate-limit",
    );
    return { ...ack, replies: ["Terlalu cepat — coba lagi sebentar lagi."] };
  }
  const allowed = await isAllowed(deps.pool, msg.userId, deps.staticOwners);
  const { command, args } = parseTelegramText(msg.text);
  if (!command) return ack;

  // Confirmation replies (YA) resolve a pending action first.
  if (command === "ya" || command === "yes" || command === "y") {
    if (!allowed) {
      await auditCommand(
        deps.pool,
        msg.userId,
        "ya",
        "",
        "denied:unknown-user",
      );
      return { ...ack, replies: [unknownUserReply(msg.userId)] };
    }
    const pending = deps.session.takeConfirm(msg.userId, command);
    if (!pending) {
      return { ...ack, replies: ["Tidak ada aksi menunggu konfirmasi."] };
    }
    return runHandler(deps, msg, pending.command, pending.args, "confirmed");
  }
  deps.session.clearConfirm(msg.userId);

  if (!allowed) {
    // Stranger: mint (or reuse) a pairing code. Never process content.
    try {
      const { code, deduped } = await requestPairing(
        deps.pool,
        msg.userId,
        msg.username,
      );
      await auditCommand(
        deps.pool,
        msg.userId,
        "<pair>",
        "",
        deduped ? "deduped" : "challenged",
      );
      return {
        ...ack,
        replies: [
          deduped
            ? `ID kamu: ${msg.userId}. Kode pairing sudah dikirim sebelumnya — minta operator menyetujuinya.`
            : `Belum dikenal. ID kamu: ${msg.userId}\nMinta operator menjalankan:\npolyroot telegram approve ${code}\n(kode 1 jam, lalu kirim perintah apa saja untuk mulai)`,
        ],
      };
    } catch {
      await auditCommand(
        deps.pool,
        msg.userId,
        "<pair>",
        "",
        "denied:pairing-error",
      );
      return {
        ...ack,
        replies: ["Pairing penuh — hubungi operator langsung."],
      };
    }
  }

  // Owner past the gate: secret-looking input is refused outright.
  if (looksLikeSecret(msg.text)) {
    await auditCommand(
      deps.pool,
      msg.userId,
      command,
      "",
      "denied:secret-like",
    );
    return {
      ...ack,
      replies: [
        "⛔ Pesan itu tampak seperti kredensial — ditolak dan dicatat. Jangan pernah kirim private key / API key / passphrase lewat chat.",
      ],
    };
  }

  const handler = deps.handlers[command];
  if (!handler && !FORBIDDEN_COMMANDS.has(command)) {
    await auditCommand(deps.pool, msg.userId, command, "", "unknown-command");
    const names = Object.keys(deps.handlers).sort().join(", ");
    return {
      ...ack,
      replies: [`Perintah tak dikenal. Yang tersedia: ${names}`],
    };
  }
  if (FORBIDDEN_COMMANDS.has(command)) {
    await auditCommand(deps.pool, msg.userId, command, "", "denied:forbidden");
    return {
      ...ack,
      replies: [
        `⛔ “${command}” HANYA via terminal (menyentuh kunci/mode/guard).`,
      ],
    };
  }
  if (deps.confirmCommands.has(command)) {
    deps.session.requestConfirm(msg.userId, command, args);
    await auditCommand(
      deps.pool,
      msg.userId,
      command,
      args.join(" "),
      "confirm-requested",
    );
    return {
      ...ack,
      replies: [
        `“${command}” mengubah keadaan. Balas YA dalam 5 menit untuk eksekusi, atau kirim perintah lain untuk batal.`,
      ],
    };
  }
  if (!deps.readCommands.has(command)) {
    await auditCommand(deps.pool, msg.userId, command, "", "denied:forbidden");
    return {
      ...ack,
      replies: [
        `⛔ “${command}” tidak tersedia via Telegram. Gunakan terminal untuk itu.`,
      ],
    };
  }
  return runHandler(deps, msg, command, args, "direct");
}

async function runHandler(
  deps: RouterDeps,
  msg: InboundMessage,
  command: string,
  args: string[],
  via: string,
): Promise<RouteResult> {
  const ack = { replies: [] as string[], ackUpdateId: msg.updateId };
  try {
    const out = await deps.handlers[command]!(args, {
      userId: msg.userId,
      username: msg.username,
    });
    const texts = (Array.isArray(out) ? out : [out]).map((t) =>
      redactSecrets(String(t ?? "")),
    );
    await auditCommand(
      deps.pool,
      msg.userId,
      command,
      args.join(" "),
      `${via}:ok`,
    );
    return {
      ...ack,
      replies: texts.length > 0 ? texts : ["(tidak ada output)"],
    };
  } catch (err) {
    const message = redactSecrets((err as Error).message ?? String(err));
    await auditCommand(
      deps.pool,
      msg.userId,
      command,
      args.join(" "),
      `${via}:error`,
    );
    return { ...ack, replies: [`❌ Gagal: ${message}`] };
  }
}

function unknownUserReply(userId: string): string {
  return (
    `Belum dikenal. ID kamu: ${userId}\nMinta operator menjalankan:\n` +
    `polyroot telegram approve <KODE> (minta kode baru dengan mengirim pesan apa saja)`
  );
}

/* ─── long-polling loop ───────────────────────────────────────────── */

export interface PollingDeps {
  api: BotApi;
  pool: TelegramPool;
  staticOwners: string[];
  session: TelegramSession;
  handlers: Record<string, CommandHandler>;
  readCommands: Set<string>;
  confirmCommands: Set<string>;
  /** Drop queued updates on boot (stale commands must never execute). */
  dropPendingOnBoot?: boolean;
  pollTimeoutSec?: number;
  onError?: (err: Error) => void;
}

export interface PollingHandle {
  stop: () => void;
  /** Single fetch+dispatch cycle (tests, manual ticks). */
  tick: () => Promise<void>;
}

export function startTelegramPolling(deps: PollingDeps): PollingHandle {
  let offset = 0;
  let booted = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const fetchOnce = async (): Promise<TelegramUpdate[]> => {
    const params: Record<string, unknown> = {
      timeout: deps.pollTimeoutSec ?? 30,
    };
    if (offset > 0) params["offset"] = offset;
    // getUpdates without allowed_updates: default set is fine (messages).
    const res = await deps.api.call<unknown>("getUpdates", params);
    return Array.isArray(res) ? (res as TelegramUpdate[]) : [];
  };

  const tick = async (): Promise<void> => {
    let updates: TelegramUpdate[];
    try {
      updates = await fetchOnce();
    } catch (err) {
      deps.onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (!booted) {
      // Cold boot: learn the frontier, act on nothing (stale queue dies).
      booted = true;
      if (deps.dropPendingOnBoot ?? true) {
        for (const u of updates) {
          if (typeof u.update_id === "number" && u.update_id >= offset) {
            offset = u.update_id + 1;
          }
        }
        return;
      }
    }
    for (const u of updates) {
      if (typeof u.update_id === "number" && u.update_id >= offset) {
        offset = u.update_id + 1;
      }
      const msg = extractInbound(u);
      if (!msg) continue;
      try {
        const { replies } = await routeTelegramMessage(
          {
            pool: deps.pool,
            staticOwners: deps.staticOwners,
            session: deps.session,
            handlers: deps.handlers,
            readCommands: deps.readCommands,
            confirmCommands: deps.confirmCommands,
          },
          msg,
        );
        for (const text of replies) {
          await sendReply(deps.api, msg.chatId, text);
        }
      } catch (err) {
        deps.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      await tick();
      if (stopped) break;
      await new Promise((r) => {
        timer = setTimeout(r, 1000);
      });
    }
  };
  void loop().catch((err) => {
    deps.onError?.(err instanceof Error ? err : new Error(String(err)));
  });

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    tick,
  };
}
