/**
 * @polyroot/signer — Production CryptoSigner Implementation (secp256k1 / ECDSA)
 *
 * Production-ready cryptographic signer using secp256k1 (Ethereum/Polygon curve).
 * Implements the CryptoSigner interface for use with SignerVault.
 *
 * SECURITY NOTES:
 * - Private key NEVER leaves this module's memory
 * - Key loaded from secure environment variable or HSM/KMS integration point
 * - All signing goes through deterministic ECDSA (RFC 6979) for reproducibility
 * - Payload hash verified before signing (defense in depth)
 *
 * For production with HSM/KMS: Replace this module with KMS-backed implementation
 * that calls AWS KMS SignCommand, HashiCorp Vault Transit, or Azure Key Vault.
 */

import keccak256 from "keccak256";
import type { SignRequest, CryptoSigner } from "./index.js";
import { computePayloadHash } from "./index.js";
import { resolveWalletKey } from "./keystore.js";
import elliptic from "elliptic";
const { ec: EC } = elliptic;

const ec = new EC("secp256k1");

export interface ProdSignerConfig {
  /** Private key in hex format (64 chars, 32 bytes) - from env var or HSM */
  privateKeyHex: string;
  /** Optional: chain ID for validation */
  chainId?: number;
}

/**
 * Derive the Ethereum address for a private key (0x-prefix optional).
 * Used to build the live WalletIdentity from the user's configured key —
 * the signer address must match the key that actually signs (WAL-03).
 */
export function deriveAddressFromPrivateKey(privateKeyHex: string): string {
  const normalized = privateKeyHex.startsWith("0x")
    ? privateKeyHex.slice(2)
    : privateKeyHex;
  const keyPair = loadKeypair(normalized);
  const publicKeyNoPrefix = keyPair.publicKey.slice(1); // remove 0x04 prefix
  const addressHash = keccak256(publicKeyNoPrefix);
  return "0x" + addressHash.slice(-20).toString("hex");
}

interface KeyPair {
  privateKey: Buffer;
  publicKey: Buffer;
}

/**
 * Load and validate secp256k1 keypair from hex private key
 */
function loadKeypair(privateKeyHex: string): KeyPair {
  if (!privateKeyHex || privateKeyHex.length !== 64) {
    throw new Error(
      "INVALID_PRIVATE_KEY: Must be 64 hex characters (32 bytes)",
    );
  }

  const privateKey = Buffer.from(privateKeyHex, "hex");
  const keyPair = ec.keyFromPrivate(privateKey);
  const publicKey = keyPair.getPublic(false, "array"); // uncompressed (65 bytes: 0x04 + x + y)

  return {
    privateKey,
    publicKey: Buffer.from(publicKey),
  };
}

/**
 * Deterministic ECDSA signing (RFC 6979) using secp256k1
 * Returns signature in IEEE P1363 format (r || s, 64 bytes) as hex string with 0x prefix
 */
function signDeterministic(keyPair: KeyPair, messageHash: Buffer): string {
  const keyPairEC = ec.keyFromPrivate(keyPair.privateKey);

  // Sign with deterministic K (RFC 6979)
  const signature = keyPairEC.sign(messageHash, {
    canonical: true,
    k: undefined,
  });

  // Convert to IEEE P1363 format (r || s, each 32 bytes)
  const r = signature.r.toArrayLike(Buffer, "be", 32);
  const s = signature.s.toArrayLike(Buffer, "be", 32);

  const signatureBytes = Buffer.concat([r, s]);
  return "0x" + signatureBytes.toString("hex");
}

/**
 * Verify signature (for testing/validation)
 */
function verifySignature(
  publicKey: Buffer,
  messageHash: Buffer,
  signatureHex: string,
): boolean {
  try {
    const sigBytes = Buffer.from(signatureHex.replace("0x", ""), "hex");
    if (sigBytes.length !== 64) return false;

    const r = sigBytes.slice(0, 32);
    const s = sigBytes.slice(32, 64);

    const keyPairEC = ec.keyFromPublic(publicKey, "array");
    return keyPairEC.verify(messageHash, { r, s });
  } catch {
    return false;
  }
}

/**
 * Create production CryptoSigner using secp256k1 deterministic ECDSA
 *
 * SECURITY: Private key loaded from environment variable at startup.
 * Never hardcode keys. Use secure secret management in production.
 */
