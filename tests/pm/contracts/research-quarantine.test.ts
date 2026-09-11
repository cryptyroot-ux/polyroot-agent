import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ResearchBoundary,
  normalizeEvidence,
  type NormalizedEvidence,
} from "@polyroot/security";

describe("PR-SEC-02 / T-PR-SEC-02: research quarantine boundary", () => {
  it("a low-privilege research boundary cannot reach executor/signer/private-db roles", () => {
    const boundary = new ResearchBoundary();
    assert.equal(boundary.canAccess("market_data"), true);
    assert.equal(boundary.canAccess("evidence_store"), true);
    assert.equal(boundary.canAccess("executor"), false);
    assert.equal(boundary.canAccess("signer_vault"), false);
    assert.equal(boundary.canAccess("private_db"), false);
    assert.equal(boundary.canAccess("strategy"), false);
  });

  it("unknown resource names fail closed", () => {
    const boundary = new ResearchBoundary();
    assert.equal(boundary.canAccess("coinbase_internal"), false);
    assert.equal(boundary.canAccess(""), false);
  });

  it("normalizeEvidence passes only structured fields, never raw executable content", () => {
    const ev = normalizeEvidence({
      url: "https://evil.example/exploit",
      rawHtml: "<script>stealKeys()</script><p>poll data</p>",
      rawText: "run: exec('...')",
      claim: "poll indicates candidate leads by 5",
      sourceFamily: "news.example",
      fetchedAt: new Date("2026-09-11T00:00:00Z"),
      contentHash: "sha256:abc",
    });
    assert.equal(ev.claim, "poll indicates candidate leads by 5");
    assert.equal(ev.rawHtml, undefined, "raw HTML must not cross the boundary");
    assert.equal(ev.rawText, undefined, "raw text must not cross the boundary");
  });

  it("normalizeEvidence marks untrusted content and keeps provenance only", () => {
    const ev = normalizeEvidence({
      url: "https://news.example/a?utm=1",
      rawHtml: "<html>...</html>",
      rawText: "...",
      claim: "x",
      sourceFamily: "news.example",
      fetchedAt: new Date("2026-09-11T00:00:00Z"),
      contentHash: "sha256:hash",
    });
    assert.equal(ev.untrusted, true);
    assert.match(ev.contentHash, /^sha256:/);
    assert.equal((ev as NormalizedEvidence).sourceUrl, "https://news.example/a?utm=1");
  });
});