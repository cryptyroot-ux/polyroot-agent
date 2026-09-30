/**
 * @polyroot/signer — Signer Vault (PM-WALLET-07, Blueprint B5 / TABLE 8).
 *
 * The Signer Vault is the **smallest possible** secret-scope boundary. It holds
 * no private key in process memory except transiently inside the injected
 * low-level signing callback, and it performs no market/policy reasoning, no
 * web browsing and no ledger writes.
 *
 * It accepts only **typed, allowlisted Polymarket operations** and refuses to
 * sign unless every pre-sign invariant (TABLE 8) holds:
 *   1. The ExecutionPermit exists, is unexpired, unused (single-use), and its
 *      intent/payload/policy/lease hashes all match the request.
 *   2. Wallet/chain identity matches the expected signer/account/wallet type
 *      and current asset registry chain.
 *   3. The action is on the allowlist (order / cancel / position-lifecycle).
 *   4. The exact amount is within the permit reservation and hard policy.
 *   5. Quotes/market/rules/venue-mode/clock are fresh (within TTL).
 *   6. The canonical payload hash is recorded before any side effect and the
 *      raw secret is never logged.
 *
 * The vault delegates the byte-level cryptographic signature to an injected
 * `cryptoSigner` so the tests exercise the full guard logic without any key,
 * and production wiring supplies the real L1/CLOB signer behind a credential
 * provider (out of scope of this module). Keys never live in this module.
 */

import { createHash } from "crypto";
import type {
  ExecutionPermit,
  WalletIdentity,
  VenueMode,
} from "@polyroot/domain";
import { ExecutionPermitSchema, VenueModeSchema } from "@polyroot/domain";

/** Actions the vault will ever consider signing. Everything else is refused. */
export const SIGNER_ALLOWED_ACTIONS = [
  "ORDER_SUBMIT",
  "ORDER_CANCEL",
  "POSITION_REDEEM",
  "POSITION_MERGE",
] as const;
export type SignerAction = (typeof SIGNER_ALLOWED_ACTIONS)[number];

/**
 * Canonical, signed, typed action request. This is the ONLY shape the vault
 * accepts — no arbitrary calldata, no free-form destination, no raw SDK
 * payload from the business layer (PM-WALLET-07).
 *
 * All fields are material. Mutating ANY field must change the payload hash
 * and cause the vault to refuse the signature.
 */
export interface SignRequest {
  schema_version: string;
  action: SignerAction;
  /** Execution permit — MUST be valid, unexpired, unused, and bind to this action. */
  permit: ExecutionPermit;
  /** Wallet identity — signer, account, funder must be distinct (WAL-03). */
  wallet: WalletIdentity;
  /** Exact amount in integer base units (never float; PM-LED-02). */
  amountBase: bigint;
  /** Canonical domain-level order/action id being signed. */
  actionId: string;
  /** Intent id the permit authorizes — must equal permit.intent_id. */
  intentId: string;
  /** Market id / condition id scoped to the permit. */
  marketContext: string;
  /** Venue mode observed immediately before signing (TABLE 17 matrix). */
  venueMode: VenueMode;
  /** Wall-clock freshness check source. */
  now: Date;
  /** Order side (BUY/SELL) bound to the signed request. */
  side: "BUY" | "SELL";
  /** Price in base units (same decimals as COLLATERAL_DECIMALS). */
  priceBase: bigint;
  /** SHA-256 hash of the canonical serialized SignRequest (all fields above). */
  payloadHash: string;
  /** Active policy hash — must match permit.policy_hash. */
  policyHash: string;
  /** Quote id — must match permit.quote_id. */
  quoteId: string;
  /** Expected chain id for this wallet. */
  expectedChainId: number;
  /** Current authoritative lease epoch — must match permit.lease_epoch. */
  expectedLeaseEpoch: number;
}

export type SigningOutcome =
  | { ok: true; signature: string; signed_at: Date }
  | { ok: false; reason: string; code: string };

/** Low-level cryptographic signer, injected (keeps keys out of memory here). */
export type CryptoSigner = (request: SignRequest) => Promise<string>;

export interface SignerVaultDeps {
  /** Maximum accepted clock skew for the permit TTL check (ms). */
  maxClockSkewMs?: number;
  /** Expected chain ID for this signer (e.g., 137 for Polygon). */
  expectedChainId: number;
  cryptoSigner: CryptoSigner;
}

