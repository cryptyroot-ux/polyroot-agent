/**
 * @polyroot/runtime — Autonomy bounds (approved LIVE safety spec).
 *
 * Single source of truth for autonomous-trading guardrails. Defaults are
 * fixed in code; the owner may override them ONLY via the authenticated
 * `polyroot setup` CLI, which writes explicit env vars. The AI execution
 * path is read-only for bounds: it consumes resolved values, never writes.
 */

/** Approved defaults. DAILY_LOSS_CAP_BPS 500 = -5% equity/day. */
export const AUTONOMY_BOUNDS = {
  CAPITAL_CAP_USD: 1000,
  DAILY_LOSS_CAP_BPS: 500,
  ALLOWED_VENUE: "POLYMARKET_CLOB_CTF_V2",
  MAX_ORDER_USD: 100,
  MAX_CONCURRENT_ORDERS: 3,
} as const;

/**
 * Resolve an absolute loss cap (pUSD) from capital and basis points.
 * Returns undefined for non-finite/non-positive inputs (fail-closed).
 */
export function resolveLossCapPusd(
  capitalUsd: number,
  bps: number,
): number | undefined {
  if (!Number.isFinite(capitalUsd) || capitalUsd <= 0) return undefined;
  if (!Number.isFinite(bps) || bps <= 0) return undefined;
  return Math.floor((capitalUsd * bps) / 10_000);
}

export interface ParsedBoundsEnv {
  capUsd?: number;
  lossCapPusd?: number;
}

/**
 * Parse owner-set bound overrides. Invalid values are dropped (undefined),
 * so callers fail closed instead of trading on a misconfigured cap.
 */
export function parseBoundsEnv(env: NodeJS.ProcessEnv): ParsedBoundsEnv {
  const capRaw = env["POLYROOT_MICRO_LIVE_CAP_USD"];
  const lossRaw = env["POLYROOT_MICRO_LIVE_LOSS_CAP_USD"];
  const capUsd = capRaw === undefined ? undefined : Number(capRaw);
  const lossCapPusd = lossRaw === undefined ? undefined : Number(lossRaw);
  return {
    ...(capUsd !== undefined && Number.isFinite(capUsd) && capUsd > 0
      ? { capUsd }
      : {}),
    ...(lossCapPusd !== undefined &&
    Number.isFinite(lossCapPusd) &&
    lossCapPusd > 0
      ? { lossCapPusd }
      : {}),
  };
}
