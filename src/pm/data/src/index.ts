/**
 * @polyroot/data — Market data plane (PM-DATA-01..06).
 * Pure primitives only: asset identity, settlement rules gate, order book
 * resync, fee gate, evidence provenance, data-quality checks. No I/O.
 */
import {
  type AssetIdentity,
  type CatalystEvent,
  type DataQualityFlags,
  type EvidenceItem,
  type MarketFeeSettings,
  type SettlementRule,
} from "@polyroot/domain";

/* ─── PM-DATA-01: typed asset identity ───────────────────────────────── */

export type ParsedAsset =
  | {
      kind: "CTF";
      asset_class: "CTF_TOKEN";
      token_id: string;
      chain_id: number;
      address: string;
    }
  | {
      kind: "POLY_V2";
      asset_class: "POLY_V2_POSITION";
      position_id: string;
      chain_id: number;
    }
  | { kind: "UNKNOWN"; asset_class: "UNKNOWN"; raw: string };

/**
 * Parse an asset id without assuming it is a CTF integer token (PM-DATA-01).
 * - CTF proxy token: numeric tokenId under an ERC-1155 proxy/conditional token.
 * - PolyV2 position: non-numeric opaque position id.
 * Both go through the same typed `AssetIdentity` contract downstream.
 */
export function parseAssetIdentity(raw: string, chainId: number): ParsedAsset {
  if (/^\d+$/.test(raw)) {
    return {
      kind: "CTF",
      asset_class: "CTF_TOKEN",
      token_id: raw,
      chain_id: chainId,
      address: raw,
    };
  }
  if (
    /^[0-9a-fA-F]{64}$/.test(raw) ||
    /^position:[0-9a-fA-FxX:]+$/i.test(raw)
  ) {
    return {
      kind: "POLY_V2",
      asset_class: "POLY_V2_POSITION",
      position_id: raw,
      chain_id: chainId,
    };
  }
  return { kind: "UNKNOWN", asset_class: "UNKNOWN", raw };
}

/** Registry of known protocol profiles; unknown profiles reject signing. */
export class ProtocolProfileRegistry {
  private readonly known = new Map<string, AssetIdentity>();
  register(profile: AssetIdentity): void {
    this.known.set(profile.protocol_profile_id, profile);
  }
  has(profileId: string): boolean {
    return this.known.has(profileId);
  }
  requireKnown(profileId: string): AssetIdentity {
    const hit = this.known.get(profileId);
    if (!hit) {
      const e = new Error(`UNKNOWN_PROTOCOL_PROFILE: ${profileId}`) as Error & {
        code: string;
      };
      e.code = "UNKNOWN_PROTOCOL_PROFILE";
      throw e;
    }
    return hit;
  }
}

/* ─── PM-DATA-02: settlement rules gate ──────────────────────────────── */

export type RulesGateResult =
  | { ok: true; rule: SettlementRule }
  | {
      ok: false;
      code: "RULES_CHANGED";
      expectedVersion: string;
      currentVersion: string;
    };

/* ─── PM-DATA-03: order book with resync ─────────────────────────────── */

/* ─── PM-DATA-04: fee gate ───────────────────────────────────────────── */

export type FeeGateResult =
  | { ok: true; settings: MarketFeeSettings }
  | { ok: false; code: "FEE_UNKNOWN" };

/* ─── PM-DATA-05: evidence provenance ────────────────────────────────── */

/**
 * Provenance check (PM-DATA-05): evidence fetched after a decision cutoff must
 * not participate in that decision's replay.
 */
export function provenByCutoff(
  evidence: EvidenceItem,
  cutoffUtc: Date,
): boolean {
  const at = evidence.available_at ?? evidence.fetched_at;
  return at.getTime() <= cutoffUtc.getTime();
}

/* ─── PM-DATA-06: data quality ───────────────────────────────────────── */

const STALE_AFTER_MS = 15 * 60 * 1000;

/** Distinguish a literal zero from missing; detect syndication duplicates. */
export function assessQuality(input: {
  price: number | null;
  observed_at: Date;
  now: Date;
  canonicalUrl?: string;
  seenFamilies: Map<string, string>;
  requestBudgetOk: boolean;
  contradiction?: boolean;
  url?: string;
}): DataQualityFlags {
  const familyKey = (input.canonicalUrl ?? input.url ?? "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("?")[0];
  let family: string | undefined;
  let duplicateOf: string | undefined;
  if (familyKey) {
    const existing = input.seenFamilies.get(familyKey);
    if (existing) {
      family = existing;
      duplicateOf = family;
    } else {
      family = familyKey;
      input.seenFamilies.set(familyKey, familyKey);
    }
  }
  const observedZero = input.price === 0;
  const missing = input.price === null;
  return {
    schema_version: "1.0.0",
    is_stale:
      input.now.getTime() - input.observed_at.getTime() > STALE_AFTER_MS &&
      input.price !== null,
    has_contradiction: input.contradiction ?? false,
    syndication_family: family,
    is_duplicate_of: duplicateOf,
    request_budget_exhausted: !input.requestBudgetOk,
    data_missing: missing,
    observed_zero: observedZero,
    notes: [],
  };
}

/**
 * Sanity: reject a synthetic contradiction — a single source family may not
 * emit two different prices without a correction.
 */
export function contradicts(prices: number[]): boolean {
  if (prices.length < 2) return false;
  const first = prices[0] as number;
  return prices.some((p) => Math.abs(p - first) > 1e-9);
}

/* ─── Catalyst passthrough types (used by intelligence plane) ────────── */

export type { CatalystEvent };
/* ─── PR-DATA-07: full universe decision log ─────────────────────────────── */

export interface MarketDecision {
  id: string;
  ticker: string;
  eligible: boolean;
  reason?: string;
  decidedAt: Date;
}

export interface DecideInput {
  metadataOk: boolean;
  liquidityOk: boolean;
  rulesOk?: boolean;
}

/** Deterministic eligibility decider — every rejection carries a reason code. */
export class UniverseDecider {
  decide(id: string, input: DecideInput): MarketDecision {
    const now = new Date();
    if (!input.metadataOk) {
      return {
        id,
        ticker: id,
        eligible: false,
        reason: "metadata_missing",
        decidedAt: now,
      };
    }
    if (!input.rulesOk) {
      return {
        id,
        ticker: id,
        eligible: false,
        reason: "rules_unclear",
        decidedAt: now,
      };
    }
    if (!input.liquidityOk) {
      return {
        id,
        ticker: id,
        eligible: false,
        reason: "no_depth",
        decidedAt: now,
      };
    }
    return { id, ticker: id, eligible: true, decidedAt: now };
  }
}

/* ─── PM-DATA-07: market/event graph ─────────────────────────────────── */

export * from "./graph.js";

/* ─── Exports for live-feed ────────────────────────────────────────── */

export * from "@polyroot/domain";
export {
  SettlementRulesRegistry,
  OrderBook,
  FeeGate,
  UniverseLog,
} from "./book-primitives.js";
export * from "./live-feed.js";
export * from "./frame-freshness.js";
export * from "./stream-frames.js";
export * from "./graph.js";
