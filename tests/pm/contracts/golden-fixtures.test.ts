import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { submitRelayerOp, type RelayerOperation } from "@polyroot/control";
import { verifyBodyHmac } from "@polyroot/signer";
import { grantSessionScope } from "@polyroot/signer";

const FIX = JSON.parse(
  readFileSync(
    new URL("../../fixtures/relayer-session.json", import.meta.url),
    "utf8",
  ),
);

describe("No.4 golden fixtures: relayer/session replay (frozen API shapes)", () => {
  it("HMAC golden vector pins the wire format byte-exactly", () => {
    const g = FIX.hmacGolden;
    const r = verifyBodyHmac(g.secret, g.body, g.tag);
    assert.equal(r.ok, true);
  });

  it("relayer nonce sequence replays deterministically (submit, retry, advance)", () => {
    // Records are keyed by operation_id (as the durable store does); a new
    // id starts fresh, a retry reuses its own record.
    const records = new Map<string, RelayerOperation | null>();
    FIX.relayerSubmitSequence.forEach((step: any, i: number) => {
      const expected = FIX.relayerExpected[i];
      const r = submitRelayerOp(
        records.get(step.operationId) ?? null,
        step.operationId,
        step.nonce,
      );
      assert.equal(r.ok, true);
      if (!r.ok) throw new Error("expected ok");
      assert.equal(r.duplicate, expected.duplicate);
      assert.equal(r.op.attempts, expected.attempts);
      records.set(step.operationId, r.op);
    });
    assert.equal(records.get("op_golden_002")?.nonce, 1);
  });

  it("session grant fixture replays to the exact expiry", () => {
    const g = FIX.sessionGrant;
    const r = grantSessionScope({
      scopes: g.scopes,
      lifetimeMs: g.lifetimeMs,
      now: new Date(g.now),
    });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.expiresAt.toISOString(), g.expectedExpiresAt);
    assert.deepEqual(r.scopes, g.scopes);
  });

  it("fixture file carries its schema marker (drift is explicit)", () => {
    assert.equal(FIX.$schema, "polyroot-golden-fixture-v1");
  });
});
