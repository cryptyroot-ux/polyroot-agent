import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  verifyBodyHmac,
  checkCredentialBinding,
} from "../src/credential-auth.ts";
import { createHmac } from "crypto";

describe("CredentialAuth — Rate Limiting", () => {
  it("enforces rate limit when rateLimitKey is provided and limit exceeded", () => {
    const secret = "test-secret";
    const body = "hello world";
    const tag = createHmac("sha256", secret).update(body).digest("hex");
    const key = "rate-key-" + Math.random();

    // Exhaust tokens (capacity 60)
    for (let i = 0; i < 60; i++) {
      const res = verifyBodyHmac(secret, body, tag, { rateLimitKey: key });
      assert.equal(res.ok, true);
    }

    // 61st request should hit rate limit
    const resLimited = verifyBodyHmac(secret, body, tag, { rateLimitKey: key });
    assert.equal(resLimited.ok, false);
    assert.equal(resLimited.code, "RATE_LIMIT_EXCEEDED");
  });

  it("enforces rate limit on checkCredentialBinding as well", () => {
    const credential = { credentialId: "cred_1", boundSignerAddress: "0x1234" };
    const key = "rate-key-binding-" + Math.random();

    for (let i = 0; i < 60; i++) {
      const res = checkCredentialBinding(credential, "0x1234", {
        rateLimitKey: key,
      });
      assert.equal(res.ok, true);
    }

    const resLimited = checkCredentialBinding(credential, "0x1234", {
      rateLimitKey: key,
    });
    assert.equal(resLimited.ok, false);
    assert.equal(resLimited.code, "RATE_LIMIT_EXCEEDED");
  });
});
