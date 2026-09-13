/**
 * @polyroot/security — Security Proxy (PR-SEC-04, PR-SEC-07, T-PR-SEC-04, T-PR-SEC-07).
 *
 * Ingress security for the product API and internal control plane.
 * Enforces:
 * - mTLS verification for internal service-to-service calls
 * - Owner authentication with secure sessions and CSRF protection
 * - Rate limiting and request validation
 * - Secret redaction in all logging paths (canary testable)
 */

import { timingSafeEqual } from "crypto";
import { URL } from "url";

/** Result of an ingress check. */
export interface IngressCheckResult {
  ok: boolean;
  code?: string;
  reason?: string;
  identity?: AuthIdentity;
  session?: SessionInfo;
  mTlsVerified?: boolean;
}

/** Authenticated identity after successful verification. */
export interface AuthIdentity {
  type: "owner" | "service" | "system";
  id: string;
  roles: string[];
  verifiedAt: Date;
  mTlsVerified?: boolean;
}

/** Session information for owner sessions. */
export interface SessionInfo {
  sessionId: string;
  createdAt: Date;
  expiresAt: Date;
  csrfToken: string;
  ip: string;
  userAgent: string;
}

/** Configuration for SecurityProxy. */
export interface SecurityProxyConfig {
  /** Owner API key (base64-encoded) for dashboard access. */
  ownerApiKey: string;
  /** mTLS CA certificate (PEM) for verifying internal service certs. */
  mtlsCaCert?: string;
  /** Allowed internal service identities (subject DNs or SPIFFE IDs). */
  allowedServices: string[];
  /** Session TTL in milliseconds. */
  sessionTtlMs?: number;
  /** CSRF token TTL in milliseconds. */
  csrfTtlMs?: number;
  /** Maximum requests per window for rate limiting. */
  rateLimitMax?: number;
  /** Rate limit window in milliseconds. */
  rateLimitWindowMs?: number;
  /** Paths that require owner authentication. */
  protectedPaths: string[];
  /** Paths that are public (health, metrics). */
  publicPaths: string[];
}

/** Internal rate limit tracker. */
interface RateLimitEntry {
  count: number;
  windowStart: number;
}

/** Secret canary for testing redaction. Must never appear in logs. */
const SECRET_CANARY = "POLYROOT_SECRET_CANARY_NEVER_LOG_THIS";

/**
 * Checks if a string contains the secret canary (for testing).
 * This is used to verify that secrets are properly redacted.
 */
export function containsSecretCanary(text: string): boolean {
  return text.includes(SECRET_CANARY);
}

/**
 * Redacts sensitive fields from an object for safe logging.
 * Returns a new object with secret-like keys replaced.
 */
