/**
 * @polyroot/signer — Credential authentication contracts (CT-09, PM-WALLET-06).
 *
 * G0 (offline-provable) half: typed request-body HMAC verification with a
 * timing-safe comparison, plus credential-to-signer binding — a credential
 * only authenticates requests for the wallet signer it was issued to.
 * API derive/create/revoke flows and live acceptance are G4 (need the
 * credential service) and stay NOT_RUN.
 *
 * Pure functions except for Node's crypto HMAC (no I/O, no network).
 */

import { createHmac, timingSafeEqual } from "crypto";

/**
 * In-memory token bucket rate limiter for credential authentication requests.
 */
interface RateBucket {
  tokens: number;
  lastRefill: number;
}

const rateBuckets = new Map<string, RateBucket>();
const RATE_LIMIT_CAPACITY = 60; // 60 requests per window
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute window

export type CredentialAuthCode = "HMAC_MISMATCH" | "SIGNER_NOT_BOUND" | "RATE_LIMIT_EXCEEDED";

export type CredentialAuthResult =
  | { ok: true; note: string }
  | { ok: false; code: CredentialAuthCode; reason: string };

/**
 * Check and consume a rate limit token for a given credential or key identifier.
 */
export function checkRateLimit(key: string, now: number = Date.now()): boolean {
  if (!key) return true;
  let bucket = rateBuckets.get(key);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_CAPACITY, lastRefill: now };
    rateBuckets.set(key, bucket);
  }

  // Refill tokens based on elapsed time
  const elapsed = now - bucket.lastRefill;
  if (elapsed > RATE_LIMIT_WINDOW_MS) {
    bucket.tokens = RATE_LIMIT_CAPACITY;
    bucket.lastRefill = now;
  }

  if (bucket.tokens <= 0) {
    return false;
  }

  bucket.tokens -= 1;
  return true;
}

/**
 * Verify a typed request body against its HMAC-SHA256 tag. Comparison is
 * timing-safe over equal-length buffers; malformed tags fail closed.
 */
export function verifyBodyHmac(
  secret: string,
  body: string,
  presentedHex: string,
  options?: { rateLimitKey?: string },
): CredentialAuthResult {
  if (!secret || !body || !presentedHex) {
    return {
      ok: false,
      code: "HMAC_MISMATCH",
      reason: "secret, body and tag are all required",
    };
  }
  // Rate limit check: only if a key is provided
  if (options?.rateLimitKey && !checkRateLimit(options.rateLimitKey)) {
    return {
      ok: false,
      code: "RATE_LIMIT_EXCEEDED",
      reason: "rate limit exceeded",
    };
  }

  let presented: Buffer;
  try {
    presented = Buffer.from(presentedHex, "hex");
  } catch {
    return {
      ok: false,
      code: "HMAC_MISMATCH",
      reason: "tag is not valid hex",
    };
  }
  const expected = createHmac("sha256", secret).update(body, "utf8").digest();
  if (presented.length !== expected.length) {
    return {
      ok: false,
      code: "HMAC_MISMATCH",
      reason: "tag length mismatch",
    };
  }
  if (!timingSafeEqual(presented, expected)) {
    return {
      ok: false,
      code: "HMAC_MISMATCH",
      reason: "HMAC tag does not match request body",
    };
  }
  return { ok: true, note: "request body authenticated" };
}

export interface CredentialBinding {
  credentialId: string;
  boundSignerAddress: string;
}

/**
 * A credential authenticates ONLY requests for its bound wallet signer.
 * Cross-signer use is refused with the credential named — never silently
 * accepted because "a valid credential was presented".
 */
export function checkCredentialBinding(
  credential: CredentialBinding,
  requestSignerAddress: string,
  options?: { rateLimitKey?: string },
): CredentialAuthResult {
  if (!credential.credentialId || !credential.boundSignerAddress) {
    return {
      ok: false,
      code: "SIGNER_NOT_BOUND",
      reason: "credential binding incomplete",
    };
  }
  if (options?.rateLimitKey && !checkRateLimit(options.rateLimitKey)) {
    return {
      ok: false,
      code: "RATE_LIMIT_EXCEEDED",
      reason: "rate limit exceeded",
    };
  }
  if (
    credential.boundSignerAddress.toLowerCase() !==
    requestSignerAddress.toLowerCase()
  ) {
    return {
      ok: false,
      code: "SIGNER_NOT_BOUND",
      reason: `credential ${credential.credentialId} is bound to ${credential.boundSignerAddress}, not ${requestSignerAddress}`,
    };
  }
  return { ok: true, note: "credential bound to requesting signer" };
}
