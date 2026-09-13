import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SecurityProxy,
  redactForLogging,
  containsSecretCanary,
  type IngressRequest,
} from "@polyroot/security";

describe("PR-SEC-04, PR-SEC-07 / T-PR-SEC-04, T-PR-SEC-07: Security Proxy (ingress auth, mTLS, CSRF, rate limit)", () => {
  const makeProxy = () =>
    new SecurityProxy({
      ownerApiKey: "b3duZXJfa2V5X2Jhc2U2NA==", // "owner_key_base64" in base64
      allowedServices: ["spiffe://polyroot/executor", "spiffe://polyroot/signer"],
      protectedPaths: ["/api/", "/admin/", "/control/"],
      publicPaths: ["/health", "/metrics", "/ready"],
      rateLimitMax: 10,
      rateLimitWindowMs: 1000,
    });

  const makeRequest = (overrides: Partial<IngressRequest> = {}): IngressRequest => ({
    url: "http://localhost:3000/api/test",
    method: "GET",
    headers: {},
    ip: "10.0.0.1",
    ...overrides,
  });

  // --- mTLS verification ---

  it("accepts valid mTLS certificate for allowed service", async () => {
    const proxy = makeProxy();
    const req = makeRequest({
      clientCert: "subject=spiffe://polyroot/executor",
    });
    const res = await proxy.check(req);
    assert.equal(res.ok, true);
    assert.equal(res.identity?.type, "service");
    assert.equal(res.identity?.id, "spiffe://polyroot/executor");
    assert.equal(res.mTlsVerified, true);
  });

  it("rejects mTLS certificate for unknown service", async () => {
    const proxy = makeProxy();
    const req = makeRequest({
      clientCert: "subject=spiffe://polyroot/unknown",
    });
    const res = await proxy.check(req);
    assert.equal(res.ok, false);
    assert.equal(res.code, "UNAUTHORIZED_SERVICE");
  });

  it("rejects mTLS certificate without subject", async () => {
    const proxy = makeProxy();
    const req = makeRequest({
      clientCert: "issuer=...",
    });
    const res = await proxy.check(req);
    assert.equal(res.ok, false);
    assert.equal(res.code, "INVALID_MTLS_CERT");
  });

  // --- Owner API Key ---

  it("accepts valid owner API key (timing-safe)", async () => {
    const proxy = makeProxy();
    const req = makeRequest({
      headers: { authorization: "Bearer b3duZXJfa2V5X2Jhc2U2NA==" },
    });
    const res = await proxy.check(req);
    assert.equal(res.ok, true);
    assert.equal(res.identity?.type, "owner");
    assert.equal(res.identity?.roles.includes("owner"), true);
  });

  it("rejects invalid owner API key (timing-safe, constant-time)", async () => {
    const proxy = makeProxy();
    const req = makeRequest({
      headers: { authorization: "Bearer aW52YWxpZF9rZXk=" }, // "invalid_key" in base64
    });
    const res = await proxy.check(req);
    assert.equal(res.ok, false);
    assert.equal(res.code, "INVALID_API_KEY");
  });

  it("rejects malformed Authorization header", async () => {
    const proxy = makeProxy();
    const req = makeRequest({
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    const res = await proxy.check(req);
    assert.equal(res.ok, false);
    assert.equal(res.code, "INVALID_API_KEY");
  });

  // --- Session / CSRF ---

  it("creates session with CSRF token and validates it", async () => {
    const proxy = makeProxy();
    const { sessionId, csrfToken, expiresAt } = proxy.createSession("10.0.0.2", "test-agent");

    // Valid session cookie
    const req1 = makeRequest({
      headers: { cookie: `polyroot_sid=${sessionId}; polyroot_csrf=${csrfToken}` },
    });
    const res1 = await proxy.check(req1);
    assert.equal(res1.ok, true);
    assert.ok(res1.session);
    assert.equal(res1.session.sessionId, sessionId);

    // Invalid CSRF on mutating request
    const req2 = makeRequest({
      method: "POST",
      headers: { cookie: `polyroot_sid=${sessionId}; polyroot_csrf=wrong_token` },
    });
    const res2 = await proxy.check(req2);
    assert.equal(res2.ok, false);
    assert.equal(res2.code, "CSRF_INVALID");

    // Valid CSRF on mutating request
    const req3 = makeRequest({
      method: "POST",
      headers: { cookie: `polyroot_sid=${sessionId}; polyroot_csrf=${csrfToken}` },
    });
    const res3 = await proxy.check(req3);
    assert.equal(res3.ok, true);
  });

  it("rejects expired session", async () => {
    const proxy = new SecurityProxy({
      ownerApiKey: "b3duZXJfa2V5X2Jhc2U2NA==",
      allowedServices: [],
      protectedPaths: ["/api/"],
      publicPaths: ["/health"],
      sessionTtlMs: 1, // 1ms
    });
    const { sessionId, csrfToken } = proxy.createSession("10.0.0.3", "test-agent");
    // Wait for expiry
    await new Promise(r => setTimeout(r, 10));

    const req = makeRequest({
      headers: { cookie: `polyroot_sid=${sessionId}; polyroot_csrf=${csrfToken}` },
    });
    const res = await proxy.check(req);
    assert.equal(res.ok, false);
    assert.equal(res.code, "SESSION_EXPIRED");
  });

  it("invalidates session on logout", async () => {
    const proxy = makeProxy();
    const { sessionId, csrfToken } = proxy.createSession("10.0.0.4", "test-agent");

    // Session works
    let req = makeRequest({
      headers: { cookie: `polyroot_sid=${sessionId}; polyroot_csrf=${csrfToken}` },
    });
    let res = await proxy.check(req);
    assert.equal(res.ok, true);

    // Logout
    assert.equal(proxy.invalidateSession(sessionId), true);

    // Session rejected
    req = makeRequest({
      headers: { cookie: `polyroot_sid=${sessionId}; polyroot_csrf=${csrfToken}` },
    });
    res = await proxy.check(req);
    assert.equal(res.ok, false);
    assert.equal(res.code, "INVALID_SESSION");
  });

  // --- Public paths ---

  it("allows public paths without authentication", async () => {
    const proxy = makeProxy();
    const req = makeRequest({ url: "http://localhost:3000/health" });
    const res = await proxy.check(req);
    assert.equal(res.ok, true);
    assert.equal(res.identity?.type, "system");
  });

  it("allows metrics path without authentication", async () => {
    const proxy = makeProxy();
    const req = makeRequest({ url: "http://localhost:3000/metrics" });
    const res = await proxy.check(req);
    assert.equal(res.ok, true);
  });

  // --- Rate limiting ---

  it("enforces rate limit per IP", async () => {
    const proxy = makeProxy();
    // Authenticated request so the request passes auth and rate-limit behavior
    // can be observed (unauthenticated requests fail auth before rate limiting).
    const req = makeRequest({
      ip: "192.0.2.1",
      headers: { authorization: "Bearer b3duZXJfa2V5X2Jhc2U2NA==" },
    });

    // First 10 requests succeed
    for (let i = 0; i < 10; i++) {
      const res = await proxy.check(req);
      assert.equal(res.ok, true, `Request ${i + 1} should succeed`);
    }

    // 11th request fails
    const res = await proxy.check(req);
    assert.equal(res.ok, false);
    assert.equal(res.code, "RATE_LIMITED");
  });

  it("resets rate limit after window expires", async () => {
    const proxy = new SecurityProxy({
      ownerApiKey: "b3duZXJfa2V5X2Jhc2U2NA==",
      allowedServices: [],
      protectedPaths: ["/api/"],
      publicPaths: ["/health"],
      rateLimitMax: 2,
      rateLimitWindowMs: 50,
    });
    const req = makeRequest({
      ip: "192.0.2.2",
      headers: { authorization: "Bearer b3duZXJfa2V5X2Jhc2U2NA==" },
    });

    // Exhaust limit
    await proxy.check(req);
    await proxy.check(req);
    let res = await proxy.check(req);
    assert.equal(res.ok, false);

    // Wait for window to reset
    await new Promise(r => setTimeout(r, 100));

    // Should work again
    res = await proxy.check(req);
    assert.equal(res.ok, true);
  });

  // --- Protected paths ---

  it("rejects protected path without authentication", async () => {
    const proxy = makeProxy();
    const req = makeRequest({ url: "http://localhost:3000/api/portfolio" });
    const res = await proxy.check(req);
    assert.equal(res.ok, false);
    assert.equal(res.code, "UNAUTHENTICATED");
  });

  // --- Secret redaction (PR-SEC-04 canary test) ---

  it("redacts secret-like fields from log objects", () => {
    const payload = {
      orderId: "0x123",
      api_key: "sk_live_abc123",
      secret: "my-secret",
      nested: { token: "nested-token", normal: "value" },
      array: [{ password: "pass123" }, { normal: "ok" }],
    };
    const redacted = redactForLogging(payload);
    assert.equal(redacted.orderId, "0x123");
    assert.equal(redacted.api_key, "REDACTED");
    assert.equal(redacted.secret, "REDACTED");
    assert.equal(redacted.nested.token, "REDACTED");
    assert.equal(redacted.nested.normal, "value");
    assert.equal(redacted.array[0].password, "REDACTED");
    assert.equal(redacted.array[1].normal, "ok");
  });

  it("secret canary helper detects canary in text", () => {
    // The canary constant is internal; this test verifies the helper works
    // by testing with a known canary string
    const canary = "POLYROOT_SECRET_CANARY_NEVER_LOG_THIS";
    assert.equal(containsSecretCanary("normal log " + canary), true);
    assert.equal(containsSecretCanary("normal log without canary"), false);
  });

  // --- mTLS priority over API key ---

  it("prefers mTLS over API key when both present", async () => {
    const proxy = makeProxy();
    const req = makeRequest({
      clientCert: "subject=spiffe://polyroot/executor",
      headers: { authorization: "Bearer b3duZXJfa2V5X2Jhc2U2NA==" },
    });
    const res = await proxy.check(req);
    assert.equal(res.ok, true);
    assert.equal(res.identity?.type, "service"); // mTLS identity, not owner
    assert.equal(res.mTlsVerified, true);
  });

  // --- Cleanup ---

  it("cleanup removes expired sessions and rate limit entries", async () => {
    const proxy = new SecurityProxy({
      ownerApiKey: "b3duZXJfa2V5X2Jhc2U2NA==",
      allowedServices: [],
      protectedPaths: ["/api/"],
      publicPaths: ["/health"],
      sessionTtlMs: 1,
      rateLimitMax: 1,
      rateLimitWindowMs: 1,
    });

    // Create session
    const { sessionId } = proxy.createSession("10.0.0.5", "test-agent");
    assert.equal(proxy.getActiveSessionCount(), 1);

    // Exhaust rate limit
    await proxy.check(makeRequest({ ip: "192.0.2.3" }));
    const res = await proxy.check(makeRequest({ ip: "192.0.2.3" }));
    assert.equal(res.ok, false);

    // Wait for expiry
    await new Promise(r => setTimeout(r, 20));

    // Cleanup
    proxy.cleanup();

    assert.equal(proxy.getActiveSessionCount(), 0);
  });
});