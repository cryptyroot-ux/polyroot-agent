import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseActivityTrades,
  buildTokenFlows,
  parseWatchlist,
  startSmartMoneySync,
} from "@polyroot/venue";
import { groupArbEvents, startArbScan } from "@polyroot/venue";

const W = "0x924379a79c64b77ad5816ad362122a5f6228658e";

function tradeRow(over: Record<string, unknown> = {}) {
  return {
    proxyWallet: W,
    timestamp: 1790602268,
    conditionId: "0xabc",
    type: "TRADE",
    size: 100,
    usdcSize: 51,
    transactionHash: `0x${Math.random().toString(16).slice(2).padEnd(64, "0")}`,
    price: 0.51,
    asset: "tokA",
    side: "BUY",
    outcomeIndex: 0,
    title: "T",
    ...over,
  };
}

describe("smart-money feed (venue)", () => {
  it("parses live-shape TRADE rows, skips the rest", () => {
    const rows = parseActivityTrades(
      [
        tradeRow({ transactionHash: "0xdup" }),
        tradeRow({ type: "REDEEM", transactionHash: "0xredeem" }),
        tradeRow({ side: "HOLD", transactionHash: "0xhold" }),
        tradeRow({ asset: "", transactionHash: "0xnoasset" }),
        tradeRow({
          proxyWallet: "0x1111111111111111111111111111111111111111",
          transactionHash: "0xforeign",
        }),
        tradeRow({ transactionHash: "0xdup" }),
      ],
      W,
    );
    // duplicate tx (same hash twice) dedupes: only the first counts
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.tokenId, "tokA");
    assert.equal(rows[0]?.side, "BUY");
  });

  it("buildTokenFlows nets buys vs sells inside the lookback", () => {
    const now = 1790602268 * 1000;
    const trades = [
      {
        tokenId: "tokA",
        side: "BUY",
        price: 0.5,
        sizeShares: 100,
        usdcSize: 50,
        timestampMs: now - 1000,
        txHash: "0x1",
      },
      {
        tokenId: "tokA",
        side: "SELL",
        price: 0.6,
        sizeShares: 100,
        usdcSize: 60,
        timestampMs: now - 2000,
        txHash: "0x2",
      },
      {
        tokenId: "tokA",
        side: "BUY",
        price: 0.5,
        sizeShares: 10,
        usdcSize: 5,
        timestampMs: now - 48 * 3600_000,
        txHash: "0x3",
      },
    ] as never;
    const flows = buildTokenFlows(trades, 24 * 3600_000, now);
    const f = flows.get("tokA");
    assert.ok(f);
    assert.equal(f.netFlowUsd, -10);
    assert.equal(f.buyUsd, 50);
    assert.equal(f.sellUsd, 60);
    assert.equal(f.trades, 2);
  });

  it("parseWatchlist validates, dedupes and caps", () => {
    assert.deepEqual(parseWatchlist(undefined), []);
    assert.deepEqual(parseWatchlist("nope, 0x123"), []);
    assert.deepEqual(parseWatchlist(`${W}, ${W.toUpperCase()}`), [W]);
    const many = Array.from(
      { length: 25 },
      (_, i) => `0x${i.toString(16).padStart(40, "0")}`,
    ).join(",");
    assert.equal(parseWatchlist(many).length, 20);
  });

  it("sync merges wallets per token and counts corroboration", async () => {
    const other = "0x1111111111111111111111111111111111111111";
    const byWallet: Record<string, ReturnType<typeof tradeRow>[]> = {
      [W]: [tradeRow({ transactionHash: "0xw1" })],
      [other]: [
        tradeRow({
          proxyWallet: other,
          transactionHash: "0xw2",
          side: "SELL",
          usdcSize: 2000,
        }),
      ],
    };
    const handle = startSmartMoneySync({
      wallets: [W, other],
      lookbackMs: 7 * 24 * 3600_000,
      fetchTrades: async (w) => {
        const rows = byWallet[w] ?? [];
        const { parseActivityTrades: parse } = await import("@polyroot/venue");
        return parse(rows, w, Date.now());
      },
    });
    try {
      await handle.tick();
      const f = handle.getFlow("tokA");
      assert.ok(f);
      // +51 − 2000 = −1949 across 2 wallets
      assert.equal(f.netFlowUsd, 51 - 2000);
      assert.equal(f.wallets, 2);
      assert.equal(handle.getFlow("tokMissing"), undefined);
    } finally {
      handle.stop();
    }
  });

  it("wallet failure degrades to partial data, never throws", async () => {
    let err = "";
    const handle = startSmartMoneySync({
      wallets: [W],
      fetchTrades: async () => {
        throw new Error("data-api down");
      },
      onError: (e) => {
        err = e.message;
      },
    });
    try {
      await handle.tick();
      assert.equal(handle.getFlow("tokA"), undefined);
      assert.ok(err.includes("data-api down"));
    } finally {
      handle.stop();
    }
  });
});

