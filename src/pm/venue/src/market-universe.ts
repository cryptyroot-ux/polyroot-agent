/**
 * @polyroot/venue — Explicit market universe for live/SHADOW loops.
 *
 * The agent never discovers markets by itself: the owner curates the exact
 * CLOB token ids via POLYROOT_MARKET_IDS. Empty or malformed universes
 * refuse fail-closed so a loop can never fall back to mock data with real
 * money configured.
 */

import { isClobAssetId } from "./order-translation.js";

/** Parse + validate the owner-curated universe. Throws on any defect. */
export function readMarketUniverse(env: {
  POLYROOT_MARKET_IDS?: string;
}): string[] {
  const raw = env.POLYROOT_MARKET_IDS ?? "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) {
    throw new Error(
      "MARKET_UNIVERSE_MISSING: POLYROOT_MARKET_IDS must list at least one CLOB token id for SHADOW/MICRO_LIVE/LIVE",
    );
  }
  const bad = ids.filter((id) => !isClobAssetId(id));
  if (bad.length > 0) {
    throw new Error(
      `MARKET_UNIVERSE_INVALID: not CLOB asset ids: ${bad.join(", ")}`,
    );
  }
  return [...new Set(ids)];
}

/** Live price source backing collectLiveInputs (venue-backed in prod). */
export interface MarketSource {
  universe(): string[];
  snapshot(marketId: string): Promise<{ bid: number; ask: number } | null>;
}

export interface LiveMarketInput {
  market_id: string;
  bid: number;
  ask: number;
}

/**
 * Build one pass of live inputs. Markets without finite prices are
 * skipped (fail-closed per market); the loop continues with the rest.
 */
export async function collectLiveInputs(
  source: MarketSource,
): Promise<LiveMarketInput[]> {
  const inputs: LiveMarketInput[] = [];
  for (const market_id of source.universe()) {
    const snap = await source.snapshot(market_id);
    if (!snap || !Number.isFinite(snap.bid) || !Number.isFinite(snap.ask)) {
      continue;
    }
    inputs.push({ market_id, bid: snap.bid, ask: snap.ask });
  }
  return inputs;
}