export function createProductionCryptoSigner(
  config: ProdSignerConfig,
): CryptoSigner {
  const { privateKeyHex, chainId = 137 } = config;

  if (!privateKeyHex) {
    throw new Error(
      "PRODUCTION_SIGNER_ERROR: PRIVATE_KEY_HEX environment variable required",
    );
  }

  const keyPair = loadKeypair(privateKeyHex);

  // Derive Ethereum address from public key (last 20 bytes of keccak256(publicKey))
  const publicKeyNoPrefix = keyPair.publicKey.slice(1); // remove 0x04 prefix
  const addressHash = keccak256(publicKeyNoPrefix);
  const address = "0x" + addressHash.slice(-20).toString("hex");

  console.log(`🔐 Production CryptoSigner initialized for address: ${address}`);
  console.log(`   Chain ID: ${chainId}`);
  console.log(`   Curve: secp256k1 (ECDSA deterministic RFC 6979)`);

  return async (request: SignRequest): Promise<string> => {
    // 1. Verify payload hash matches canonical serialization (defense in depth)
    const expectedHash = computePayloadHash(request);
    if (request.payloadHash !== expectedHash) {
      throw new Error(
        `PAYLOAD_HASH_MISMATCH: Expected ${expectedHash}, got ${request.payloadHash}`,
      );
    }

    // 2. Verify chain ID matches
    if (request.expectedChainId !== chainId) {
      throw new Error(
        `CHAIN_ID_MISMATCH: Expected ${chainId}, got ${request.expectedChainId}`,
      );
    }

    // 3. Verify payload hash is valid hex (32 bytes = 64 hex chars)
    const payloadHashBytes = Buffer.from(
      request.payloadHash.replace("0x", ""),
      "hex",
    );
    if (payloadHashBytes.length !== 32) {
      throw new Error(
        `INVALID_PAYLOAD_HASH_LENGTH: Expected 32 bytes, got ${payloadHashBytes.length}`,
      );
    }

    // 4. Sign the payload hash
    const signature = signDeterministic(keyPair, payloadHashBytes);

    // 5. Verify signature before returning (defense in depth)
    const messageHash = payloadHashBytes;
    const isValid = verifySignature(keyPair.publicKey, messageHash, signature);
    if (!isValid) {
      throw new Error(
        "SIGNATURE_VERIFICATION_FAILED: Generated signature failed verification",
      );
    }

    return signature;
  };
}

/**
 * Factory for creating signer from environment variables.
 * Prefers the sealed keystore (POLYROOT_KEYSTORE_JSON + PASSPHRASE) when
 * configured; falls back to PRIVATE_KEY_HEX / WALLET_PRIVATE_KEY.
 */
export function createSignerFromEnv(chainId: number = 137): CryptoSigner {
  const resolved = resolveWalletKey(
    process.env as Record<string, string | undefined>,
  );
  const privateKeyHex = resolved.startsWith("0x")
    ? resolved.slice(2)
    : resolved;

  return createProductionCryptoSigner({ privateKeyHex, chainId });
}

/**
 * Factory for creating signer from Hex string (for testing)
 */
export function createSignerFromHex(
  privateKeyHex: string,
  chainId: number = 137,
): CryptoSigner {
  return createProductionCryptoSigner({ privateKeyHex, chainId });
}

/**
 * Interface for future KMS/HSM integration
 * When ready to use AWS KMS, HashiCorp Vault, or Azure Key Vault,
 * implement this interface and swap in createProductionCryptoSigner
 */
export interface KMSSignerInterface {
  sign(messageHash: Buffer): Promise<string>;
  getPublicKey(): Buffer;
  getAddress(): string;
}

/**
 * Placeholder for future KMS implementation
 * When ready to use AWS KMS, HashiCorp Vault, or Azure Key Vault,
 * implement this interface and swap in createProductionCryptoSigner
 *
 * Example KMS implementation structure:
 *
 * export async function createKMSCryptoSigner(config: KMSSignerConfig): Promise<CryptoSigner> {
 *   const kms = new KMSClient({...});
 *   const keyId = config.keyId;
 *
 *   return async (request: SignRequest) => {
 *     const expectedHash = computePayloadHash(request);
 *     if (request.payloadHash !== expectedHash) throw new Error("PAYLOAD_HASH_MISMATCH");
 *
 *     const command = new SignCommand({
 *       KeyId: keyId,
 *       Message: Buffer.from(request.payloadHash.replace("0x", ""), "hex"),
 *       MessageType: "DIGEST",
 *       SigningAlgorithm: "ECDSA_SHA_256",
 *     });
 *
 *     const response = await kms.send(command);
 *     if (!response.Signature) throw new Error("KMS_SIGN_FAILED");
 *
 *     // Convert DER to raw r||s format
 *     return "0x" + derToRaw(response.Signature).toString("hex");
 *   };
 * }
 */
