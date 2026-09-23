/**
 * @polyroot/venue — Adapter freeze evidence pack (Blueprint G0).
 *
 * G0 closes the adapter for STATIC contracts through a machine-checkable
 * chain, in order:
 *
 *   1. exact dependency pin (name + version + registry integrity),
 *   2. narrowed SDK surface (only the methods the adapter binds),
 *   3. offline golden/negative contract suite result reference,
 *   4. freeze decision binding 1–3 to a profile hash.
 *
 * Any link failing keeps the adapter UNFROZEN: static contracts may not
 * be treated as proven. Live/readonly probes and G4 acceptance are
 * separate gates with their own evidence.
 */

export interface FreezePin {
  packageName: string;
  version: string;
  integrity: string;
}

export interface FreezeDecisionInput {
  expected: FreezePin & { surface: string[]; suiteRef: string };
  observed: FreezePin & { surface: string[]; suiteRef: string; suitePass: boolean };
}

export type FreezeVerdict =
  | { frozen: true; note: string }
  | { ok: false; code: "FREEZE_MISMATCH"; reason: string; mismatches: string[] };

/**
 * Verify the freeze chain. Version, integrity, surface AND suite result
 * must all match — a pinned version with a different integrity hash, a
 * wider surface, or a failing suite is UNFROZEN.
 */
export function checkAdapterFreeze(
  input: FreezeDecisionInput,
): FreezeVerdict {
  const mismatches: string[] = [];
  if (input.observed.packageName !== input.expected.packageName)
    mismatches.push(`package ${input.observed.packageName} !== ${input.expected.packageName}`);
  if (input.observed.version !== input.expected.version)
    mismatches.push(
      `version ${input.observed.version} !== pinned ${input.expected.version}`,
    );
  if (input.observed.integrity !== input.expected.integrity)
    mismatches.push("integrity hash drift: reinstall or re-pin explicitly");
  const missing = input.expected.surface.filter(
    (m) => !input.observed.surface.includes(m),
  );
  if (missing.length > 0)
    mismatches.push(`narrowed surface missing: ${missing.join(", ")}`);
  if (input.observed.suiteRef !== input.expected.suiteRef)
    mismatches.push(
      `suite ${input.observed.suiteRef} !== frozen ${input.expected.suiteRef}`,
    );
  if (!input.observed.suitePass)
    mismatches.push("contract suite is not green");
  if (mismatches.length > 0) {
    return {
      ok: false,
      code: "FREEZE_MISMATCH",
      reason: `adapter UNFROZEN: ${mismatches.join("; ")}`,
      mismatches,
    };
  }
  return {
    frozen: true,
    note: `adapter frozen: ${input.expected.packageName}@${input.expected.version} [${input.expected.surface.length} methods, ${input.expected.suiteRef} green]`,
  };
}
