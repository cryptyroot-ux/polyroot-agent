import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalPromotionMessage,
  recoverPromotionSigner,
  resolveLiveAdmission,
  signPromotion,
  type AdmissionInput,
} from "@polyroot/control";
import { deriveAddressFromPrivateKey } from "@polyroot/signer";

// gitleaks:allow — synthetic test key, never mainnet, never funded.
const OWNER_PK =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const OTHER_PK =
  "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

const TUPLE = {
  strategy: "arb-v1",
  profile: "micro",
  fromCapUsd: 100,
  toCapUsd: 500,
  expiresAt: "2030-01-01T00:00:00.000Z",
};

function goodInput(over: Partial<AdmissionInput> = {}): AdmissionInput {
  const owner = deriveAddressFromPrivateKey(OWNER_PK);
  const { signature } = signPromotion(OWNER_PK, TUPLE);
  return {
    tuple: { ...TUPLE },
    signature,
    ownerAddress: owner,
    gates: { G0: true, G1: true, G2: true, G3: true, G4: true },
    monitoring: { systemHealth: true, venueMode: true, accountMode: true },
    rollback: {
      triggers: ["drawdown-latch", "kill-switch", "mandate-expiry"],
      steps: ["reduce", "flatten"],
    },
    now: new Date("2027-06-01T00:00:00.000Z"),
    ...over,
  };
}

describe("P0: owner-signed LIVE promotion", () => {
  it("canonical message binds every field (tamper voids signature)", () => {
    const a = canonicalPromotionMessage(TUPLE);
    const b = canonicalPromotionMessage({ ...TUPLE, toCapUsd: 99999 });
    assert.notEqual(a, b);
    assert.ok(a.includes("arb-v1") && a.includes("500"));
  });

  it("sign -> recover round-trips to the owner address", () => {
    const owner = deriveAddressFromPrivateKey(OWNER_PK);
    const { signature, messageHash } = signPromotion(OWNER_PK, TUPLE);
    assert.match(signature, /^0x[0-9a-f]{130}$/);
    assert.match(messageHash, /^0x[0-9a-f]{64}$/);
    assert.equal(
      recoverPromotionSigner(TUPLE, signature).toLowerCase(),
      owner.toLowerCase(),
    );
  });

  it("full admission: owner-signed + gates green => admitted", () => {
    const d = resolveLiveAdmission(goodInput());
    assert.equal(d.admitted, true);
    assert.ok(d.code === undefined);
  });

  it("wrong signer blocks (attacker key)", () => {
    const { signature } = signPromotion(OTHER_PK, TUPLE);
    const d = resolveLiveAdmission(goodInput({ signature }));
    assert.equal(d.admitted, false);
    assert.equal(d.code, "PROMOTION_WRONG_SIGNER");
  });

  it("tampered tuple voids the signature", () => {
    const d = resolveLiveAdmission(
      goodInput({ tuple: { ...TUPLE, toCapUsd: 99999 } }),
    );
    assert.equal(d.admitted, false);
    assert.equal(d.code, "PROMOTION_WRONG_SIGNER");
  });

  it("expired promotion blocks", () => {
    const expired = { ...TUPLE, expiresAt: "2020-01-01T00:00:00.000Z" };
    const owner = deriveAddressFromPrivateKey(OWNER_PK);
    const { signature } = signPromotion(OWNER_PK, expired);
    const d = resolveLiveAdmission({
      ...goodInput(),
      tuple: expired,
      signature,
    });
    assert.equal(d.admitted, false);
    assert.equal(d.code, "PROMOTION_EXPIRED");
  });

  it("malformed signature blocks without throwing", () => {
    const d = resolveLiveAdmission(goodInput({ signature: "0xdead" }));
    assert.equal(d.admitted, false);
    assert.equal(d.code, "PROMOTION_SIG_INVALID");
  });

  it("pending gates hold even a valid signature", () => {
    const d = resolveLiveAdmission(
      goodInput({
        gates: { G0: true, G1: true, G2: false, G3: true, G4: true },
      }),
    );
    assert.equal(d.admitted, false);
    assert.equal(d.code, "GATES_PENDING");
  });
});
