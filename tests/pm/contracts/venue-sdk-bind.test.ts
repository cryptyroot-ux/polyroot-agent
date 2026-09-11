import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PolymarketVenueAdapter } from "@polyroot/venue";

/** Minimal fake of @polymarket/client@0.9.0 public client surface used by the adapter. */
function makeFakeClient() {
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
  it("getOrderBook maps the SDK best bid/ask to MarketSnapshot yes/no prices", async () => {
    const adapter = new PolymarketVenueAdapter(makeFakeClient() as never);
    const snap = await adapter.getOrderBook("0xabc");
    assert.equal(snap.market_id, "0xabc");
    assert.equal(snap.yes_price, 0.4); // best bid = YES price
    assert.equal(snap.no_price, 0.6); // best ask = NO price
  });

  it("mode defaults to NORMAL and setMode narrows venue mode", () => {
    const adapter = new PolymarketVenueAdapter(makeFakeClient() as never);
    assert.equal(adapter.mode, "NORMAL");
    adapter.setMode("CANCEL_ONLY");
    assert.equal(adapter.mode, "CANCEL_ONLY");
    adapter.setMode("UNKNOWN");
    assert.equal(adapter.mode, "UNKNOWN");
  });

  it("placeOrder is refused (fail closed) unless venue mode permits ORDER_SUBMIT", async () => {
    const adapter = new PolymarketVenueAdapter(makeFakeClient() as never);
    adapter.setMode("CANCEL_ONLY");
    const res = await adapter.placeOrder({ order_id: "o1" } as never);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "MODE_FORBIDS");
  });

  it("placeOrder succeeds in NORMAL mode and maps the venue order id", async () => {
    const client = {
      fetchOrderBook: async () => ({ bids: [], asks: [] }),
      postOrder: async () => ({ success: true, orderID: "venue_123" }),
    };
    const adapter = new PolymarketVenueAdapter(client as never, "NORMAL");
    const res = await adapter.placeOrder({ order_id: "o1" } as never);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.result.order_id, "venue_123");
  });
});