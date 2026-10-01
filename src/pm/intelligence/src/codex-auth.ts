/**
 * @polyroot/intelligence — ChatGPT-login (Codex OAuth) credentials.
 *
 * Lets owners spend their ChatGPT Plus/Pro/Team subscription instead of a
 * metered API key: the same login the official Codex CLI writes to
 * ~/.codex/auth.json is reused (read-only) as a Bearer credential for the
 * Codex Responses backend. Unofficial for third-party use and may change —
 * every failure degrades to a re-login instruction, never to a guess.
 *
 * Shapes handled (all observed in the wild):
 *   { tokens: { access_token, refresh_token?, id_token?, account_id? } }
 *   { access_token, refresh_token?, id_token?, account_id? }          (flat)
 *   { OPENAI_API_KEY: "sk-..." }  (API-key login — NOT oauth, reported
 *                                  separately so callers can route it)
 *
 * Token refresh uses the public OAuth client shipped with Codex CLI
 * (standard OAuth2 refresh_token grant, auth.openai.com). Short-lived
 * access tokens (~1h) make refresh load-bearing for a 24/7 loop.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_ORIGINATOR = "polyroot-agent";

export interface CodexOAuthCredentials {
  kind: "oauth";
  accessToken: string;
  refreshToken?: string;
  /** ChatGPT account id (for the ChatGPT-Account-ID header). */
  accountId?: string;
  /** Access-token expiry, ms epoch (from exp claim or file). */
  expiresAtMs?: number;
}

export interface CodexApiKeyLogin {
  kind: "apikey";
  key: string;
}

export type CodexLogin = CodexOAuthCredentials | CodexApiKeyLogin | null;

