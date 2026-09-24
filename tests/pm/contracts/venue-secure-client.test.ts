import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildLiveVenueAdapter,
  buildSdkSigner,
  PolymarketVenueAdapter,
  readSecureClientEnv,
} from "@polyroot/venue";

describe("secure venue client factory", () => {
  it("refuses when the wallet key is missing", () => {
    assert.throws(() => readSecureClientEnv({}), /SECURE_CLIENT_ENV_MISSING/);
  });

  it("refuses when API credentials are missing", () => {
    assert.throws(
      () =>
        readSecureClientEnv({
          PRIVATE_KEY_HEX: "0x" + "1".repeat(64),
          WALLET_ACCOUNT: "0x" + "2".repeat(40),
          RPC_URL: "https://polygon-rpc.com",
        }),
      /POLYMARKET_API_KEY/,
    );
  });

  it("builds an offline-capable signer whose address derives from the key", async () => {
    const key = "0x" + "3".repeat(64);
    const signer = buildSdkSigner(key, "https://polygon-rpc.com");
    const address = await signer.getAddress();
    assert.match(address, /^0x[0-9a-fA-F]{40}$/);
    const sig = await signer.signMessage("polyroot-probe");
    assert.match(sig, /^0x[0-9a-f]{130}$/);
  });

  it("passes wallet, credentials, and signer to the injected client creator", async () => {
    let seen: unknown;
    const adapter = await buildLiveVenueAdapter(
      {
        PRIVATE_KEY_HEX: "0x" + "4".repeat(64),
        WALLET_ACCOUNT: "0x" + "5".repeat(40),
        RPC_URL: "https://polygon-rpc.com",
        POLYMARKET_API_KEY: "key",
        POLYMARKET_API_SECRET: "secret",
        POLYMARKET_API_PASSPHRASE: "phrase",
      },
      {
        createClient: (async (opts: unknown) => {
          seen = opts;
          return {};
        }) as never,
      },
    );
    assert.ok(adapter instanceof PolymarketVenueAdapter);
    const opts = seen as Record<string, unknown>;
    assert.equal(opts["wallet"], "0x" + "5".repeat(40));
    assert.deepEqual(opts["credentials"], {
      key: "key",
      secret: "secret",
      passphrase: "phrase",
    });
    assert.equal(
      typeof (opts["signer"] as Record<string, unknown>)["getAddress"],
      "function",
    );
  });

  it("refuses domain-shaped orders without touching the venue client", async () => {
    let called = 0;
    const adapter = new PolymarketVenueAdapter({
      postOrder: async () => {
        called += 1;
        return { success: true, orderID: "must-not-happen" };
      },
    });
    const res = await adapter.placeOrder({
      order_id: "o1",
      market_id: "m1",
      side: "BUY",
      price: 0.5,
      size: 1,
    } as never);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "VENUE_ORDER_SHAPE_UNSUPPORTED");
    assert.equal(called, 0);
  });

  it("passes CLOB-shaped orders through to the venue client", async () => {
    let seen: unknown;
    const adapter = new PolymarketVenueAdapter({
      postOrder: async (order: unknown) => {
        seen = order;
        return { success: true, orderID: "venue_1" };
      },
    });
    const clobOrder = {
      maker: "0x" + "1".repeat(40),
      takerAmount: "1000000",
      makerAmount: "500000",
      tokenId: "123",
      salt: "1",
      expiration: 9999999999,
      side: 0,
      orderType: 0,
      signatureType: 0,
      signer: "0x" + "1".repeat(40),
      signature: "0x" + "2".repeat(130),
      timestamp: "1",
      builder: "0x" + "0".repeat(40),
      metadata: "0x",
    };
    const res = await adapter.placeOrder(clobOrder as never);
    assert.equal(res.ok, true);
    assert.equal(seen, clobOrder);
  });
});
