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

export type CredentialAuthCode = "HMAC_MISMATCH" | "SIGNER_NOT_BOUND";

export type CredentialAuthResult =
  | { ok: true; note: string }
  | { ok: false; code: CredentialAuthCode; reason: string };

/**
 * Verify a typed request body against its HMAC-SHA256 tag. Comparison is
 * timing-safe over equal-length buffers; malformed tags fail closed.
 */
export function verifyBodyHmac(
  secret: string,
  body: string,
  presentedHex: string,
): CredentialAuthResult {
  if (!secret || !body || !presentedHex) {
    return {
      ok: false,
      code: "HMAC_MISMATCH",
      reason: "secret, body and tag are all required",
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
): CredentialAuthResult {
  if (!credential.credentialId || !credential.boundSignerAddress) {
    return {
      ok: false,
      code: "SIGNER_NOT_BOUND",
      reason: "credential binding incomplete",
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
