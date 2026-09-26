import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filterTightSpreadTokens,
  parseDiscoveryBounds,
  parseGammaEvents,
  parseMarketPick,
  resolveMarketUniverse,
  selectLiquidMarkets,
  type DiscoveredMarket,
} from "@polyroot/venue";

const sample = [
  {
    markets: [
      {
        question: "Will BTC hit $100k?",
        slug: "btc-100k",
        clobTokenIds: '["111","222"]',
        volume24hr: "5000",
      },
      {
        question: "Broken market",
        slug: "broken",
        clobTokenIds: "not-json",
        volume24hr: "10",
      },
    ],
  },
];

const mk = (q: string): DiscoveredMarket => ({
  question: q,
  slug: q,
  yesTokenId: "1",
  noTokenId: "2",
  volume24h: 0,
});

describe("market discovery (pick by name)", () => {
  it("parses Gamma events, skips defective markets", () => {
    const out = parseGammaEvents(sample);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.question, "Will BTC hit $100k?");
    assert.equal(out[0]?.yesTokenId, "111");
    assert.equal(out[0]?.noTokenId, "222");
    assert.equal(out[0]?.volume24h, 5000);
  });

  it("returns [] for non-array payloads", () => {
    assert.deepEqual(parseGammaEvents(null), []);
    assert.deepEqual(parseGammaEvents({}), []);
  });

  it("parses number picks and 'all'", () => {
    const markets = [mk("a"), mk("b"), mk("c")];
    assert.deepEqual(
      parseMarketPick("1,3", markets).map((m) => m.question),
      ["a", "c"],
    );
    assert.equal(parseMarketPick("all", markets).length, 3);
    assert.deepEqual(parseMarketPick("", markets), []);
  });

  it("rejects out-of-range picks", () => {
    assert.throws(() => parseMarketPick("9", [mk("a")]), /invalid pick/);
    assert.throws(() => parseMarketPick("abc", [mk("a")]), /invalid pick/);
  });

  it("selects liquid markets top-N by volume", () => {
    const ms: DiscoveredMarket[] = [
      { ...mk("low"), volume24h: 100 },
      { ...mk("mid"), volume24h: 50_000 },
      { ...mk("high"), volume24h: 200_000 },
    ];
    const out = selectLiquidMarkets(ms, {
      minVolume24h: 10_000,
      maxMarkets: 1,
    });
    assert.deepEqual(
      out.map((m) => m.question),
      ["high"],
    );
  });

  it("falls back to safe discovery defaults", () => {
    assert.deepEqual(parseDiscoveryBounds({}), {
      minVolume24h: 10_000,
      maxMarkets: 5,
      maxSpread: 0.1,
    });
    assert.deepEqual(
      parseDiscoveryBounds({
        POLYROOT_DISCOVERY_MIN_VOLUME_24H: "-5",
        POLYROOT_DISCOVERY_MAX_MARKETS: "999",
        POLYROOT_DISCOVERY_MAX_SPREAD: "99",
      }),
      { minVolume24h: 10_000, maxMarkets: 20, maxSpread: 0.5 },
    );
  });

  it("keeps only tokens within max spread (stubbed books)", async () => {
    const markets = [mk("a"), mk("b")];
    const out = await filterTightSpreadTokens(markets, 0.1, async (id) =>
      id === "1"
        ? { tokenId: id, bid: 0.5, ask: 0.55 }
        : { tokenId: id, bid: 0.001, ask: 0.999 },
    );
    // Both markets share stub ids "1"/"2": only token "1" survives per market.
    assert.equal(out.length, 2);
    assert.deepEqual(out[0]?.tokenIds, ["1"]);
  });

  it("manual mode still uses curated ids (no network)", async () => {
    const out = await resolveMarketUniverse({
      POLYROOT_MARKET_IDS: "123,456",
    });
    assert.deepEqual(out, ["123", "456"]);
  });

  it("manual mode still refuses empty universes", async () => {
    await assert.rejects(() => resolveMarketUniverse({}), /MISSING/);
  });
});
