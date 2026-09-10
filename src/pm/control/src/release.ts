/**
 * @polyroot/control — Release manifest registry (PR-GOV-01, T-PR-GOV-01, G0-G1).
 *
 * Controlled fork baseline: pins the upstream commit, exact dependency hashes,
 * SDK versions, migrations and schema_version. Every active upstream financial
 * path must have an explicit disposition; an unresolved REMOVE path rejects
 * the release.
 */

import { z } from "zod";

/** Disposition of an upstream/reused path. REMOVE must not be resolved=true. */
export const DispositionSchema = z.enum(["KEEP", "ADAPT", "REWRITE", "REMOVE", "QUARANTINE"]);
export type Disposition = z.infer<typeof DispositionSchema>;

const DepInput = z.object({
  version: z.string().min(1),
  resolved: z.boolean(),
  disposition: DispositionSchema,
});
const DepResolved = DepInput.extend({ resolved: z.literal(true), disposition: DispositionSchema.exclude(["REMOVE"]) });

export const ReleaseManifestSchema = z.object({
  schema_version: z.string().min(1),
  upstream: z.object({
    repo: z.string().min(1),
    commit: z.string().min(1),
    license: z.string().min(1),
  }),
  dependencies: z.record(z.string(), DepInput),
  migrations: z.array(z.string().min(1)).min(1),
  schema_version_db: z.string().min(1),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

export function parseReleaseManifest(
  json: string,
): { ok: true; manifest: ReleaseManifest } | { ok: false; reason: string } {
  try {
    const raw: unknown = JSON.parse(json);
    const parsed = ReleaseManifestSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, reason: parsed.error.message };
    }
    return { ok: true, manifest: parsed.data };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "parse error" };
  }
}

export function assertDependencyResolved(
  manifest: ReleaseManifest,
  depName: string,
): { ok: boolean; reason?: string } {
  const dep = manifest.dependencies[depName];
  if (!dep) return { ok: false, reason: `missing dependency disposition: ${depName}` };
  if (!dep.resolved) return { ok: false, reason: `unresolved dependency: ${depName} (${dep.disposition})` };
  if (dep.disposition === "REMOVE") {
    return { ok: false, reason: `REMOVED path still marked active: ${depName}` };
  }
  return { ok: true };
}

/** Convenience: every record in `dependencies` must be resolved & non-REMOVE. */
export function allDependenciesResolved(manifest: ReleaseManifest): { ok: boolean; reason?: string } {
  for (const name of Object.keys(manifest.dependencies)) {
    const res = assertDependencyResolved(manifest, name);
    if (!res.ok) return res;
  }
  return { ok: true };
}