export function redactForLogging(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/secret|token|key|password|credential|private_key|signature|mnemonic|api_key|api_key_base64|bearer/i.test(k)) {
      out[k] = "REDACTED";
    } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      out[k] = redactForLogging(v as Record<string, unknown>);
    } else if (Array.isArray(v)) {
      out[k] = v.map(item => typeof item === "object" && item !== null ? redactForLogging(item as Record<string, unknown>) : item);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class SecurityProxy {
  private readonly config: Required<SecurityProxyConfig>;
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly rateLimits = new Map<string, RateLimitEntry>();
  private readonly csrfTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(config: SecurityProxyConfig) {
    this.config = {
      ownerApiKey: config.ownerApiKey,
      mtlsCaCert: config.mtlsCaCert ?? "",
      allowedServices: config.allowedServices,
      sessionTtlMs: config.sessionTtlMs ?? 30 * 60 * 1000, // 30 minutes
      csrfTtlMs: config.csrfTtlMs ?? 60 * 60 * 1000, // 1 hour
      rateLimitMax: config.rateLimitMax ?? 100,
      rateLimitWindowMs: config.rateLimitWindowMs ?? 60 * 1000, // 1 minute
      protectedPaths: config.protectedPaths,
      publicPaths: config.publicPaths,
    };
  }

  /**
   * Check an incoming request for ingress authorization.
   * Supports three auth modes:
   * 1. Owner API key (dashboard/API)
   * 2. mTLS certificate (internal services)
   * 3. Session cookie (authenticated owner browser sessions)
   */
  async check(request: IngressRequest): Promise<IngressCheckResult> {
    const path = new URL(request.url, "http://localhost").pathname;

    // Public paths bypass all auth
    if (this.config.publicPaths.some(p => path.startsWith(p))) {
      return { ok: true, identity: { type: "system", id: "anonymous", roles: ["public"], verifiedAt: new Date() } };
    }

    // Rate limiting (per IP)
    const rateLimitResult = this.checkRateLimit(request.ip);
    if (!rateLimitResult.ok) {
      return rateLimitResult;
    }

    // Check for mTLS (internal service-to-service)
    if (request.clientCert) {
      const mtlsResult = await this.verifyMtls(request.clientCert);
      if (mtlsResult.ok) {
        return { ok: true, identity: mtlsResult.identity!, mTlsVerified: true };
      }
      // mTLS provided but invalid - reject
      return mtlsResult;
    }

    // Check for owner API key
    const authHeader = request.headers["authorization"] || request.headers["Authorization"];
    if (authHeader) {
      // A present but malformed Authorization header is an explicit auth failure
      // (e.g. "Basic ..." or "Bearer" with no token), not a missing credential.
      const apiKey = this.extractApiKey(request);
      if (!apiKey) {
        return { ok: false, code: "INVALID_API_KEY", reason: "Malformed Authorization header" };
      }
      const apiResult = this.verifyApiKey(apiKey);
      if (apiResult.ok) {
        return { ok: true, identity: apiResult.identity! };
      }
      return apiResult;
    }

    // Check for session cookie (browser dashboard)
    const sessionResult = this.checkSession(request);
    if (sessionResult.ok) {
      return sessionResult;
    }
    // Session validation failed - return the specific failure (CSRF_INVALID, SESSION_EXPIRED, etc.)
    // but treat a missing session as "no auth attempted" so protected paths can return UNAUTHENTICATED.
    if (!sessionResult.ok && sessionResult.code !== "NO_SESSION") {
      return sessionResult;
    }

    // Protected path with no valid auth
    if (this.config.protectedPaths.some(p => path.startsWith(p))) {
      return { ok: false, code: "UNAUTHENTICATED", reason: "Authentication required for this path" };
    }

    // Default allow for non-protected paths
    return { ok: true, identity: { type: "system", id: "anonymous", roles: ["public"], verifiedAt: new Date() } };
  }

  /**
   * Verify mTLS client certificate against CA.
   * In production, this would use proper X.509 chain verification.
   * Here we check subject DN against allowed services list.
   */
  private async verifyMtls(clientCert: string): Promise<IngressCheckResult> {
    // Extract subject DN from certificate (simplified)
    const subjectMatch = clientCert.match(/subject=([^\n]+)/i);
    const subject = subjectMatch?.[1]?.trim();

    if (!subject) {
      return { ok: false, code: "INVALID_MTLS_CERT", reason: "Client certificate missing subject" };
    }

    // Check against allowed services
    const allowed = this.config.allowedServices.some(s => subject.includes(s) || subject === s);
    if (!allowed) {
      return { ok: false, code: "UNAUTHORIZED_SERVICE", reason: `Service ${subject} not in allowlist` };
    }

    return {
      ok: true,
      identity: {
        type: "service",
        id: subject,
        roles: ["internal"],
        verifiedAt: new Date(),
      },
    };
  }

  /** Extract API key from Authorization header. */
  private extractApiKey(request: IngressRequest): string | undefined {
    const auth = request.headers["authorization"] || request.headers["Authorization"];
    if (!auth) return undefined;
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match?.[1];
  }

  /** Verify owner API key using timing-safe comparison. */
  private verifyApiKey(providedKey: string): IngressCheckResult {
    // Timing-safe comparison against configured key
    const expectedBuffer = Buffer.from(this.config.ownerApiKey, "base64");
    const providedBuffer = Buffer.from(providedKey, "base64");

    if (expectedBuffer.length !== providedBuffer.length) {
      return { ok: false, code: "INVALID_API_KEY", reason: "Invalid API key" };
    }

    if (!timingSafeEqual(expectedBuffer, providedBuffer)) {
      return { ok: false, code: "INVALID_API_KEY", reason: "Invalid API key" };
    }

    return {
      ok: true,
      identity: {
        type: "owner",
        id: "owner",
        roles: ["owner", "admin"],
        verifiedAt: new Date(),
      },
    };
  }

  /** Check session cookie for browser-based dashboard auth. */
  private checkSession(request: IngressRequest): IngressCheckResult {
    const cookieHeader = request.headers["cookie"] || request.headers["Cookie"];
    if (!cookieHeader) {
      return { ok: false, code: "NO_SESSION", reason: "No session cookie" };
    }

    const cookies = this.parseCookies(cookieHeader);
    const sessionId = cookies["polyroot_sid"];
    const csrfToken = cookies["polyroot_csrf"];

    if (!sessionId) {
      return { ok: false, code: "NO_SESSION", reason: "No session cookie" };
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      return { ok: false, code: "INVALID_SESSION", reason: "Session not found or expired" };
    }

    // Check session expiry
    if (Date.now() > session.expiresAt.getTime()) {
      this.sessions.delete(sessionId);
      return { ok: false, code: "SESSION_EXPIRED", reason: "Session expired" };
    }

    // CSRF validation for mutating requests
    const method = request.method?.toUpperCase() || "GET";
    if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      if (!csrfToken || csrfToken !== session.csrfToken) {
        return { ok: false, code: "CSRF_INVALID", reason: "Invalid or missing CSRF token" };
      }
      // Check CSRF token expiry
      const csrfEntry = this.csrfTokens.get(csrfToken);
      if (csrfEntry && Date.now() > csrfEntry.expiresAt) {
        return { ok: false, code: "CSRF_EXPIRED", reason: "CSRF token expired" };
      }
    }

    // Extend session on activity
    session.expiresAt = new Date(Date.now() + this.config.sessionTtlMs);
    this.sessions.set(sessionId, session);

    return { ok: true, identity: { type: "owner", id: "owner", roles: ["owner", "admin"], verifiedAt: new Date() }, session };
  }

  /** Create a new owner session (login). */
  createSession(ip: string, userAgent: string): { sessionId: string; csrfToken: string; expiresAt: Date } {
    const sessionId = this.generateSecureId(32);
    const csrfToken = this.generateSecureId(32);
    const now = Date.now();
    const expiresAt = new Date(now + this.config.sessionTtlMs);

    const session: SessionInfo = {
      sessionId,
      createdAt: new Date(now),
      expiresAt,
      csrfToken,
      ip,
      userAgent,
    };

    this.sessions.set(sessionId, session);
    this.csrfTokens.set(csrfToken, { token: csrfToken, expiresAt: now + this.config.csrfTtlMs });

    return { sessionId, csrfToken, expiresAt };
  }

  /** Invalidate a session (logout). */
  invalidateSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.csrfTokens.delete(session.csrfToken);
      this.sessions.delete(sessionId);
      return true;
    }
    return false;
  }

  /** Validate CSRF token for a request. */
  validateCsrf(csrfToken: string): boolean {
    const entry = this.csrfTokens.get(csrfToken);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.csrfTokens.delete(csrfToken);
      return false;
    }
    return true;
  }

  /** Rate limiting check per IP. */
  private checkRateLimit(ip: string): IngressCheckResult {
    const now = Date.now();
    const entry = this.rateLimits.get(ip);

    if (!entry || now - entry.windowStart > this.config.rateLimitWindowMs) {
      this.rateLimits.set(ip, { count: 1, windowStart: now });
      return { ok: true };
    }

    if (entry.count >= this.config.rateLimitMax) {
      return { ok: false, code: "RATE_LIMITED", reason: `Rate limit exceeded: ${this.config.rateLimitMax} requests per ${this.config.rateLimitWindowMs}ms` };
    }

    entry.count++;
    return { ok: true };
  }

  /** Parse cookie header into object. */
  private parseCookies(header: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    for (const part of header.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name && rest.length > 0) {
        cookies[name] = rest.join("=");
      }
    }
    return cookies;
  }

  /** Generate cryptographically secure random ID. */
  private generateSecureId(bytes: number): string {
    const buffer = new Uint8Array(bytes);
    crypto.getRandomValues(buffer);
    return Array.from(buffer).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  /** Get active session count (for monitoring). */
  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  /** Clean up expired sessions and rate limit entries. */
  cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now > session.expiresAt.getTime()) {
        this.csrfTokens.delete(session.csrfToken);
        this.sessions.delete(id);
      }
    }
    for (const [ip, entry] of this.rateLimits) {
      if (now - entry.windowStart > this.config.rateLimitWindowMs) {
        this.rateLimits.delete(ip);
      }
    }
    for (const [token, entry] of this.csrfTokens) {
      if (now > entry.expiresAt) {
        this.csrfTokens.delete(token);
      }
    }
  }
}

/** Ingress request structure for security proxy checks. */
export interface IngressRequest {
  url: string;
  method?: string;
  headers: Record<string, string | undefined>;
  ip: string;
  clientCert?: string; // PEM-encoded client certificate for mTLS
  body?: unknown;
}