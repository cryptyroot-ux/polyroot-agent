/**
 * @polyroot/venue — Redeem target contracts (CT-27, PM-EXE-08).
 *
 * Redemption requires ALL of: final (non-disputed) resolution, a resolved
 * protocol profile (CTF or PolyV2 — never legacy/unknown), and a receipt
 * shape the ledger can post exactly once. A disputed market, an
 * unresolvable profile, or a missing receipt refuses with a typed code —
 * never a best-effort redeem against the wrong target.
 */

import { resolveProtocolProfile } from "./protocol-profile.js";

export type RedeemVerdict =
  | { ok: true; target: "CTF" | "POLY_V2"; note: string }
  | {
      ok: false;
      code:
        | "REDEEM_DISPUTED"
        | "REDEEM_NOT_FINAL"
        | "REDEEM_PROFILE_BLOCKED"
        | "REDEEM_NO_RECEIPT";
      reason: string;
    };

export function validateRedeemTarget(input: {
  resolutionFinal: boolean;
  disputed: boolean;
  version?: string | undefined;
  assetKind?: string | undefined;
  assetId?: string | undefined;
  /** Whether a postable receipt is available for the redemption. */
  hasReceipt: boolean;
}): RedeemVerdict {
  if (!input.resolutionFinal) {
    return {
      ok: false,
      code: "REDEEM_NOT_FINAL",
      reason: "resolution is not final; redeem refused",
    };
  }
  if (input.disputed) {
    return {
      ok: false,
      code: "REDEEM_DISPUTED",
      reason: "market is disputed; redeem refused until resolved",
    };
  }
  const profile = resolveProtocolProfile({
    version: input.version,
    assetKind: input.assetKind,
    assetId: input.assetId,
  });
  if (!profile.ok) {
    return {
      ok: false,
      code: "REDEEM_PROFILE_BLOCKED",
      reason: `redeem target unresolvable: ${profile.reason}`,
    };
  }
  if (!input.hasReceipt) {
    return {
      ok: false,
      code: "REDEEM_NO_RECEIPT",
      reason: "no postable redemption receipt available",
    };
  }
  return {
    ok: true,
    target: profile.profile,
    note: `redeem against ${profile.profile} target with receipt`,
  };
}
