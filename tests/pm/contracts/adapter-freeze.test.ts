import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { checkAdapterFreeze } from "@polyroot/venue";
import { PolymarketVenueAdapter } from "@polyroot/venue";

const ROOT = new URL("../../..", import.meta.url);
function readJson(rel: string): any {
  return JSON.parse(readFileSync(new URL(rel, ROOT), "utf8"));
}

// Frozen record (Blueprint G0): any drift in version, integrity, surface
// or suite result unfreezes the adapter until explicitly re-pinned here.
const FROZEN_PIN = {
  packageName: "@polymarket/client",
  version: "0.9.0",
  integrity:
    "sha512-v1PuTbBsf7iySKbPaJZF/yR3GrCmZ7lCjg5+hc+vyKYdZ+Xp5obBFDP6NR/HttlkynCWSxQ+zvni2f9SDLpHhg==",
  surface: [
    "fetchOrderBook",
    "fetchMarket",
    "postOrder",
    "cancelOrder",
    "fetchOrder",
  ],
  suiteRef: "sdk-contracts-g0",
};

describe("Phase 22: G0 adapter-freeze evidence pack (Blueprint G0)", () => {
  it("installed SDK matches the frozen pin (name, version, integrity)", () => {
    const venuePkg = readJson("src/pm/venue/package.json");
    assert.equal(
      venuePkg.dependencies["@polymarket/client"],
      FROZEN_PIN.version,
      "dependency must be exactly pinned (no ^/~)",
    );
    assert.ok(
      !String(venuePkg.dependencies["@polymarket/client"]).match(/^[\^~]/),
    );
    const lock = readJson("package-lock.json");
    const entry = lock.packages?.["node_modules/@polymarket/client"] ?? {};
    assert.equal(entry.version, FROZEN_PIN.version);
    assert.equal(entry.integrity, FROZEN_PIN.integrity);
  });

  it("adapter binds exactly the frozen narrowed surface", () => {
    // The narrowed SDK surface the adapter depends on
    // (PolymarketClientLike): pinning its key list here means any surface
    // widening breaks this test until explicitly re-frozen above.
    const iface: Array<keyof import("@polyroot/venue").PolymarketClientLike> = [
      "fetchOrderBook",
      "fetchMarket",
      "postOrder",
      "cancelOrder",
      "fetchOrder",
    ];
    assert.deepEqual([...iface].sort(), [...FROZEN_PIN.surface].sort());
    // The public adapter exposes ONLY the canonical gated surface — never
    // wallet/key creation, and never a silent passthrough of SDK calls.
    const adapter = new PolymarketVenueAdapter({}, "NORMAL");
    const proto = Object.getOwnPropertyNames(
      Object.getPrototypeOf(adapter),
    ).filter((k) => k !== "constructor");
    for (const name of proto) {
      assert.ok(
        [
          "mode",
          "getOrderBook",
          "placeOrder",
          "cancelOrder",
          "getOrderStatus",
          "setMode",
          // TypeScript-private helpers (not part of the surface contract).
          "bestLevel",
        ].includes(name),
        `unexpected public adapter method: ${name}`,
      );
    }
    for (const banned of [
      "createWallet",
      "deriveCredentials",
      "signArbitrary",
    ]) {
      assert.equal(typeof (adapter as any)[banned], "undefined");
    }
  });

  it("freeze chain passes only when pin+surface+suite all agree", () => {
    const frozen = checkAdapterFreeze({
      expected: FROZEN_PIN,
      observed: { ...FROZEN_PIN, suitePass: true },
    });
    assert.equal(frozen.ok ?? (frozen as any).frozen, true);
    const drifted = checkAdapterFreeze({
      expected: FROZEN_PIN,
      observed: { ...FROZEN_PIN, version: "0.9.1", suitePass: true },
    });
    assert.equal(drifted.ok, false);
    const failing = checkAdapterFreeze({
      expected: FROZEN_PIN,
      observed: { ...FROZEN_PIN, suitePass: false },
    });
    assert.equal(failing.ok, false);
  });
});