/** Test override for the auth file location (else $CODEX_HOME / ~/.codex). */
export function codexAuthFilePath(homeDir?: string): string {
  const override = process.env["POLYROOT_CODEX_AUTH_FILE"];
  if (override) return override;
  if (process.env["CODEX_HOME"])
    return join(process.env["CODEX_HOME"], "auth.json");
  const home = homeDir ?? process.env["HOME"] ?? "/tmp";
  return join(home, ".codex", "auth.json");
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : null;
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Best-effort expiry from a JWT exp claim (seconds) — unverified decode. */
export function jwtExpiryMs(jwt: string): number | undefined {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return undefined;
    const payload = JSON.parse(
      Buffer.from(parts[1] as string, "base64url").toString("utf8"),
    ) as unknown;
    const exp = asRecord(payload)?.["exp"];
    if (typeof exp === "number" && Number.isFinite(exp)) return exp * 1000;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Account id from the id_token claim `https://api.openai.com/auth`
 * (chatgpt_account_id), falling back to a stored account_id field.
 */
export function accountIdFromIdToken(
  idToken: string | undefined,
  stored: string | undefined,
): string | undefined {
  if (stored) return stored;
  if (!idToken) return undefined;
  try {
    const parts = idToken.split(".");
    if (parts.length < 2) return undefined;
    const payload = asRecord(
      JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8")),
    );
    const nested = asRecord(payload?.["https://api.openai.com/auth"]);
    return (
      asNonEmptyString(nested?.["chatgpt_account_id"]) ??
      asNonEmptyString(payload?.["chatgpt_account_id"])
    );
  } catch {
    return undefined;
  }
}

/** Read (never write, never create) the Codex login. Null = not logged in. */
export function readCodexLogin(authFile?: string): CodexLogin {
  const path = authFile ?? codexAuthFilePath();
  let raw: string;
  try {
    if (!existsSync(path)) return null;
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = asRecord(doc);
  if (!root) return null;
  // API-key login shape: route to the normal key path, not OAuth.
  const directKey = asNonEmptyString(root["OPENAI_API_KEY"]);
  // Nested token bag (official shape) or flat shape.
  const bag = asRecord(root["tokens"]) ?? root;
  const accessToken = asNonEmptyString(bag["access_token"]);
  if (accessToken) {
    const creds: CodexOAuthCredentials = { kind: "oauth", accessToken };
    const idToken = asNonEmptyString(bag["id_token"]);
    const refreshToken = asNonEmptyString(bag["refresh_token"]);
    if (refreshToken !== undefined) creds.refreshToken = refreshToken;
    const accountId = accountIdFromIdToken(
      idToken,
      asNonEmptyString(bag["account_id"]),
    );
    if (accountId !== undefined) creds.accountId = accountId;
    const exp =
      jwtExpiryMs(accessToken) ??
      (typeof bag["expires_at"] === "number"
        ? bag["expires_at"] * 1000
        : undefined);
    if (exp !== undefined) creds.expiresAtMs = exp;
    return creds;
  }
  if (directKey) return { kind: "apikey", key: directKey };
  return null;
}

export function isCodexTokenExpired(
  creds: CodexOAuthCredentials,
  nowMs = Date.now(),
  skewMs = 60_000,
): boolean {
  if (creds.expiresAtMs === undefined) return false;
  return nowMs + skewMs >= creds.expiresAtMs;
}

/**
 * Refresh an OAuth access token (standard refresh_token grant against the
 * public Codex client). Returns fresh credentials; persists them back to
 * the auth file best-effort (merge, 600 perms) so `codex` CLI keeps working
 * too. Throws with re-login guidance on any failure.
 */
export async function refreshCodexToken(
  refreshToken: string,
  authFile?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexOAuthCredentials> {
  const path = authFile ?? codexAuthFilePath();
  let res: Response;
  try {
    res = await fetchImpl(CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CODEX_OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });
  } catch (err) {
    throw new Error(
      `Codex token refresh unreachable (${(err as Error).message}); ` +
        "if it persists, refresh the login: `codex login`",
    );
  }
  if (!res.ok) {
    throw new Error(
      `Codex token refresh refused (HTTP ${res.status}); ` +
        "re-login required: `codex login` (browser) or `codex login --device-auth` (headless)",
    );
  }
  let body: unknown;
  try {
    body = (await res.json()) as unknown;
  } catch {
    throw new Error(
      "Codex token refresh returned garbage; re-login: `codex login`",
    );
  }
  const bag = asRecord(body) ?? {};
  const accessToken = asNonEmptyString(bag["access_token"]);
  if (!accessToken) {
    throw new Error(
      "Codex token refresh returned no access_token; re-login: `codex login`",
    );
  }
  const creds: CodexOAuthCredentials = { kind: "oauth", accessToken };
  const freshRefresh = asNonEmptyString(bag["refresh_token"]);
  if (freshRefresh !== undefined) creds.refreshToken = freshRefresh;
  else creds.refreshToken = refreshToken;
  const freshAccount = accountIdFromIdToken(
    asNonEmptyString(bag["id_token"]),
    undefined,
  );
  if (freshAccount !== undefined) creds.accountId = freshAccount;
  const freshExp = jwtExpiryMs(accessToken);
  if (freshExp !== undefined) creds.expiresAtMs = freshExp;
  // Persist back (merge with existing file so account_id etc. survive):
  // the refreshed login keeps working for `codex` CLI too. Best-effort —
  // the fresh token is returned regardless.
  try {
    if (existsSync(path)) {
      const prev = asRecord(JSON.parse(readFileSync(path, "utf8"))) ?? {};
      const prevTokens = asRecord(prev["tokens"]) ?? {};
      const merged = {
        ...prev,
        tokens: {
          ...prevTokens,
          access_token: creds.accessToken,
          ...(creds.refreshToken ? { refresh_token: creds.refreshToken } : {}),
        },
      };
      writeFileSync(path, JSON.stringify(merged, null, 2));
      chmodSync(path, 0o600);
    }
  } catch {
    // persistence is a courtesy — the fresh token still works this call
  }
  return creds;
}

/**
 * Load usable OAuth credentials: read cache, refresh when expired (needs a
 * refresh token), else throw re-login guidance. Never returns stale tokens
 * silently, never fabricates any.
 */
export async function loadCodexAuth(
  opts: {
    authFile?: string;
    fetchImpl?: typeof fetch;
    nowMs?: number;
  } = {},
): Promise<CodexOAuthCredentials> {
  const login = readCodexLogin(opts.authFile);
  if (login === null) {
    throw new Error(
      "No Codex login found. Sign in first: `codex login` (browser) or " +
        "`codex login --device-auth` (headless/VPS), then retry.",
    );
  }
  if (login.kind === "apikey") {
    throw new Error(
      "Codex holds an API-key login, not a ChatGPT subscription login. " +
        "Either use the OpenAI provider with that key, or `codex login` " +
        "with your ChatGPT account.",
    );
  }
  if (!isCodexTokenExpired(login, opts.nowMs)) return login;
  if (!login.refreshToken) {
    throw new Error(
      "Codex access token expired with no refresh token. Re-login: `codex login`.",
    );
  }
  return refreshCodexToken(login.refreshToken, opts.authFile, opts.fetchImpl);
}

/** Headers for Codex backend calls (Bearer + account + originator). */
export function codexHeaders(
  creds: CodexOAuthCredentials,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${creds.accessToken}`,
    originator: CODEX_ORIGINATOR,
  };
  if (creds.accountId) headers["ChatGPT-Account-ID"] = creds.accountId;
  return headers;
}

/**
 * Curated offline fallback (Hermes-aligned): ONLY slugs the ChatGPT Codex
 * OAuth backend actually accepts. Public-API "-pro" variants and retired
 * gpt-5.x-codex slugs return HTTP 400 there ("not supported when using
 * Codex with a ChatGPT account") — listing them leaks dead picker choices.
 * Research-preview gpt-5.3-codex-spark stays: Pro-only via this backend.
 */
export const DEFAULT_CODEX_MODELS: string[] = [
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex-spark",
];

/**
 * Live Codex model catalog: GET {base}/models with the credential's own
 * headers (the backend scopes the catalog per account — ChatGPT-Account-ID
 * included, else it masquerades as empty). Accepts both `{models:[{slug}]}`
 * and OpenAI-style `{data:[{id}]}`. Returns [] when nothing usable comes
 * back; throws on transport/HTTP failure. Caller falls back to
 * DEFAULT_CODEX_MODELS — never to free text that invites dead slugs.
 */
export async function fetchCodexModels(
  baseUrl: string,
  creds: CodexOAuthCredentials,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: codexHeaders(creds),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Codex catalog HTTP ${res.status}`);
    const data = (await res.json()) as {
      models?: Array<{ slug?: unknown }>;
      data?: Array<{ id?: unknown }>;
    };
    const ids = Array.isArray(data.models)
      ? data.models.map((m) => (typeof m?.slug === "string" ? m.slug : ""))
      : Array.isArray(data.data)
        ? data.data.map((m) => (typeof m?.id === "string" ? m.id : ""))
        : [];
    return [...new Set(ids.filter((id) => id.length > 0))];
  } catch (err) {
    throw new Error(
      `Codex catalog unreachable (${(err as Error).message ?? err})`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cheap connectivity probe: list Codex models (no inference cost).
 * True = reachable + authorized. False = anything else (caller decides:
 * warn + continue-anyway, never block setup on it).
 */
export async function pingCodexBackend(
  baseUrl: string,
  creds: CodexOAuthCredentials,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: codexHeaders(creds),
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
