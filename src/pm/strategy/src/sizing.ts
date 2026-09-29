/**
 * @polyroot/strategy — Position sizing (PM-STR-09).
 *
 * Fractional-Kelly sizing for binary outcomes, capped so it can only
 * shrink — never grow — the legacy fixed size. Pure, no I/O.
 *
 * For a YES token quoted at price q with true probability p > q, the
 * full-Kelly bankroll fraction is f* = (p − q) / (1 − q) (standard binary
 * Kelly: even odds q=0.5, p=0.6 → f* = 0.2). We stake a fraction of that
 * (quarter-Kelly default) because the "true" p is an LLM estimate, and
 * estimation error is the classic Kelly ruin vector (Thorp, MacLean).
 */

/** Fractional-Kelly bankroll fraction for a binary outcome. 0 when no edge. */
export function kellyFraction(
  p: number,
  price: number,
  fraction = 0.25,
): number {
  if (
    !Number.isFinite(p) ||
    !Number.isFinite(price) ||
    !Number.isFinite(fraction)
  ) {
    return 0;
  }
  if (p <= price || price <= 0 || price >= 1 || fraction <= 0) return 0;
  const full = (p - price) / (1 - price);
  if (full <= 0) return 0;
  return full * fraction;
}

/**
 * Shares to buy: Kelly stake converted at the touch price, rounded down,
 * floored at `minShares` (default 1 — a $100 account can always afford one
 * share) and hard-capped at `maxShares` (the legacy fixed size: sizing may
 * only shrink entries, never grow them past what the old code staked).
 */
export function kellyShares(input: {
  p: number;
  price: number;
  bankrollUsd: number;
  fraction?: number;
  minShares?: number;
  maxShares?: number;
}): number {
  const {
    p,
    price,
    bankrollUsd,
    fraction = 0.25,
    minShares = 1,
    maxShares = 100,
  } = input;
  if (!Number.isFinite(bankrollUsd) || bankrollUsd <= 0) return 0;
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return 0;
  const f = kellyFraction(p, price, fraction);
  if (f <= 0) return 0;
  const stakeUsd = f * bankrollUsd;
  const shares = Math.floor(stakeUsd / price);
  if (shares < minShares) return 0;
  return Math.min(shares, Math.max(maxShares, minShares));
}
