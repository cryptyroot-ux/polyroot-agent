/**
 * @polyroot/control — Release verdict (Phase 30, PRD §10 + Blueprint §15).
 *
 * Turns the promotion evidence into ONE auditable decision. Tiers:
 *
 *   GO_PAPER  — unit gates green (fault contracts, SDK offline contracts,
 *               traceability, CI). Paper trading needs no live evidence.
 *   GO_SHADOW — GO_PAPER plus shadow evidence plumbing proven.
 *   NO_GO_LIVE — anything live-facing stays blocked until live evidence
 *               exists: 30-day prospective observation, real fills,
 *               KMS wiring, and the 1271 wrapper. This function can never
 *               emit a LIVE go on unit evidence alone — that would be the
 *               exact false-confidence failure the PRD forbids.
 *
 * Pure function (no I/O): CI feeds it measured counts, it returns the
 * verdict with named open items.
 */

export interface ReleaseEvidence {
  faultCovered: number;
  faultTotal: number;
  sdkOfflineCovered: number;
  sdkOfflineTotal: number;
  tracePass: number;
  traceTotal: number;
  ciGreen: boolean;
  shadowPlumbingProven: boolean;
  liveObservationDays: number;
  liveFillsObserved: number;
  kmsWired: boolean;
  wrapper1271Present: boolean;
}

export type ReleaseVerdict =
  | { tier: "GO_PAPER" | "GO_SHADOW"; reasons: string[] }
  | { tier: "NO_GO"; reasons: string[]; openItems: string[] };

const REQUIRED_LIVE_DAYS = 30;

/**
 * Compute the release verdict. Unit gates are individually named so a
 * single red gate blocks with its own reason — never a bare "not ready".
 */
export function releaseVerdict(ev: ReleaseEvidence): ReleaseVerdict {
  const blockers: string[] = [];
  if (ev.faultCovered < ev.faultTotal)
    blockers.push(
      `fault contracts ${ev.faultCovered}/${ev.faultTotal} incomplete`,
    );
  if (ev.sdkOfflineCovered < ev.sdkOfflineTotal)
    blockers.push(
      `SDK offline contracts ${ev.sdkOfflineCovered}/${ev.sdkOfflineTotal} incomplete`,
    );
  if (ev.tracePass < ev.traceTotal)
    blockers.push(
      `traceability ${ev.tracePass}/${ev.traceTotal} failing`,
    );
  if (!ev.ciGreen) blockers.push("CI gate red (typecheck/lint/test/build)");
  if (blockers.length > 0) {
    return {
      tier: "NO_GO",
      reasons: blockers,
      openItems: [...blockers],
    };
  }

  const liveOpen: string[] = [];
  if (ev.liveObservationDays < REQUIRED_LIVE_DAYS)
    liveOpen.push(
      `prospective observation ${ev.liveObservationDays}/${REQUIRED_LIVE_DAYS} days`,
    );
  if (ev.liveFillsObserved <= 0)
    liveOpen.push("no authenticated live fills observed");
  if (!ev.kmsWired) liveOpen.push("KMS/HSM signing path not wired");
  if (!ev.wrapper1271Present)
    liveOpen.push("POLY_1271 wrapper absent (fresh-install default)");

  if (ev.shadowPlumbingProven && liveOpen.length > 0) {
    return {
      tier: "GO_SHADOW",
      reasons: [
        "unit gates green; shadow plumbing proven; live evidence pending",
        ...liveOpen.map((item) => `live-blocker: ${item}`),
      ],
    };
  }
  if (liveOpen.length === 0 && ev.shadowPlumbingProven) {
    return {
      tier: "GO_SHADOW",
      reasons: [
        "unit gates green; live evidence present — final owner sign-off still required out of band",
      ],
    };
  }
  return {
    tier: "GO_PAPER",
    reasons: [
      "unit gates green for PAPER autonomy",
      ...liveOpen.map((item) => `beyond-paper: ${item}`),
    ],
  };
}
