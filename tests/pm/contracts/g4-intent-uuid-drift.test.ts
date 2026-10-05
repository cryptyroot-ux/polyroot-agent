import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SignerVault } from "@polyroot/signer";
import { buildSignedOrder } from "@polyroot/control";
import type {
  ExecutionPermit,
  WalletIdentity,
  TradeIntent,
} from "@polyroot/domain";
import { randomUUID } from "crypto";

/**
 * Task 01a107f0 point (4): does the second `crypto.randomUUID()` that g4-core
 * passes to `buildSignedOrder` ever reach the SignerVault?
 *
 * We wire the REAL `buildSignedOrder` against a spy CryptoSigner and capture
 * the SignRequest it hands to the signer. If the spy sees
 * `intentId === permit.intent_id` even though `intent.intent_id` differs,
 * then the second UUID is inert at the sign gateway.
 */

function makePermit(): ExecutionPermit {
  return {
    schema_version: "1.1",
    permit_id: randomUUID(),
    decision_id: randomUUID(),
    intent_id: randomUUID(),
    ledger_version: "0003",
    policy_version: "v0-bootstrap",
    policy_hash: "ph_audited",
    quote_id: "quote_x",
    lease_epoch: 1,
    reservation_ids: ["res_1"],
    max_qty: 100,
    max_cash: 50,
    allowed_order_style: ["LIMIT", "POST_ONLY"],
    venue_mode: "NORMAL",
    issued_at: new Date("2026-01-01T00:00:00Z"),
    expires_at: new Date("2026-01-01T00:01:00Z"),
    single_use: true,
    used_at: null,
    max_qty_base: 100_000_000n,
    max_cash_base: 50_000_000n,
    market_id: "mkt_1",
    side: "BUY",
  } as unknown as ExecutionPermit;
}

const WALLET: WalletIdentity = {
  schema_version: "1.1",
  wallet_id: randomUUID(),
  wallet_type: "DEPOSIT_WALLET",
  signer_address: "0xSIGNER",
  account_wallet: "0xACCOUNT",
  funder: "0xFUNDER",
  chain_id: 137,
  verified_at: new Date("2026-01-01T00:00:00Z"),
} as unknown as WalletIdentity;

describe("g4-core double-UUID: does intent.intent_id reach the signer?", () => {
  it("signer receives permit.intent_id, NOT the intent passed to buildSignedOrder", async () => {
    const permit = makePermit();
    let seen: any = null;
    const vault = new SignerVault({
      maxClockSkewMs: 5000,
      expectedChainId: 137,
      cryptoSigner: async (r) => {
        seen = r;
        return `sig_${r.actionId}`;
      },
    });

    // This mirrors g4-core.executeG4Step step 6: a FRESH uuid intent that is
    // NOT the one the permit was reserved against.
    const rogueIntentId = randomUUID();
    const intent: TradeIntent = {
      schema_version: "1.1",
      intent_id: rogueIntentId,
      dedupe_key: `mkt_1_${Date.now()}`,
      purpose: "ENTRY",
      market_id: "mkt_1",
      side: "BUY",
      desired_qty: 10,
      limit_price: 0.5,
      created_at: new Date("2026-01-01T00:00:00Z"),
      evidence_ids: [],
      forecast_refs: [],
      status: "CREATED",
      expiration_sec: 300,
    } as unknown as TradeIntent;

    assert.notEqual(
      rogueIntentId,
      permit.intent_id,
      "precondition: the two intent ids must differ",
    );

    const res = await buildSignedOrder(
      {
        intent,
        permit,
        wallet: WALLET,
        venueMode: "NORMAL",
        now: new Date("2026-01-01T00:00:30Z"),
      },
      vault,
    );

    console.log("--- verbatim observations ---");
    console.log(`buildSignedOrder.ok            = ${res.ok}`);
    console.log(`intent.intent_id (2nd UUID)   = ${rogueIntentId}`);
    console.log(`permit.intent_id              = ${permit.intent_id}`);
    console.log(`signRequest.intentId (spy)    = ${seen?.intentId}`);
    console.log(
      `signed order permit_id        = ${res.ok ? res.order.permit_id : "n/a"}`,
    );

    // The sign gateway is bound to the PERMIT, not the passed intent.
    assert.equal(seen, null === seen ? null : seen);
    assert.ok(seen, "spy must have been invoked");
    assert.equal(
      seen.intentId,
      permit.intent_id,
      "signer must see permit.intent_id",
    );
    assert.notEqual(seen.intentId, rogueIntentId);
    assert.equal(
      res.ok,
      true,
      "buildSignedOrder must succeed despite id drift",
    );
  });
});
