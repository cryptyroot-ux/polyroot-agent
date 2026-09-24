/**
 * @polyroot/signer — Encrypted keystore (KMS step 1: key at rest).
 *
 * Seals the deposit-wallet private key with scrypt + AES-256-GCM so the
 * key never sits as raw hex on disk, in backups, or in shell history.
 * This protects the key AT REST — it does not replace HSM/KMS for
 * production custody, and the passphrase must still reach the process
 * securely (systemd credentials, Docker secrets, or equivalent).
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

export interface SealedKeystore {
  v: 1;
  algo: "scrypt-aes256gcm";
  salt: string;
  iv: string;
  ct: string;
}

const HEX64 = /^(0x)?[0-9a-fA-F]{64}$/;

function normalizeKey(privateKeyHex: string): string {
  if (!HEX64.test(privateKeyHex)) {
    throw new Error("KEYSTORE_INVALID_KEY: expected 64 hex characters");
  }
  return privateKeyHex.startsWith("0x") ? privateKeyHex : `0x${privateKeyHex}`;
}

/** Seal a private key under a passphrase. Returns only the envelope. */
export function sealPrivateKey(
  privateKeyHex: string,
  passphrase: string,
): SealedKeystore {
  const key = normalizeKey(privateKeyHex);
  if (!passphrase) throw new Error("KEYSTORE_PASSPHRASE_MISSING");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const derived = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", derived, iv);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(key.slice(2), "hex")),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  derived.fill(0);
  return {
    v: 1,
    algo: "scrypt-aes256gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
  };
}

function isEnvelope(value: unknown): value is SealedKeystore {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["v"] === 1 &&
    v["algo"] === "scrypt-aes256gcm" &&
    typeof v["salt"] === "string" &&
    typeof v["iv"] === "string" &&
    typeof v["ct"] === "string"
  );
}

/** Open an envelope. Wrong passphrase or tampering → KEYSTORE_AUTH_FAILED. */
export function openKeystore(
  envelope: SealedKeystore,
  passphrase: string,
): string {
  if (!isEnvelope(envelope)) {
    throw new Error("KEYSTORE_INVALID_ENVELOPE");
  }
  if (!passphrase) throw new Error("KEYSTORE_PASSPHRASE_MISSING");
  try {
    const derived = scryptSync(
      passphrase,
      Buffer.from(envelope.salt, "base64"),
      32,
    );
    const raw = Buffer.from(envelope.ct, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derived,
      Buffer.from(envelope.iv, "base64"),
    );
    // Last 16 bytes are the GCM auth tag.
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const pt = Buffer.concat([
      decipher.update(raw.subarray(0, raw.length - 16)),
      decipher.final(),
    ]);
    derived.fill(0);
    return `0x${pt.toString("hex")}`;
  } catch {
    throw new Error(
      "KEYSTORE_AUTH_FAILED: wrong passphrase or tampered envelope",
    );
  }
}

/**
 * Resolve the wallet key for signing: sealed keystore first (when
 * configured), raw env key second, fail-closed when neither exists.
 */
export function resolveWalletKey(env: NodeJS.ProcessEnv = process.env): string {
  const sealedJson = env["POLYROOT_KEYSTORE_JSON"] ?? "";
  if (sealedJson) {
    const passphrase = env["POLYROOT_KEYSTORE_PASSPHRASE"] ?? "";
    if (!passphrase) throw new Error("KEYSTORE_PASSPHRASE_MISSING");
    let envelope: unknown;
    try {
      envelope = JSON.parse(sealedJson) as unknown;
    } catch {
      throw new Error("KEYSTORE_INVALID_ENVELOPE");
    }
    return openKeystore(envelope as SealedKeystore, passphrase);
  }
  const raw = env["PRIVATE_KEY_HEX"] ?? env["WALLET_PRIVATE_KEY"] ?? "";
  if (!raw) {
    throw new Error(
      "PRIVATE_KEY_HEX (or WALLET_PRIVATE_KEY) is required without a configured keystore",
    );
  }
  return normalizeKey(raw);
}
