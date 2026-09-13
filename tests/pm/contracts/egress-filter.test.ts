import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EgressFilter,
  type EgressCheckInput,
  type EgressFilterConfig,
  type EgressAuditEntry,
} from "@polyroot/security";

describe("PR-SEC-03, PR-OPS-06 / T-PR-SEC-03P0: Egress Filter (categorization, policy, audit)", () => {
  const makeFilter = (overrides: Partial<EgressFilterConfig> = {}) =>
    new EgressFilter({
      allowedDomains: ["api.polymarket.com"],
      maxRedirects: 5,
      maxBodySize: 1024 * 1024,
      timeoutMs: 30000,
      ...overrides,
    });

  const makeInput = (overrides: Partial<EgressCheckInput> = {}): EgressCheckInput => ({
    url: "https://api.polymarket.com/markets",
    redirectChain: [],
    responseSize: 100,
    delayMs: 10,
    ...overrides,
  });

  // --- Categorization ---

  it("categorizes research URLs", async () => {
    const filter = makeFilter({
      categoryRules: [
        { pattern: /news|blog|research/i, category: "research" },
        { pattern: /api\.polymarket/i, category: "market_data" },
      ],
    });
    const res = await filter.check(makeInput({ url: "https://news.example.com/article" }));
    assert.equal(res.category, "research");
    assert.equal(res.policyDecision, "QUARANTINE"); // default policy for research
  });

  it("categorizes market data URLs", async () => {
    const filter = makeFilter({
      categoryRules: [
        { pattern: /api\.polymarket/i, category: "market_data" },
        { pattern: /news|blog/i, category: "research" },
      ],
    });
    const res = await filter.check(makeInput({ url: "https://api.polymarket.com/markets" }));
    assert.equal(res.category, "market_data");
    assert.equal(res.policyDecision, "ALLOW"); // default policy for market_data
  });

  it("categorizes unknown URLs as unknown", async () => {
    const filter = makeFilter({
      categoryRules: [{ pattern: /api\.polymarket/i, category: "market_data" }],
    });
    const res = await filter.check(makeInput({ url: "https://unknown.example.com/" }));
    assert.equal(res.category, "unknown");
    assert.equal(res.policyDecision, "BLOCK"); // default policy for unknown
  });

  it("categorizes by pathname when hostname doesn't match", async () => {
    const filter = makeFilter({
      categoryRules: [{ pattern: /research/i, category: "research" }],
    });
    const res = await filter.check(makeInput({ url: "https://example.com/research/data" }));
    assert.equal(res.category, "research");
  });

  // --- Policy decisions ---

  it("applies category policy (BLOCK)", async () => {
    const filter = makeFilter({
      categoryRules: [{ pattern: /\.gov/i, category: "research" }],
      categoryPolicy: { research: "BLOCK" },
    });
    const res = await filter.check(makeInput({ url: "https://agency.gov/data" }));
    assert.equal(res.category, "research");
    assert.equal(res.policyDecision, "BLOCK");
    assert.equal(res.ok, false); // blocked by policy
    assert.equal(res.code, "POLICY_BLOCK");
  });

  it("applies category policy (QUARANTINE treated as allow)", async () => {
    const filter = makeFilter({
      categoryRules: [{ pattern: /api\.external/i, category: "external_api" }],
      categoryPolicy: { external_api: "QUARANTINE" },
    });
    const res = await filter.check(makeInput({ url: "https://api.external.com/webhook" }));
    assert.equal(res.category, "external_api");
    assert.equal(res.policyDecision, "QUARANTINE");
    assert.equal(res.ok, true); // quarantine allows but logs
    assert.equal(res.code, "POLICY_QUARANTINE");
  });

  it("allows by default when no policy match", async () => {
    const filter = makeFilter({
      categoryRules: [{ pattern: /api\/internal/i, category: "executor" }],
      // no categoryPolicy set -> defaults to the configured policy
    });
    const res = await filter.check(makeInput({ url: "https://api.polymarket.com/markets" }));
    assert.equal(res.category, "unknown"); // no rule matched
    assert.equal(res.policyDecision, "BLOCK"); // unknown defaults to BLOCK
    assert.equal(res.ok, false);
  });

  // --- Audit logging ---

  it("logs audit entry via callback", async () => {
    let auditEntry: EgressAuditEntry | null = null;
    const filter = makeFilter({
      onAuditEntry: (entry) => {
        auditEntry = entry;
      },
    });
    await filter.check(makeInput({ url: "https://api.polymarket.com/markets" }));
    assert.ok(auditEntry);
    assert.equal(auditEntry!.category, "market_data");
    assert.equal(auditEntry!.url, "https://api.polymarket.com/markets");
    assert.equal(auditEntry!.decision, "ALLOW");
    assert.ok(auditEntry!.auditId);
    assert.ok(auditEntry!.timestamp instanceof Date);
  });

  it("does not log when audit disabled", async () => {
    let auditEntry: EgressAuditEntry | null = null;
    const filter = makeFilter({
      auditEnabled: false,
      onAuditEntry: (entry) => {
        auditEntry = entry;
      },
    });
    await filter.check(makeInput({ url: "https://api.polymarket.com/markets" }));
    assert.equal(auditEntry, null);
  });

  it("redacts secret-like fields in audit payload", async () => {
    const filter = makeFilter();
    // Input doesn't have a body, but we can test the redactor via audit logger directly
    const auditLogger = filter.getAuditLogger();
    const redacted = auditLogger.redact({ api_key: "secret", normal: "value" });
    assert.equal(redacted.api_key, "REDACTED");
    assert.equal(redacted.normal, "value");
  });

  // --- EgressGuard delegation (SSRF, etc.) ---

  it("blocks SSRF to localhost even if allowed by category", async () => {
    const filter = makeFilter({
      categoryRules: [{ pattern: /localhost/i, category: "research" }],
      categoryPolicy: { research: "ALLOW" },
    });
    const res = await filter.check(makeInput({ url: "http://127.0.0.1:8080/" }));
    assert.equal(res.ok, false);
    assert.equal(res.code, "BLOCKED_PRIVATE_IP"); // from EgressGuard
  });

  it("blocks metadata endpoint", async () => {
    const filter = makeFilter({
      categoryRules: [{ pattern: /169\.254/i, category: "research" }],
      categoryPolicy: { research: "ALLOW" },
    });
    const res = await filter.check(makeInput({ url: "http://169.254.169.254/latest/meta-data/" }));
    assert.equal(res.ok, false);
    assert.equal(res.code, "BLOCKED_METADATA_ENDPOINT");
  });

  it("enforces max redirects", async () => {
    const filter = makeFilter({
      maxRedirects: 1,
      categoryRules: [{ pattern: /example/i, category: "research" }],
      categoryPolicy: { research: "ALLOW" },
    });
    const res = await filter.check(makeInput({
      url: "http://example.com/redirect",
      redirectChain: ["http://example.com/redirect", "http://example.com/final"], // 2 hops > max 1
    }));
    assert.equal(res.ok, false);
    assert.equal(res.code, "MAX_REDIRECTS_EXCEEDED");
  });

  it("enforces response size limit", async () => {
    const filter = makeFilter({
      maxBodySize: 100,
      categoryRules: [{ pattern: /example/i, category: "research" }],
      categoryPolicy: { research: "ALLOW" },
    });
    const res = await filter.check(makeInput({ url: "http://example.com/large", responseSize: 200 }));
    assert.equal(res.ok, false);
    assert.equal(res.code, "BODY_TOO_LARGE");
  });

  it("enforces timeout", async () => {
    const filter = makeFilter({
      timeoutMs: 50,
      categoryRules: [{ pattern: /example/i, category: "research" }],
      categoryPolicy: { research: "ALLOW" },
    });
    const res = await filter.check(makeInput({ url: "http://example.com/slow", delayMs: 200 }));
    assert.equal(res.ok, false);
    assert.equal(res.code, "TIMEOUT");
  });

  // --- Runtime updates ---

  it("can update category rules at runtime", async () => {
    const filter = makeFilter({
      categoryRules: [{ pattern: /old/i, category: "research" }],
      categoryPolicy: { research: "ALLOW" },
    });
    let before = await filter.check(makeInput({ url: "https://newsite.com/" }));
    assert.equal(before.category, "unknown");

    filter.updateCategoryRules([{ pattern: /newsite/i, category: "market_data" }]);
    let after = await filter.check(makeInput({ url: "https://newsite.com/" }));
    assert.equal(after.category, "market_data");
  });

  it("can update category policy at runtime", async () => {
    const filter = makeFilter({
      categoryRules: [{ pattern: /test/i, category: "research" }],
      categoryPolicy: { research: "ALLOW" },
    });
    let before = await filter.check(makeInput({ url: "https://test.com/" }));
    assert.equal(before.policyDecision, "ALLOW");

    filter.updateCategoryPolicy({ research: "BLOCK" });
    let after = await filter.check(makeInput({ url: "https://test.com/" }));
    assert.equal(after.policyDecision, "BLOCK");
    assert.equal(after.ok, false);
  });
});