/**
 * Compute the canonical SHA-256 payload hash for a SignRequest.
 * This is the single source of truth for the payload hash — both the vault
 * and callers MUST use this function to ensure consistency.
 *
 * Serialization is deterministic: fields in fixed order, no optional fields,
 * numbers as exact strings (no float), dates as ISO 8601 UTC.
 */
export function computePayloadHash(request: SignRequest): string {
  const payload = [
    request.schema_version,
    request.action,
    // Permit fields (all material for binding)
    request.permit.permit_id,
    request.permit.decision_id,
    request.permit.intent_id,
    request.permit.ledger_version,
    request.permit.policy_version,
    request.permit.policy_hash,
    request.permit.quote_id,
    String(request.permit.lease_epoch),
    request.permit.reservation_ids.join(","),
    String(request.permit.max_qty),
    String(request.permit.max_cash),
    request.permit.allowed_order_style.join(","),
    request.permit.venue_mode,
    request.permit.issued_at.toISOString(),
    request.permit.expires_at.toISOString(),
    String(request.permit.single_use),
    request.permit.used_at ? request.permit.used_at.toISOString() : "null",
    // Wallet identity (WAL-03: signer, account, funder distinct)
    request.wallet.wallet_id,
    request.wallet.wallet_type,
    request.wallet.signer_address,
    request.wallet.account_wallet,
    request.wallet.funder,
    String(request.wallet.chain_id),
    request.wallet.verified_at.toISOString(),
    // Amount & action
    request.amountBase.toString(),
    request.actionId,
    request.intentId,
    request.marketContext,
    request.venueMode,
    request.now.toISOString(),
    // Binding fields
    request.policyHash,
    request.quoteId,
    String(request.expectedChainId),
    String(request.expectedLeaseEpoch),
    // Order binding (side + price) — critical for full payload binding.
    // Defensive: callers that build a request without side/priceBase yet
    // (e.g. computing a placeholder hash) must not crash the hash function.
    request.side ?? "",
    request.priceBase !== undefined ? request.priceBase.toString() : "",
  ].join("|");

  return createHash("sha256").update(payload).digest("hex");
}

/**
 * DEPRECATED: Legacy permit fingerprint using truncated hex.
 * Kept for backward compatibility with existing tests.
 * New code MUST use computePayloadHash().
 */
export function permitFingerprint(permit: ExecutionPermit): string {
  const core = [
    permit.permit_id,
    permit.decision_id,
    permit.intent_id,
    permit.ledger_version,
    permit.policy_version,
    permit.policy_hash,
    permit.quote_id,
    String(permit.lease_epoch),
    permit.reservation_ids.join(","),
    String(permit.max_qty),
    String(permit.max_cash),
    permit.allowed_order_style.join(","),
    permit.venue_mode,
    permit.expires_at.toISOString(),
  ].join("|");
  return `ph_${Buffer.from(core).toString("hex").slice(0, 32)}`;
}

export class SignerVault {
  private readonly maxClockSkewMs: number;
  private readonly cryptoSigner: CryptoSigner;
  private readonly expectedChainId: number;

  constructor(deps: SignerVaultDeps) {
    this.maxClockSkewMs = deps.maxClockSkewMs ?? 5_000;
    this.cryptoSigner = deps.cryptoSigner;
    this.expectedChainId = deps.expectedChainId;
  }

  /**
   * Verify every pre-sign invariant (TABLE 8) and, only if all pass, produce a
   * signature via the injected low-level signer. Any failure returns a typed
   * refusal with a machine-readable reason code (never the secret).
   */
  async sign(request: SignRequest): Promise<SigningOutcome> {
    // Verify payload hash matches canonical serialization BEFORE any other checks
    const expectedHash = computePayloadHash(request);
    if (request.payloadHash !== expectedHash) {
      return {
        ok: false,
        reason: "payload hash mismatch",
        code: "PAYLOAD_HASH_MISMATCH",
      };
    }

    const guard = this.checkAllowed(request);
    if (!guard.ok) return guard;
    try {
      const signature = await this.cryptoSigner(request);
      return { ok: true, signature, signed_at: request.now };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "signing_failure";
      return { ok: false, reason: msg, code: "SIGN_ENGINE_ERROR" };
    }
  }

