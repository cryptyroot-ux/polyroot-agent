/**
 * @polyroot/venue — Protocol profile resolution (CT-11, CT-12, CT-13).
 *
 * CLOB generation, settlement protocol, asset encoding and SDK release
 * live on SEPARATE fields: a "V2" label in one dimension never implies
 * compatibility in another. Resolution is explicit and fail-closed —
 *
 *   CT-11 CTF market profile  — CTF asset kinds resolve to the CTF profile.
 *   CT-12 PolyV2 position profile — structured PolyV2 assetIds resolve to
 *           the PolyV2 profile (never coerced to a CTF integer).
 *   CT-13 no legacy V1 fallback — V1 and unknown profiles are BLOCKED.
 *           There is no silent downgrade to a legacy surface.
 *
 * Pure functions (no I/O): the adapter calls these before any SDK use.
 */

export type ProtocolProfile = "CTF" | "POLY_V2";

export type ProfileResolution =
  | { ok: true; profile: ProtocolProfile; note: string }
  | { ok: false; code: "PROFILE_BLOCKED"; reason: string };

export interface AssetProfileInput {
  /** Protocol surface version claimed by the venue metadata. */
  version?: string | undefined;
  /** Asset kind from venue metadata (e.g. "CTF", "POLY_V2", "ERC1155"). */
  assetKind?: string | undefined;
  /** Structured PolyV2 asset identifier, when present. */
  assetId?: string | undefined;
}

function norm(value: string | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

/**
 * Resolve the protocol profile for an asset. V1 and anything unrecognized
 * are BLOCKED — the caller must not fall back to a legacy surface.
 */
export function resolveProtocolProfile(
  input: AssetProfileInput,
): ProfileResolution {
  const version = norm(input.version);
  const kind = norm(input.assetKind);

  if (version === "V1" || kind === "V1" || kind === "LEGACY") {
    return {
      ok: false,
      code: "PROFILE_BLOCKED",
      reason: "legacy V1 profile is not supported; no fallback permitted",
    };
  }

  // Structured PolyV2 asset ids resolve to the PolyV2 profile as-is —
  // never coerced into a CTF integer.
  if (kind === "POLY_V2" || (input.assetId ?? "").startsWith("polyv2:")) {
    return {
      ok: true,
      profile: "POLY_V2",
      note: "structured PolyV2 asset identity preserved",
    };
  }
  if (kind === "CTF" || kind === "ERC1155") {
    return { ok: true, profile: "CTF", note: "CTF market profile" };
  }
  if (version === "V2" && kind === "") {
    // A bare "V2" label without an asset kind proves nothing about which
    // surface it names (order, settlement, or encoding generation).
    return {
      ok: false,
      code: "PROFILE_BLOCKED",
      reason: "bare V2 label without asset kind is not a resolvable profile",
    };
  }
  return {
    ok: false,
    code: "PROFILE_BLOCKED",
    reason: `unrecognized protocol profile (version=${input.version ?? "?"}, kind=${input.assetKind ?? "?"})`,
  };
}
