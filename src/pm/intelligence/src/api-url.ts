/**
 * @polyroot/intelligence — URL helpers (leaf module).
 *
 * Lives here (not in index.ts) so forecast-provider can import them WITHOUT
 * creating an index ⇄ producer import cycle. index.ts re-exports both, so
 * every existing import path keeps working.
 */

export function joinApiPath(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const p = path.replace(/^\/+/, "");
  if (base.endsWith("/v1") && p.startsWith("v1/"))
    return `${base}/${p.slice(3)}`;
  return `${base}/${p}`;
}

export function normalizeOpenAICompatible(
  baseUrl?: string,
  fallback = "https://api.openai.com/v1",
): string {
  if (!baseUrl || baseUrl.length === 0) return fallback;
  return baseUrl.replace(/\/+$/, "");
}