describe("arb scan (observation only)", () => {
  const events = (markets: unknown[]) => [{ id: "ev1", markets }];

  it("groups multi-outcome events, skips singles and closed legs", () => {
    const grouped = groupArbEvents(
      events([
        { closed: false, clobTokenIds: '["t1","t1n"]' },
        { closed: false, clobTokenIds: '["t2","t2n"]' },
        { closed: true, clobTokenIds: '["t3","t3n"]' },
      ]),
    );
    assert.equal(grouped.length, 1);
    assert.deepEqual(grouped[0]?.yesTokens, ["t1", "t2"]);
    assert.equal(groupArbEvents(events([{ closed: false, clobTokenIds: '["t1","t1n"]' }])).length, 0);
    assert.deepEqual(groupArbEvents("nope"), []);
  });

  it("tick records valid baskets, skips partial ones, survives errors", async () => {
    const inserted: unknown[] = [];
    const pool = {
      query: async (text: string) => {
        if (text.startsWith("INSERT INTO arb_observations")) {
          inserted.push(text);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [] };
      },
    };
    const prices: Record<string, number> = { t1: 0.2, t2: 0.25, t3: 0.3 };
    const handle = startArbScan({
      pool: pool as never,
      fetchEvents: async () =>
        events([
          { closed: false, clobTokenIds: '["t1","t1n"]' },
          { closed: false, clobTokenIds: '["t2","t2n"]' },
          { closed: false, clobTokenIds: '["t3","t3n"]' },
        ]),
      readTouch: async (id) =>
        prices[id] === undefined ? null : { yesPrice: prices[id] as number },
    });
    const s = await handle.tick();
    assert.equal(s.eventsScanned, 1);
    assert.equal(s.tokensRead, 3);
    assert.equal(s.observations, 1);
    assert.equal(inserted.length, 1);
    handle.stop();

    // Partial basket (one unreadable leg) is not a basket.
    const partial = startArbScan({
      pool: pool as never,
      fetchEvents: async () =>
        events([
          { closed: false, clobTokenIds: '["t1","t1n"]' },
          { closed: false, clobTokenIds: '["t9","t9n"]' },
        ]),
      readTouch: async (id) => (id === "t1" ? { yesPrice: 0.2 } : null),
    });
    try {
      const s2 = await partial.tick();
      assert.equal(s2.observations, 0);
    } finally {
      partial.stop();
    }
  });

  it("skips events already observed within the hour (no dup flood)", async () => {
    let inserts = 0;
    const pool = {
      query: async (text: string) => {
        if (text.startsWith("INSERT INTO arb_observations")) {
          inserts += 1;
          return { rows: [], rowCount: 1 };
        }
        // Recent-observation check: pretend ev1 was just logged.
        return { rows: [{ "?column?": 1 }] };
      },
    };
    const book: Record<string, number> = { t1: 0.2, t2: 0.25, t3: 0.3 };
    const handle = startArbScan({
      pool: pool as never,
      fetchEvents: async () =>
        events([
          { closed: false, clobTokenIds: '["t1","t1n"]' },
          { closed: false, clobTokenIds: '["t2","t2n"]' },
          { closed: false, clobTokenIds: '["t3","t3n"]' },
        ]),
      readTouch: async (id) =>
        book[id] === undefined ? null : { yesPrice: book[id] as number },
    });
    try {
      const s = await handle.tick();
      assert.equal(s.eventsScanned, 1);
      assert.equal(s.observations, 0);
      assert.equal(inserts, 0);
    } finally {
      handle.stop();
    }
  });
});
