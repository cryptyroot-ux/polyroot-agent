import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { Client } from "pg";
import {
  looksLikeSecret,
  redactSecrets,
  normalizeTelegramId,
  makePairingCode,
  hashPairingCode,
  RateLimiter,
  requestPairing,
  approvePairing,
  listPendingPairings,
  revokeUser,
  allowUserDirect,
  isAllowed,
  parseTelegramText,
  chunkMessage,
  captureOutput,
  routeTelegramMessage,
  TelegramSession,
  type CommandHandler,
} from "@polyroot/runtime";

const pgConfig = {
  user: "postgres",
  host: "localhost",
  database: "postgres",
  password: "postgres",
  port: 5432,
};

async function makeTables(client: Client): Promise<void> {
  await client.query("DROP TABLE IF EXISTS telegram_audit");
  await client.query("DROP TABLE IF EXISTS telegram_allowlist");
  await client.query("DROP TABLE IF EXISTS telegram_pairing");
  await client.query(`
    CREATE TABLE telegram_pairing (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      code_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await client.query(`
    CREATE TABLE telegram_allowlist (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL DEFAULT '',
      added_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await client.query(`
    CREATE TABLE telegram_audit (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      command TEXT NOT NULL,
      args_redacted TEXT NOT NULL DEFAULT '',
      result TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

describe("telegram secrets + identities", () => {
  it("detects credential material, never usernames", () => {
    assert.equal(
      looksLikeSecret("my key 0x" + "ab".repeat(32)),
      true,
    );
    assert.equal(looksLikeSecret("sk-abc123XYZ-_"), true);
    assert.equal(looksLikeSecret("api_key = hunter2hunter2"), true);
    assert.equal(looksLikeSecret("-----BEGIN PRIVATE KEY-----"), true);
    assert.equal(looksLikeSecret("halo, status dong"), false);
    assert.equal(looksLikeSecret("@someone"), false);
  });

  it("redacts secrets from outbound text, keeps the rest", () => {
    const key = "0x" + "ab".repeat(32);
    const out = redactSecrets(`wallet ${key} ok, sk-live-123 failed`);
    assert.ok(!out.includes(key));
    assert.ok(!out.includes("sk-live-123"));
    assert.ok(out.includes("wallet") && out.includes("ok"));
  });

  it("accepts numeric ids only (CVE-2026-28480 class)", () => {
    assert.equal(normalizeTelegramId("123456789"), "123456789");
    assert.equal(normalizeTelegramId("tg:123"), "123");
    assert.equal(normalizeTelegramId("@someone"), null);
    assert.equal(normalizeTelegramId(""), null);
    assert.equal(normalizeTelegramId(undefined), null);
  });

  it("pairing codes are unambiguous and hashed", () => {
    for (let i = 0; i < 20; i++) {
      const c = makePairingCode();
      assert.equal(c.length, 8);
      assert.ok(/^[A-HJ-NP-Z2-9]{8}$/.test(c));
    }
    assert.equal(hashPairingCode("AB"), hashPairingCode("AB"));
    assert.notEqual(hashPairingCode("AB"), hashPairingCode("AC"));
  });

  it("rate limiter blocks the 21st hit per minute", () => {
    const r = new RateLimiter(20);
    for (let i = 0; i < 20; i++) assert.equal(r.allow("u", 1000), true);
    assert.equal(r.allow("u", 1000), false);
    assert.equal(r.allow("u", 61_001), true);
  });

  it("parseTelegramText strips slash and bot suffix", () => {
    assert.deepEqual(parseTelegramText("/mode SHADOW"), {
      command: "mode",
      args: ["SHADOW"],
    });
    assert.deepEqual(parseTelegramText("status"), { command: "status", args: [] });
    assert.deepEqual(parseTelegramText("/logs@mybot --follow"), {
      command: "logs",
      args: ["--follow"],
    });
  });

  it("chunkMessage splits over the Telegram limit", () => {
    const big = "x".repeat(9000);
    const parts = chunkMessage(big);
    assert.ok(parts.length >= 3);
    assert.ok(parts.every((p) => p.length <= 4000));
    assert.deepEqual(chunkMessage("short"), ["short"]);
  });

  it("captureOutput collects prints and restores console", async () => {
    const text = await captureOutput(async () => {
      console.log("hello", "world");
    });
    assert.equal(text, "hello world");
    assert.equal(typeof console.log, "function");
  });
});

describe("telegram pairing + allowlist (PG)", () => {
  let client: Client;

  beforeEach(async () => {
    client = new Client(pgConfig);
    await client.connect();
    await makeTables(client);
  });

  afterEach(async () => {
    await client.query("DROP TABLE IF EXISTS telegram_audit");
    await client.query("DROP TABLE IF EXISTS telegram_allowlist");
    await client.query("DROP TABLE IF EXISTS telegram_pairing");
    await client.end();
  });

  it("challenge, approve, allow, revoke round-trip", async () => {
    const { code, deduped } = await requestPairing(client as never, "111", "alice");
    assert.equal(deduped, false);
    assert.equal(code.length, 8);
    const again = await requestPairing(client as never, "111", "alice");
    assert.equal(again.deduped, true);
    assert.equal(await isAllowed(client as never, "111", []), false);
    const bad = await approvePairing(client as never, "ZZZZZZZZ");
    assert.equal(bad, null);
    const hit = await approvePairing(client as never, code);
    assert.ok(hit && hit.userId === "111");
    assert.equal(await isAllowed(client as never, "111", []), true);
    const pend = await listPendingPairings(client as never);
    assert.equal(pend.length, 0);
    assert.equal(await revokeUser(client as never, "111"), true);
    assert.equal(await isAllowed(client as never, "111", []), false);
  });

  it("expired codes never approve", async () => {
    await client.query(
      `INSERT INTO telegram_pairing (user_id, username, code_hash, status, expires_at)
       VALUES ('222', 'bob', $1, 'pending', now() - interval '1 minute')`,
      [hashPairingCode("OLDCODE12")],
    );
    assert.equal(await approvePairing(client as never, "OLDCODE12"), null);
  });

  it("static owners pass without DB rows; DB failure denies", async () => {
    assert.equal(await isAllowed(client as never, "999", ["999"]), true);
    const broken = {
      query: async () => {
        throw new Error("db down");
      },
    };
    assert.equal(await isAllowed(broken as never, "111", []), false);
  });

  it("direct allow works for numeric ids", async () => {
    await allowUserDirect(client as never, "555", "carol");
    assert.equal(await isAllowed(client as never, "555", []), true);
  });
});

describe("telegram router tiers", () => {
  let client: Client;
  const handlers: Record<string, CommandHandler> = {
    status: async () => "STATUS-OK",
    halt: async () => "HALTED",
  };
  const read = new Set(["status"]);
  const confirm = new Set(["halt"]);

  beforeEach(async () => {
    client = new Client(pgConfig);
    await client.connect();
    await makeTables(client);
  });

  afterEach(async () => {
    await client.query("DROP TABLE IF EXISTS telegram_audit");
    await client.query("DROP TABLE IF EXISTS telegram_allowlist");
    await client.query("DROP TABLE IF EXISTS telegram_pairing");
    await client.end();
  });

  const msg = (over: Record<string, unknown> = {}) => ({
    updateId: 1,
    chatId: 10,
    chatType: "private",
    userId: "777",
    username: "owner",
    text: "status",
    ...over,
  });

  const deps = () => ({
    pool: client as never,
    staticOwners: ["777"],
    session: new TelegramSession(),
    handlers,
    readCommands: read,
    confirmCommands: confirm,
  });

  it("drops groups silently (no existence signal)", async () => {
    const r = await routeTelegramMessage(deps(), {
      ...msg(),
      chatType: "supergroup",
      text: "halt",
    });
    assert.deepEqual(r.replies, []);
  });

  it("strangers get a pairing challenge, content never processed", async () => {
    const r = await routeTelegramMessage(deps(), {
      ...msg(),
      userId: "888",
      text: "halt",
    });
    assert.equal(r.replies.length, 1);
    assert.ok(r.replies[0]?.includes("888"));
    assert.ok(r.replies[0]?.includes("approve"));
  });

  it("owners run read commands directly", async () => {
    const r = await routeTelegramMessage(deps(), msg());
    assert.deepEqual(r.replies, ["STATUS-OK"]);
  });

  it("confirm tier asks YA, executes once, then expires", async () => {
    const d = deps();
    const first = await routeTelegramMessage(d, { ...msg(), text: "halt" });
    assert.ok(first.replies[0]?.includes("YA"));
    const exec = await routeTelegramMessage(d, { ...msg(), text: "YA" });
    assert.deepEqual(exec.replies, ["HALTED"]);
    const again = await routeTelegramMessage(d, { ...msg(), text: "YA" });
    assert.ok(again.replies[0]?.includes("Tidak ada aksi"));
  });

  it("forbidden commands name the terminal instead", async () => {
    const r = await routeTelegramMessage(deps(), { ...msg(), text: "setup" });
    assert.ok(r.replies[0]?.includes("HANYA via terminal") || r.replies[0]?.includes("terminal"));
  });

  it("secret-looking input is refused and audited", async () => {
    const r = await routeTelegramMessage(deps(), {
      ...msg(),
      text: "here 0x" + "ab".repeat(32),
    });
    assert.ok(r.replies[0]?.includes("⛔"));
    const audit = await client.query(
      `SELECT result FROM telegram_audit WHERE user_id = '777' ORDER BY created_at DESC LIMIT 1`,
    );
    assert.ok(String(audit.rows[0]?.["result"] ?? "").includes("secret"));
  });

  it("unknown commands list what exists", async () => {
    const r = await routeTelegramMessage(deps(), { ...msg(), text: "frobnicate" });
    assert.ok(r.replies[0]?.includes("status"));
  });

  it("rate limit blocks floods politely", async () => {
    const d = deps();
    let last: string[] = [];
    for (let i = 0; i < 21; i++) {
      const r = await routeTelegramMessage(d, { ...msg(), updateId: i + 1 });
      last = r.replies;
    }
    assert.ok(last[0]?.includes("Terlalu cepat"));
  });

  it("audit trail records allowed commands", async () => {
    await routeTelegramMessage(deps(), msg());
    const audit = await client.query(
      `SELECT command, result FROM telegram_audit WHERE user_id = '777' ORDER BY created_at DESC LIMIT 1`,
    );
    assert.equal(audit.rows[0]?.["command"], "status");
    assert.ok(String(audit.rows[0]?.["result"] ?? "").includes("ok"));
  });
});

describe("telegram setup wizard helpers", () => {
  it("isValidBotTokenFormat accepts BotFather shape only", async () => {
    const { isValidBotTokenFormat } = await import("@polyroot/runtime");
    assert.equal(isValidBotTokenFormat("123456:ABCdefGHIjklMNOpqrSTUvwxYZ123456789"), true);
    assert.equal(isValidBotTokenFormat("abc:short"), false);
    assert.equal(isValidBotTokenFormat("not-a-token"), false);
    assert.equal(isValidBotTokenFormat(""), false);
    assert.equal(isValidBotTokenFormat("  123456:ABCdefGHIjklMNOpqrSTUvwxYZ123456789  "), true);
  });

  it("detectOwnerFromUpdates finds the first human DM", async () => {
    const { detectOwnerFromUpdates } = await import("@polyroot/runtime");
    const dm = (userId: number, username: string, chatType = "private") => ({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: userId, username },
        chat: { id: userId, type: chatType },
        text: "halo",
      },
    });
    assert.deepEqual(detectOwnerFromUpdates([dm(111, "alice")]), {
      userId: "111",
      username: "alice",
    });
    assert.equal(
      detectOwnerFromUpdates([{ ...dm(111, "alice"), message: { ...dm(111, "alice").message, chat: { id: 1, type: "supergroup" } } }]),
      null,
    );
    assert.equal(detectOwnerFromUpdates([dm(222, "SomeBot")]), null);
    assert.equal(detectOwnerFromUpdates([]), null);
    assert.equal(detectOwnerFromUpdates([{ update_id: 1 }]), null);
  });
});
