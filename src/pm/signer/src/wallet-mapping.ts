/**
 * @polyroot/signer — Wallet mapping contracts (CT-04, CT-05, CT-06, G0 half).
 *
 * Offline (G0) acceptance for wallet-type signing paths:
 *
 *   CT-04 POLY_PROXY — owner/funder/proxy mapping must be present and
 *           consistent before any signature is considered.
 *   CT-05 GNOSIS_SAFE — safe/funder mapping must be present and consistent.
 *   CT-06 POLY_1271 — nested typed-data / ERC-7739 wrapping is REQUIRED.
 *           The current signer has no 1271 wrapper (a documented upstream
 *           gap), so POLY_1271 resolves to a typed UNSUPPORTED refusal —
 *           never a silent EOA-shaped signature. Per Blueprint, an untested
 *           mandatory signature type stays unsupported-for-LIVE.
 *
 * All wallet types additionally require WAL-03 distinctness
 * (signer/account/funder pairwise distinct). The authenticated-acceptance
 * halves (venue acceptance, G4) need live credentials and stay NOT_RUN.
 *
 * Pure functions (no I/O).
 */

import type { WalletIdentity } from "@polyroot/domain";

export type WalletMappingCode =
  | "WALLET_NOT_DISTINCT"
  | "PROXY_MAPPING_INCOMPLETE"
  | "SAFE_MAPPING_INCOMPLETE"
  | "POLY_1271_UNSUPPORTED";

export type WalletMappingResult =
  | { ok: true; note: string }
  | { ok: false; code: WalletMappingCode; reason: string };

export interface WalletMappingInput {
  wallet: Pick<
    WalletIdentity,
    "wallet_type" | "signer_address" | "account_wallet" | "funder"
  >;
  /**
   * Whether this deployment provides a nested typed-data / ERC-7739
   * wrapper for POLY_1271. Defaults to false (current status).
   */
  supports1271?: boolean;
}

function distinct(
  wallet: WalletMappingInput["wallet"],
): WalletMappingResult | null {
  const { signer_address: s, account_wallet: a, funder: f } = wallet;
  if (!s || !a || !f) {
    return {
      ok: false,
      code: "WALLET_NOT_DISTINCT",
      reason: "signer, account and funder must all be present",
    };
  }
  if (s === a || s === f || a === f) {
    return {
      ok: false,
      code: "WALLET_NOT_DISTINCT",
      reason: "signer, account and funder must be pairwise distinct (WAL-03)",
    };
  }
  return null;
}

/**
 * Validate the owner/funder/address mapping for a wallet type before any
 * signing path is selected. Returns the selected signing path on success.
 */
export function validateWalletMapping(
  input: WalletMappingInput,
): WalletMappingResult {
  const bad = distinct(input.wallet);
  if (bad) return bad;

  switch (input.wallet.wallet_type) {
    case "EOA":
      return { ok: true, note: "EOA direct signing path" };
    case "POLY_PROXY":
      // Owner/funder/proxy mapping: the account wallet is the proxy, and
      // it must differ from both owner-signer and funder (checked above).
      // Presence of all three bound addresses is the G0 contract.
      return {
        ok: true,
        note: "proxy mapping complete: owner/funder/proxy bound",
      };
    case "GNOSIS_SAFE":
      return { ok: true, note: "safe mapping complete: safe/funder bound" };
    case "POLY_1271":
      if (input.supports1271 !== true) {
        return {
          ok: false,
          code: "POLY_1271_UNSUPPORTED",
          reason:
            "POLY_1271 requires a nested typed-data / ERC-7739 wrapper which this build does not provide; unsupported-for-LIVE",
        };
      }
      return { ok: true, note: "1271 wrapper present" };
    default:
      return {
        ok: false,
        code: "WALLET_NOT_DISTINCT",
        reason: `unknown wallet type: ${String(input.wallet.wallet_type)}`,
      };
  }
}
