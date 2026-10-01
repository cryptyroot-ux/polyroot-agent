import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCodexLogin,
  loadCodexAuth,
  refreshCodexToken,
  pingCodexBackend,
  codexHeaders,
  codexAuthFilePath,
  jwtExpiryMs,
  isCodexTokenExpired,
  accountIdFromIdToken,
  fetchCodexModels,
  DEFAULT_CODEX_MODELS,
} from "@polyroot/intelligence";

function jwt(exp: number): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp })}`;
}

const FAR = 4102444800; // year 2100
const PAST = 1000000000; // year 2001

function writeAuth(dir: string, doc: unknown): string {
  const codexDir = join(dir, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const path = join(codexDir, "auth.json");
  writeFileSync(path, JSON.stringify(doc));
  return path;
}

const insulatedEnv = () => {
  const prevHome = process.env["HOME"];
  const prevOverride = process.env["POLYROOT_CODEX_AUTH_FILE"];
  const prevCodexHome = process.env["CODEX_HOME"];
  delete process.env["POLYROOT_CODEX_AUTH_FILE"];
  delete process.env["CODEX_HOME"];
  return { prevHome, prevOverride, prevCodexHome };
};

describe("codex-auth (ChatGPT login)", () => {
  it("reads the nested official shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-"));
    const env = insulatedEnv();
    process.env["HOME"] = dir;
    try {
      const path = writeAuth(dir, {
        tokens: {
          access_token: jwt(FAR),
          refresh_token: "refresh-me",
          account_id: "acc123",
        },
      });
      assert.equal(codexAuthFilePath(), path);
      const login = readCodexLogin();
      assert.ok(login && login.kind === "oauth");
      assert.equal(login.accountId, "acc123");
      assert.equal(login.refreshToken, "refresh-me");
      assert.equal(isCodexTokenExpired(login, Date.now()), false);
    } finally {
      process.env["HOME"] = env.prevHome as string;
      if (env.prevOverride !== undefined) {
        process.env["POLYROOT_CODEX_AUTH_FILE"] = env.prevOverride;
      }
      if (env.prevCodexHome !== undefined) {
        process.env["CODEX_HOME"] = env.prevCodexHome;
      }
    }
  });

  it("reads the flat shape and detects expiry", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-"));
    const path = writeAuth(dir, {
      access_token: jwt(PAST),
      refresh_token: "r",
    });
    const login = readCodexLogin(path);
    assert.ok(login && login.kind === "oauth");
    assert.equal(isCodexTokenExpired(login, Date.now()), true);
  });

  it("routes API-key logins away from OAuth (never misfires)", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-"));
    const path = writeAuth(dir, { OPENAI_API_KEY: "sk-test" });
    const login = readCodexLogin(path);
    assert.ok(login && login.kind === "apikey");
  });

  it("returns null on missing/garbage files (never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-"));
    assert.equal(readCodexLogin(join(dir, "nope.json")), null);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    assert.equal(readCodexLogin(bad), null);
  });

  it("extracts account id from the id_token claim", () => {
    const b64 = (o: unknown) =>
      Buffer.from(JSON.stringify(o)).toString("base64url");
    const idt = `${b64({ alg: "none" })}.${b64({
      "https://api.openai.com/auth": { chatgpt_account_id: "acc-xyz" },
    })}.sig`;
    assert.equal(accountIdFromIdToken(idt, undefined), "acc-xyz");
    assert.equal(accountIdFromIdToken(undefined, "stored"), "stored");
    assert.equal(accountIdFromIdToken("garbage", undefined), undefined);
    assert.equal(jwtExpiryMs("garbage"), undefined);
  });

  it("loadCodexAuth throws re-login guidance when absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-"));
    await assert.rejects(
      loadCodexAuth({ authFile: join(dir, "missing.json") }),
      /codex login/,
    );
  });

  it("loadCodexAuth refreshes expired tokens and persists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-"));
    const freshJwt = jwt(FAR);
    const fetchImpl = (async (_url: unknown, opts: unknown) => {
      const body = JSON.parse((opts as { body: string }).body) as Record<
        string,
        unknown
      >;
      assert.equal(body["grant_type"], "refresh_token");
      assert.equal(body["refresh_token"], "old-refresh");
      return new Response(
        JSON.stringify({
          access_token: freshJwt,
          refresh_token: "new-refresh",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const path = writeAuth(dir, {
      tokens: { access_token: jwt(PAST), refresh_token: "old-refresh" },
    });
    const creds = await loadCodexAuth({ authFile: path, fetchImpl });
    assert.equal(creds.accessToken, freshJwt);
    // persisted back for the codex CLI too
    const reloaded = readCodexLogin(path);
    assert.ok(reloaded && reloaded.kind === "oauth");
    assert.equal(reloaded.accessToken, freshJwt);
  });

  it("refreshCodexToken refuses with re-login guidance on HTTP errors", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;
    await assert.rejects(
      refreshCodexToken("r", undefined, fetchImpl),
      /codex login/,
    );
  });

  it("pingCodexBackend + headers shape", async () => {
    const creds = {
      kind: "oauth" as const,
      accessToken: "tok",
      accountId: "acc",
    };
    const h = codexHeaders(creds);
    assert.equal(h["authorization"], "Bearer tok");
    assert.equal(h["ChatGPT-Account-ID"], "acc");
    assert.ok(h["originator"]);
    const okFetch = (async () =>
      new Response("{}", { status: 200 })) as typeof fetch;
    assert.equal(
      await pingCodexBackend("https://x.example", creds, okFetch),
      true,
    );
    const badFetch = (async () =>
      new Response("{}", { status: 403 })) as typeof fetch;
    assert.equal(
      await pingCodexBackend("https://x.example", creds, badFetch),
      false,
    );
  });
});

describe("codex model catalog (Hermes-aligned discovery)", () => {
  it("curated fallback lists only backend-accepted slugs", () => {
    assert.ok(DEFAULT_CODEX_MODELS.length >= 5);
    assert.ok(!DEFAULT_CODEX_MODELS.some((m: string) => /-pro$/.test(m)));
    assert.ok(
      !DEFAULT_CODEX_MODELS.some((m: string) => /gpt-5\.[12]-codex/.test(m)),
    );
  });

  it("reads the live {models:[{slug}]} shape", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          models: [
            { slug: "gpt-6-sol", supported_in_api: true },
            { slug: "gpt-6-sol" },
            { slug: "" },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    const creds = { kind: "oauth" as const, accessToken: "t" };
    assert.deepEqual(
      await fetchCodexModels("https://x.example", creds, fetchImpl),
      ["gpt-6-sol"],
    );
  });

  it("accepts OpenAI-style {data:[{id}]} too, throws when refused", async () => {
    const dataFetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "" }] }), {
        status: 200,
      })) as typeof fetch;
    const creds = { kind: "oauth" as const, accessToken: "t" };
    assert.deepEqual(
      await fetchCodexModels("https://x.example", creds, dataFetch),
      ["m1"],
    );
    const badFetch = (async () =>
      new Response("nope", { status: 403 })) as typeof fetch;
    await assert.rejects(
      fetchCodexModels("https://x.example", creds, badFetch),
    );
  });
});
