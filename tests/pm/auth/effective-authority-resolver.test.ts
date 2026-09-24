import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EffectiveAuthorityResolver } from "../../../src/pm/auth/src/effective-authority-resolver";

describe("P0-8: EffectiveAuthorityResolver", () => {
  const resolver = new EffectiveAuthorityResolver();

  const root: any = {
    id: "root",
    allowedDomains: ["trading", "staking", "governance"],
    maxNotionalBase: 100_000_000_000n, // 100M base units
    policyVersion: "v1",
  };

  const child1: any = {
    id: "child1",
    parentId: "root",
    allowedDomains: ["trading", "staking"],
    maxNotionalBase: 50_000_000_000n, // 50M (attenuated)
    policyVersion: "v1",
  };

  const child2: any = {
    id: "child2",
    parentId: "child1",
    allowedDomains: ["trading"],
    maxNotionalBase: 10_000_000_000n, // 10M (further attenuated)
    policyVersion: "v1",
  };

  it("should allow request within effective limits", () => {
    const result = resolver.resolve(
      { identity: "user", lineage: [root, child1, child2] },
      "trading",
      5_000_000_000n,
    );
    assert.equal(result.ok, true);
    assert.equal(result.effectiveMaxNotional, 10_000_000_000n);
    assert.deepEqual(result.effectiveDomains.sort(), ["trading"].sort());
  });

  it("should reject request exceeding effective max notional", () => {
    const result = resolver.resolve(
      { identity: "user", lineage: [root, child1, child2] },
      "trading",
      20_000_000_000n,
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "EXCEEDS_EFFECTIVE_NOTIONAL");
  });

  it("should reject request for domain not in effective domains", () => {
    const result = resolver.resolve(
      { identity: "user", lineage: [root, child1, child2] },
      "governance",
      1_000_000_000n,
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "DOMAIN_NOT_ALLOWED");
  });

  it("should reject attenuation violation (child > parent)", () => {
    const badChild = {
      id: "bad",
      parentId: "child1",
      allowedDomains: ["trading"],
      maxNotionalBase: 60_000_000_000n, // > parent 50M
      policyVersion: "v1",
    };
    const result = resolver.resolve(
      { identity: "user", lineage: [root, child1, badChild] },
      "trading",
      1_000_000_000n,
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "ATTENUATION_VIOLATION");
  });

  it("should reject empty lineage", () => {
    const result = resolver.resolve(
      { identity: "user", lineage: [] },
      "trading",
      1_000_000_000n,
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "EMPTY_LINEAGE");
  });

  it("should handle single root node (no attenuation needed)", () => {
    const result = resolver.resolve(
      { identity: "user", lineage: [root] },
      "staking",
      50_000_000_000n,
    );
    assert.equal(result.ok, true);
    assert.equal(result.effectiveMaxNotional, 100_000_000_000n);
    assert.deepEqual(
      result.effectiveDomains.sort(),
      ["trading", "staking", "governance"].sort(),
    );
  });

  it("should intersect domains across lineage (child removes domain)", () => {
    const result = resolver.resolve(
      { identity: "user", lineage: [root, child1] },
      "governance",
      10_000_000_000n,
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, "DOMAIN_NOT_ALLOWED");
  });
});