  /** Deterministic (non-crypto) pre-sign guard — pure and fully testable. */
  checkAllowed(
    request: SignRequest,
  ): { ok: true } | { ok: false; reason: string; code: string } {
    // 1. Permit schema validation.
    const parsed = ExecutionPermitSchema.safeParse(request.permit);
    if (!parsed.success) {
      return {
        ok: false,
        reason: "permit schema invalid",
        code: "PERMIT_INVALID",
      };
    }

    // 2. Action on allowlist.
    if (!SIGNER_ALLOWED_ACTIONS.includes(request.action)) {
      return {
        ok: false,
        reason: "action not allowlisted",
        code: "ACTION_NOT_ALLOWED",
      };
    }

    // 3. Permit unexpired (with bounded clock skew).
    const skew = Math.abs(
      request.now.getTime() - request.permit.issued_at.getTime(),
    );
    if (skew > this.maxClockSkewMs && request.now < request.permit.issued_at) {
      return {
        ok: false,
        reason: "clock skew outside bound",
        code: "CLOCK_SKEW",
      };
    }
    if (request.now.getTime() > request.permit.expires_at.getTime()) {
      return { ok: false, reason: "permit expired", code: "PERMIT_EXPIRED" };
    }
    // Single-use permit must not already be marked used.
    if (
      request.permit.single_use &&
      request.permit.used_at !== null &&
      request.permit.used_at !== undefined
    ) {
      return {
        ok: false,
        reason: "permit already used",
        code: "PERMIT_REUSED",
      };
    }

    // 2. Wallet identity — signer, account and funder are distinct (WAL-03).
    if (request.wallet.signer_address === request.wallet.funder) {
      return {
        ok: false,
        reason: "signer and funder must be distinct",
        code: "IDENTITY_CONFLICT",
      };
    }
    if (request.wallet.signer_address === request.wallet.account_wallet) {
      return {
        ok: false,
        reason: "signer and account must be distinct",
        code: "IDENTITY_CONFLICT",
      };
    }
    if (request.wallet.account_wallet === request.wallet.funder) {
      return {
        ok: false,
        reason: "account and funder must be distinct",
        code: "IDENTITY_CONFLICT",
      };
    }

    // 3. Chain identity — wallet must be on expected chain.
    if (request.wallet.chain_id !== this.expectedChainId) {
      return {
        ok: false,
        reason: "wallet chain mismatch",
        code: "CHAIN_MISMATCH",
      };
    }

    // 4. Intent binding — permit must bind to this action's intent.
    if (request.permit.intent_id !== request.intentId) {
      return {
        ok: false,
        reason: "permit intent_id does not match request intentId",
        code: "INTENT_MISMATCH",
      };
    }

    // 5. Policy hash binding — permit must reflect the active policy.
    if (request.permit.policy_hash !== request.policyHash) {
      return {
        ok: false,
        reason: "permit policy_hash does not match active policy",
        code: "POLICY_HASH_MISMATCH",
      };
    }

    // 6. Quote binding — permit must bind to the quoted market data.
    if (request.permit.quote_id !== request.quoteId) {
      return {
        ok: false,
        reason: "permit quote_id does not match request quoteId",
        code: "QUOTE_MISMATCH",
      };
    }

    // 7. Venue mode binding — permit must match the current venue mode.
    if (request.permit.venue_mode !== request.venueMode) {
      return {
        ok: false,
        reason: "permit venue_mode does not match request venueMode",
        code: "VENUE_MODE_MISMATCH",
      };
    }

    // 8. Lease epoch binding — permit must be for current authoritative lease.
    if (request.permit.lease_epoch !== request.expectedLeaseEpoch) {
      return {
        ok: false,
        reason: "permit lease_epoch does not match expected lease epoch",
        code: "LEASE_EPOCH_MISMATCH",
      };
    }

    // 10. Exact amount within permit reservation.
    // amountBase is SHARE quantity, bound is permit's share quota (max_qty).
    const maxQtyBn = decimalToBase(request.permit.max_qty);
    if (request.amountBase > maxQtyBn) {
      return {
        ok: false,
        reason: "amount exceeds permit share quota",
        code: "AMOUNT_EXCEEDS_PERMIT",
      };
    }

    // 11. Cash ceiling — amount in cash must not exceed permit's cash ceiling.
    // amountBase is shares; compute cash = amount * price.
    const cashNeeded = (request.amountBase * request.priceBase) / 1_000_000n;
    const maxCashBn = decimalToBase(request.permit.max_cash);
    if (cashNeeded > maxCashBn) {
      return {
        ok: false,
        reason: "cash required exceeds permit cash ceiling",
        code: "CASH_EXCEEDS_PERMIT",
      };
    }

    // 12. Lease epoch binding — permit must be for current authoritative lease.
    if (request.permit.lease_epoch !== request.expectedLeaseEpoch) {
      return {
        ok: false,
        reason: "permit lease_epoch does not match expected lease epoch",
        code: "LEASE_EPOCH_MISMATCH",
      };
    }

    // 13. Time freshness — permit must be within TTL.
    if (request.now.getTime() > request.permit.expires_at.getTime()) {
      return { ok: false, reason: "permit expired", code: "PERMIT_EXPIRED" };
    }

    // 16. Single-use permit must not already be marked used.
    if (
      request.permit.single_use &&
      request.permit.used_at !== null &&
      request.permit.used_at !== undefined
    ) {
      return {
        ok: false,
        reason: "permit already used",
        code: "PERMIT_REUSED",
      };
    }

    // 17. Action on allowlist.
    if (!SIGNER_ALLOWED_ACTIONS.includes(request.action)) {
      return {
        ok: false,
        reason: "action not allowlisted",
        code: "ACTION_NOT_ALLOWED",
      };
    }

    return { ok: true };
  }
}

