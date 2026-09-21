import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  UntrustedContentBoundary,
  type PrivilegedAction,
} from "@polyroot/intelligence";

describe("PM-AI-04: Untrusted Content Boundary — Runtime Enforcement", () => {
  it("throws when untrusted evidence attempts SIGN", () => {
    const evidence = { untrusted: true, content_hash: "abc" } as Pick<
      { untrusted: boolean; content_hash: string },
      "untrusted"
    >;
    const boundary = new UntrustedContentBoundary();

    assert.throws(() => boundary.enforce(evidence, "SIGN"), /untrusted/i);
  });

  it("throws when untrusted evidence attempts SHELL", () => {
    const evidence = { untrusted: true } as Pick<{ untrusted: boolean }, "untrusted">;
    const boundary = new UntrustedContentBoundary();

    assert.throws(() => boundary.enforce(evidence, "SHELL"), /untrusted/i);
  });

  it("throws when untrusted evidence attempts SECRET_READ", () => {
    const evidence = { untrusted: true } as Pick<{ untrusted: boolean }, "untrusted">;
    const boundary = new UntrustedContentBoundary();

    assert.throws(() => boundary.enforce(evidence, "SECRET_READ"), /untrusted/i);
  });

  it("throws when untrusted evidence attempts POLICY_WRITE", () => {
    const evidence = { untrusted: true } as Pick<{ untrusted: boolean }, "untrusted">;
    const boundary = new UntrustedContentBoundary();

    assert.throws(() => boundary.enforce(evidence, "POLICY_WRITE"), /untrusted/i);
  });

  it("throws when untrusted evidence attempts MANDATE_WRITE", () => {
    const evidence = { untrusted: true } as Pick<{ untrusted: boolean }, "untrusted">;
    const boundary = new UntrustedContentBoundary();

    assert.throws(() => boundary.enforce(evidence, "MANDATE_WRITE"), /untrusted/i);
  });

  it("allows trusted evidence to perform privileged actions", () => {
    const evidence = { untrusted: false } as Pick<{ untrusted: boolean }, "untrusted">;
    const boundary = new UntrustedContentBoundary();

    assert.doesNotThrow(() => boundary.enforce(evidence, "SIGN"));
    assert.doesNotThrow(() => boundary.enforce(evidence, "SHELL"));
    assert.doesNotThrow(() => boundary.enforce(evidence, "SECRET_READ"));
    assert.doesNotThrow(() => boundary.enforce(evidence, "POLICY_WRITE"));
    assert.doesNotThrow(() => boundary.enforce(evidence, "MANDATE_WRITE"));
  });

  it("allows untrusted evidence for non-privileged actions", () => {
    const evidence = { untrusted: true } as Pick<{ untrusted: boolean }, "untrusted">;
    const boundary = new UntrustedContentBoundary();

    assert.doesNotThrow(() => boundary.enforce(evidence, "READ" as PrivilegedAction));
    assert.doesNotThrow(() => boundary.enforce(evidence, "QUERY" as PrivilegedAction));
  });
});