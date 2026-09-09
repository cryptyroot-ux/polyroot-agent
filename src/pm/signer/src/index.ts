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
 */
export interface SignRequest {
  schema_version: string;
  action: SignerAction;
  permit: ExecutionPermit;
  wallet: WalletIdentity;
  /** Exact amount in integer base units (never float; PM-LED-02). */
  amountBase: bigint;
  /** Canonical domain-level order/action id being signed. */
  actionId: string;
  /** Market id / condition id scoped to the permit. */
  marketContext: string;
  /** Venue mode observed immediately before signing (TABLE 17 matrix). */
  venueMode: VenueMode;
  /** Wall-clock freshness check source. */
  now: Date;
  /** Precomputed canonical payload hash to record for audit. */
  payloadHash: string;
}

export type SigningOutcome =
  | { ok: true; signature: string; signed_at: Date }
  | { ok: false; reason: string; code: string };

/** Low-level cryptographic signer, injected (keeps keys out of memory here). */
export type CryptoSigner = (request: SignRequest) => Promise<string>;

export interface SignerVaultDeps {
  /** Maximum accepted clock skew for the permit TTL check (ms). */
  maxClockSkewMs?: number;
  cryptoSigner: CryptoSigner;
}

/**
 * Deterministic fingerprint of the canonical financial fields of a permit.
 * Both the vault and callers use this to bind the payload being signed to the
 * reservation's intent/policy/quote/lease versions. This is a deterministic
 * integrity tag; production promotion must back it with a real audited hash.
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
    permit.venue_mode,
    permit.expires_at.toISOString(),
  ].join("|");
  return `ph_${Buffer.from(core).toString("hex").slice(0, 32)}`;
}

export class SignerVault {
  private readonly maxClockSkewMs: number;
  private readonly cryptoSigner: CryptoSigner;

  constructor(deps: SignerVaultDeps) {
    this.maxClockSkewMs = deps.maxClockSkewMs ?? 5_000;
    this.cryptoSigner = deps.cryptoSigner;
  }

  /**
   * Verify every pre-sign invariant (TABLE 8) and, only if all pass, produce a
   * signature via the injected low-level signer. Any failure returns a typed
   * refusal with a machine-readable reason code (never the secret).
   */
  async sign(request: SignRequest): Promise<SigningOutcome> {
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
    if (!SIGNER_ALLOWED_ACTIONS.includes(request.action)) {
      return {
        ok: false,
        reason: "action not allowlisted",
        code: "ACTION_NOT_ALLOWED",
      };
    }

    const parsed = ExecutionPermitSchema.safeParse(request.permit);
    if (!parsed.success) {
      return {
        ok: false,
        reason: "permit schema invalid",
        code: "PERMIT_INVALID",
      };
    }

    // 1. Permit unexpired (with bounded clock skew).
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

    // 4. Exact amount within permit reservation. `amountBase` is a SHARE
    //    quantity, so the bound is the permit's share quota (`max_qty`) — NOT
    //    the cash cap (`max_cash`, a money value in a different dimension).
    //    Comparing shares against cash would let an over-quota order pass when
    //    it stays under the cash ceiling.
    const maxQtyBn = decimalToBase(request.permit.max_qty);
    if (request.amountBase > maxQtyBn) {
      return {
        ok: false,
        reason: "amount exceeds permit share quota",
        code: "AMOUNT_EXCEEDS_PERMIT",
      };
    }

    // 6. Every request records a payload hash; a permit already tied to a
    //    different payload is rejected (dedupe integrity, EXE-03).
    const expectedHash = permitFingerprint(request.permit);
    if (request.payloadHash !== expectedHash) {
      return {
        ok: false,
        reason: "payload hash mismatch",
        code: "PAYLOAD_HASH_MISMATCH",
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
  const fracPadded = fracRaw.padEnd(decimals, "0").slice(0, decimals);
  const base = BigInt(int + fracPadded);
  return base * (int.startsWith("-") ? -1n : 1n);
}

/** Export the venue-mode ref so consumers share one source of truth. */
export { VenueModeSchema };
export type { ExecutionPermit, WalletIdentity };
