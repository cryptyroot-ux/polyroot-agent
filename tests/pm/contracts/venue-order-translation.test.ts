import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { translateDomainOrderToLimit } from "@polyroot/venue";

const BASE = {
  schema_version: "1.1",
  order_id: "00000000-0000-4000-8000-000000000001",
  side: "BUY",
  price: 0.55,
  size: 10,
  fee_rate_bps: 0,
  signature: "0xsig",
  signer: "0x" + "1".repeat(40),
  signed_at: new Date(0),
} as const;

describe("domain to CLOB limit-order translation", () => {
  it("translates a LIMIT order with a hex asset id", () => {
    const res = translateDomainOrderToLimit({
      ...BASE,
      market_id: "0x" + "ab".repeat(32),
      order_type: "LIMIT",
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.request.assetId, "0x" + "ab".repeat(32));
      assert.equal(res.request.price, 0.55);
      assert.equal(res.request.size, 10);
      assert.equal(res.request.side, "BUY");
      assert.equal(res.request.postOnly, false);
    }
  });

  it("maps POST_ONLY to postOnly", () => {
    const res = translateDomainOrderToLimit({
      ...BASE,
      market_id: "12345",
      order_type: "POST_ONLY",
    });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.request.postOnly, true);
  });

  it("refuses opaque market ids", () => {
    for (const market_id of ["mkt_abc", "mock_market_1", ""]) {
      const res = translateDomainOrderToLimit({ ...BASE, market_id });
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, "VENUE_MARKET_UNRESOLVED");
    }
  });

  it("refuses FOK/IOC, expirations, and bad price/size", () => {
    const fok = translateDomainOrderToLimit({
      ...BASE,
      market_id: "123",
      order_type: "FOK",
    });
    assert.equal(fok.ok, false);
    if (!fok.ok) assert.equal(fok.code, "VENUE_ORDER_TYPE_UNSUPPORTED");

    const exp = translateDomainOrderToLimit({
      ...BASE,
      market_id: "123",
      expiration: 9999999999,
    });
    assert.equal(exp.ok, false);
    if (!exp.ok) assert.equal(exp.code, "VENUE_EXPIRATION_UNSUPPORTED");

    const badPrice = translateDomainOrderToLimit({
      ...BASE,
      market_id: "123",
      price: 1.5,
    });
    assert.equal(badPrice.ok, false);
    if (!badPrice.ok) assert.equal(badPrice.code, "VENUE_PRICE_INVALID");

    const badSize = translateDomainOrderToLimit({
      ...BASE,
      market_id: "123",
      size: 0,
    });
    assert.equal(badSize.ok, false);
    if (!badSize.ok) assert.equal(badSize.code, "VENUE_SIZE_INVALID");
  });
});