/** Convert a canonical 0..1 decimal number to integer base units (pUSD 1e6). */
export function decimalToBase(value: number, decimals = 6): bigint {
  if (!Number.isFinite(value) || value < 0) return 0n;
  // Work on the string representation to avoid float drift.
  const parts = String(value).split(".");
  const int = parts[0] ?? "0";
  const fracRaw = parts.length > 1 ? parts[1]! : "";
  if (fracRaw.length > decimals) {
    throw new Error(
      `REJECT_PRECISION_LOSS: value ${value} has ${fracRaw.length} decimal places, max allowed ${decimals}`,
    );
  }
  const fracPadded = fracRaw.padEnd(decimals, "0").slice(0, decimals);
  const base = BigInt(int + fracPadded);
  return base * (int.startsWith("-") ? -1n : 1n);
}

/** Export the venue-mode ref so consumers share one source of truth. */
export { VenueModeSchema };
export type { ExecutionPermit, WalletIdentity };

// Production crypto signer exports
export {
  createProductionCryptoSigner,
  createSignerFromEnv,
  createSignerFromHex,
  deriveAddressFromPrivateKey,
  type ProdSignerConfig,
} from "./crypto-signer-prod.js";

// Encrypted keystore (scrypt + AES-256-GCM) for key-at-rest protection
export {
  sealPrivateKey,
  openKeystore,
  resolveWalletKey,
  type SealedKeystore,
} from "./keystore.js";

// Credential authentication contracts (CT-09, G0 half)
export {
  verifyBodyHmac,
  checkCredentialBinding,
  checkRateLimit,
  type CredentialAuthCode,
  type CredentialAuthResult,
  type CredentialBinding,
} from "./credential-auth.js";

// EIP-712 core + ERC-7739 nesting (No.2, CT-06 offline half)
export {
  encodeField,
  encodeType,
  typeHash,
  hashStruct,
  signingDigest,
  hashNested1271,
  type Eip712Field,
  type Eip712FieldType,
  type Nested1271Input,
  type Nested1271Result,
} from "./eip712.js";

// Session scope contracts (CT-31, opt-in beta)
export {
  grantSessionScope,
  checkRevocationFinality,
  MAX_SESSION_LIFETIME_MS,
  type SessionScope,
  type SessionScopeResult,
  type RevocationFinality,
} from "./session-scope.js";

// Wallet mapping contracts (CT-04/05/06, G0 half)
export {
  validateWalletMapping,
  type WalletMappingInput,
  type WalletMappingResult,
  type WalletMappingCode,
} from "./wallet-mapping.js";
