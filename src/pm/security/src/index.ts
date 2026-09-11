/**
 * @polyroot/security — Research quarantine boundary (PR-SEC-02, T-PR-SEC-02, G2-G7).
 *
 * High-risk retrieval/parsing runs in a low-privilege research boundary.
 * Privileged forecasting/strategy receives normalized evidence objects, never
 * raw executable content or trading secrets. If a retrieval worker is
 * compromised it cannot reach executor/signing/private-db roles.
 */

export type Resource =
  | "market_data"
  | "evidence_store"
  | "executor"
  | "signer_vault"
  | "private_db"
  | "strategy";

/** Resources a compromised research worker is allowed to touch. */
const RESEARCH_ALLOWED: ReadonlySet<string> = new Set(["market_data", "evidence_store"]);

/**
 * Fail-closed boundary: the research process may only access its two allowed
 * resources. Everything else — executor, signer vault, private DB, strategy —
 * is denied, even when the research worker is fully compromised.
 */
export class ResearchBoundary {
  canAccess(resource: string): boolean {
    return RESEARCH_ALLOWED.has(resource);
  }
}

export interface RawEvidenceInput {
  url: string;
  rawHtml?: string;
  rawText?: string;
  claim: string;
  sourceFamily: string;
  fetchedAt: Date;
  contentHash: string;
}

export interface NormalizedEvidence {
  /** Structured, safe fields only — never raw executable content. */
  sourceUrl: string;
  claim: string;
  sourceFamily: string;
  fetchedAt: Date;
  contentHash: string;
  /** External content is data only; it can never become an instruction. */
  untrusted: true;
}

/**
 * Transform raw retrieval output into a minimal structured evidence object.
 * Raw HTML/text and any command-like payload never cross the boundary.
 */
export function normalizeEvidence(input: RawEvidenceInput): NormalizedEvidence {
  // Only fields needed by forecasting/strategy are carried; raw content is dropped.
  return {
    sourceUrl: input.url,
    claim: input.claim,
    sourceFamily: input.sourceFamily,
    fetchedAt: input.fetchedAt,
    contentHash: input.contentHash,
    untrusted: true,
  };
}

/** Redact candidate secrets from any payload keyed with secret-like names. */
export function redactSecrets(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    out[k] = /secret|token|key|password|credential|private_key|signature|mnemonic/i.test(k)
      ? "REDACTED"
      : v;
  }
  return out;
}