import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PolymarketVenueAdapter, type PolymarketClientLike } from "@polyroot/venue";

function makeFakeClient(): PolymarketClientLike {
  return {
    fetchOrderBook: async () => ({
      market: "0xabc",
      asset_id: "123",
      timestamp: Date.now(),
      bids: [{ price: "0.4", size: "100" }],
      asks: [{ price: "0.6", size: "120" }],
    }),
  };
}

describe("PR-EXE-02: Polymarket VenueAdapter binds the pinned official SDK", () => {
  it("getOrderBook maps SDK best bid/ask into MarketSnapshot yes/no prices", async () => {
    const adapter = new PolymarketVenueAdapter(makeFakeClient());
    const snap = await adapter.getOrderBook("0xabc");
    assert.equal(snap.market_id, "0xabc");
    assert.equal(snap.yes_price, 0.4);
    assert.equal(snap.no_price, 0.6);
    assert.ok(snap.source_at instanceof Date);
    assert.ok(snap.received_at instanceof Date);
  });

  it("defaults to NORMAL and setMode narrows venue mode deterministically", () => {
    const adapter = new PolymarketVenueAdapter(makeFakeClient());
    assert.equal(adapter.mode, "NORMAL");
    adapter.setMode("CANCEL_ONLY");
    assert.equal(adapter.mode, "CANCEL_ONLY");
    adapter.setMode("UNKNOWN");
    assert.equal(adapter.mode, "UNKNOWN");
  });

  it("placeOrder fails closed when the venue mode forbids ORDER_SUBMIT", async () => {
    const adapter = new PolymarketVenueAdapter(makeFakeClient());
    adapter.setMode("CANCEL_ONLY");
    const res = await adapter.placeOrder({
      order_id: "o1", market_id: "m1", side: "BUY", price: 0.5, size: 1, salt: "s", signature: "0x", signer: "0x1", funder: "0x2", expiration: 1, nonce: 1,
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "MODE_FORBIDS");
  });

  it("placeOrder succeeds in NORMAL mode and maps the venue order id", async () => {
    const client: PolymarketClientLike = {
      fetchOrderBook: async () => ({ bids: [], asks: [] }),
      postOrder: async () => ({ success: true, orderID: "venue_123" }),
    };
    const adapter = new PolymarketVenueAdapter(client);
    const res = await adapter.placeOrder({
      order_id: "o1", market_id: "m1", side: "BUY", price: 0.5, size: 1, salt: "s", signature: "0x", signer: "0x1", funder: "0x2", expiration: 1, nonce: 1,
    });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.result.order_id, "venue_123");
  });
});