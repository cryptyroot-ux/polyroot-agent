/**
 * @polyroot/signer — Canonical payload hash (leaf module).
 *
 * Lives here (not in index.ts) so crypto-signer-prod can import it WITHOUT
 * creating an index ⇄ producer import cycle. index.ts re-exports it, so
 * every existing import path keeps working.
 */
import { createHash } from "node:crypto";
import type { SignRequest } from "./index.js";

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
