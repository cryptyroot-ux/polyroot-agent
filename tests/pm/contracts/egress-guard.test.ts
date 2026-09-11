import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EgressGuard } from "@polyroot/security";

describe("PR-SEC-03 / T-PR-SEC-03: SSRF & Egress Protection", () => {
  const makeGuard = () => new EgressGuard({ allowedDomains: ["api.polymarket.com", "api.polyroot.io"] });

  it("blocks direct request to 127.0.0.1 (localhost)", async () => {
    const guard = new EgressGuard({ allowedDomains: ["api.polymarket.com"] });
    const res = await guard.check({ url: "http://127.0.0.1:8080/api" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "BLOCKED_PRIVATE_IP");
  });

  it("blocks RFC1918 private IP ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)", async () => {
    const guard = new EgressGuard({ allowedDomains: ["api.polymarket.com"] });
    const ips = ["10.0.0.1", "172.16.0.1", "192.168.1.1"];
    for (const ip of ips) {
      const res = await new EgressGuard({ allowedDomains: ["api.polymarket.com"] })
        .check({ url: `http://${ip}/api` });
      assert.equal(res.ok, false, `${ip} should be blocked`);
      assert.equal(res.code, "BLOCKED_PRIVATE_IP");
    }
  });

  it("blocks link-local (169.254.0.0/16) and metadata endpoints (169.254.169.254)", async () => {
    const guard = new EgressGuard({ allowedDomains: ["api.polymarket.com"] });
    const res = await guard.check({ url: "http://169.254.169.254/latest/meta-data/" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "BLOCKED_METADATA_ENDPOINT");
  });

  it("blocks localhost IPv6 (::1)", async () => {
    const guard = new EgressGuard({ allowedDomains: ["api.polymarket.com"] });
    const res = await guard.check({ url: "http://[::1]:8080/" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "BLOCKED_PRIVATE_IP");
  });

  it("allows allowed domains", async () => {
    const guard = new EgressGuard({ allowedDomains: ["api.polymarket.com"] });
    const res = await guard.check({ url: "https://api.polymarket.com/markets" });
    assert.equal(res.ok, true);
  });

  it("blocks redirect chain to private IP (DNS rebind protection)", async () => {
    // This would need a mock HTTP server that redirects to 127.0.0.1
    // For unit test, we test the redirect validation logic directly
    const guard = new EgressGuard({ allowedDomains: ["api.polymarket.com"], maxRedirects: 5 });
    // Mock a redirect chain that eventually hits 127.0.0.1
    // The guard should follow redirects and validate final destination
    const res = await guard.check({
      url: "http://evil.com/redirect",
      redirectChain: ["http://evil.com/redirect", "http://127.0.0.1:8080"]
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "BLOCKED_REDIRECT_PRIVATE_IP");
  });

  it("blocks link-local (169.254.0.0/16)", async () => {
    const guard = new EgressGuard({ allowedDomains: ["api.polymarket.com"] });
    const res = await guard.check({ url: "http://169.254.169.254/latest/meta-data/" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "BLOCKED_LINK_LOCAL");
  });

  it("blocks IPv6 loopback (::1)", async () => {
    const guard = new EgressGuard({ allowedDomains: ["api.polymarket.com"] });
    const res = await guard.check({ url: "http://[::1]:8080/" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "BLOCKED_PRIVATE_IP");
  });

  it("blocks IPv6 ULA (fc00::/7)", async () => {
    const guard = new EgressGuard({ allowedDomains: ["api.polymarket.com"] });
    const res = await guard.check({ url: "http://[fc00::1]/" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "BLOCKED_PRIVATE_IP");
  });

  it("allows allowed domains", async () => {
    const guard = new EgressGuard({ allowedDomains: ["api.polymarket.com", "api.polyroot.io"] });
    const res = await guard.check({ url: "https://api.polymarket.com/markets" });
    assert.equal(res.ok, true);
  });

  it("enforces max redirect depth", async () => {
    const guard = new EgressGuard({ allowedDomains: ["api.polymarket.com"], maxRedirects: 3 });
    // Simulate redirect chain exceeding max
    const res = await guard.check({
      url: "http://example.com/redirect",
      redirectChain: [
        "http://a.com",
        "http://b.com",
        "http://c.com",
        "http://d.com",
        "http://e.com",
        "http://f.com" // 6 hops, exceeds max 5
      ]
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "MAX_REDIRECTS_EXCEEDED");
  });

  it("enforces size limit on response body", async () => {
    const guard = new EgressGuard({ allowedDomains: ["api.polymarket.com"], maxBodySize: 1024 });
    // Mock a large response
    const res = await guard.check({
      url: "https://api.polymarket.com/large",
      responseSize: 2048
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "BODY_TOO_LARGE");
  });

  it("enforces timeout", async () => {
    const guard = new EgressGuard({ allowedDomains: ["api.polymarket.com"], timeoutMs: 100 });
    // Mock a slow response
    const res = await guard.check({
      url: "https://api.polymarket.com/slow",
      delayMs: 5000
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "TIMEOUT");
  });
});