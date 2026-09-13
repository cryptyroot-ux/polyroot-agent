/**
 * @polyroot/security — Egress Filter (PR-SEC-03, T-PR-SEC-03P0, PR-OPS-06).
 *
 * Outbound traffic filter for compliance, audit, and policy enforcement.
 * Builds on EgressGuard to add:
 * - Categorization of outbound requests (research, market data, executor, etc.)
 * - Audit logging of all egress attempts (with secret redaction)
 * - Policy engine (allow/block by category, destination, time of day)
 * - Metrics emission for monitored egress traffic
 *
 * The filter never makes live external calls; it only decides and logs.
 * Actual HTTP calls are made by callers who respect the filter's decision.
 */

import {
  EgressGuard,
  type EgressCheckInput,
  type EgressCheckResult,
  type EgressGuardConfig,
} from "./egress-guard.js";

/** Category of outbound request for policy/audit. */
export type EgressCategory =
  | "research"
  | "market_data"
  | "executor"
  | "signer"
  | "private_db"
  | "strategy"
  | "external_api"
  | "unknown";

/** Result of an egress filter check, including decision and audit fields. */
export interface EgressFilterResult extends EgressCheckResult {
  category: EgressCategory;
  policyDecision: "ALLOW" | "BLOCK" | "QUARANTINE";
  auditId: string;
  loggedAt: Date;
}

/** Audit log entry for egress traffic. */
export interface EgressAuditEntry {
  auditId: string;
  timestamp: Date;
  category: EgressCategory;
  url: string;
  decision: "ALLOW" | "BLOCK" | "QUARANTINE";
  reason?: string;
  redactedPayload?: Record<string, unknown>;
}

/** Configuration for EgressFilter. */
export interface EgressFilterConfig extends EgressGuardConfig {
  /** Map of URL patterns to categories for classification. */
  categoryRules?: Array<{ pattern: RegExp; category: EgressCategory }>;
  /** Policy decisions per category (default ALLOW). */
  categoryPolicy?: Partial<Record<EgressCategory, "ALLOW" | "BLOCK" | "QUARANTINE">>;
  /** Enable audit logging (default true). */
  auditEnabled?: boolean;
  /** Secret canary for testing redaction (same as SecurityProxy). */
  secretCanary?: string;
  /** Callback to persist audit entries (in tests, we can spy). */
  onAuditEntry?: ((entry: EgressAuditEntry) => void) | undefined;
  /** Metrics callback (optional). */
  onMetric?: ((name: string, value: number, labels?: Record<string, string>) => void) | undefined;
}

/** Internal audit logger. */
class AuditLogger {
  private readonly enabled: boolean;
  private readonly secretCanary: string;
  private readonly onAuditEntry: ((entry: EgressAuditEntry) => void) | undefined;

  constructor(config: EgressFilterConfig) {
    this.enabled = config.auditEnabled ?? true;
    this.secretCanary = config.secretCanary ?? "POLYROOT_SECRET_CANARY_NEVER_LOG_THIS";
    this.onAuditEntry = config.onAuditEntry;
  }

  /** Log an egress attempt. */
  log(entry: Omit<EgressAuditEntry, "auditId" | "timestamp"> & { auditId?: string; timestamp?: Date | undefined }): void {
    if (!this.enabled) return;
    const auditId = entry.auditId ?? this.generateId();
    const timestamp = entry.timestamp ?? new Date();
    const finalEntry: EgressAuditEntry = {
      auditId,
      timestamp,
      category: entry.category,
      url: entry.url,
      decision: entry.decision,
      reason: entry.reason ?? "no reason",
    };
    if (entry.redactedPayload !== undefined) {
      finalEntry.redactedPayload = entry.redactedPayload;
    }
    this.onAuditEntry?.(finalEntry);
  }

  /** Generate a simple unique ID (for audit). */
  private generateId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }

  /** Redact secret-like fields from an object (for audit payload). */
  redact(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/secret|token|key|password|credential|private_key|signature|mnemonic|api_key|bearer/i.test(k)) {
        out[k] = "REDACTED";
      } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        out[k] = this.redact(v as Record<string, unknown>);
      } else if (Array.isArray(v)) {
        out[k] = v.map(item => typeof item === "object" && item !== null ? this.redact(item as Record<string, unknown>) : item);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /** Check if a string contains the secret canary (for testing). */
  containsCanary(text: string): boolean {
    return text.includes(this.secretCanary);
  }
}

/**
 * EgressFilter wraps EgressGuard and adds categorization, policy, audit, and metrics.
 */
export class EgressFilter {
  private readonly guard: EgressGuard;
  private readonly audit: AuditLogger;
  private readonly config: Required<EgressFilterConfig>;

  constructor(config: EgressFilterConfig) {
    this.guard = new EgressGuard(config);
    this.audit = new AuditLogger(config);
    this.config = {
      allowedDomains: config.allowedDomains,
      maxRedirects: config.maxRedirects ?? 5,
      maxBodySize: config.maxBodySize ?? 10 * 1024 * 1024,
      timeoutMs: config.timeoutMs ?? 30000,
      allowedIPs: config.allowedIPs ?? [],
      categoryRules: config.categoryRules ?? DEFAULT_CATEGORY_RULES,
      categoryPolicy: config.categoryPolicy ?? DEFAULT_CATEGORY_POLICY,
      auditEnabled: config.auditEnabled ?? true,
      secretCanary: config.secretCanary ?? "POLYROOT_SECRET_CANARY_NEVER_LOG_THIS",
      onAuditEntry: config.onAuditEntry,
      onMetric: config.onMetric,
    };
  }

  /**
   * Check an outbound request for egress permission.
   * Returns a result that includes the egress guard result plus category, policy decision, and audit info.
   */
  async check(input: EgressCheckInput): Promise<EgressFilterResult> {
    // Categorize the URL FIRST (before guard checks)
    const category = this.categorize(input.url);

    // Apply category policy
    const policyDecision = this.applyPolicy(category);

    // Run base egress guard check (SSRF, DNS rebind, etc.) WITHOUT the domain allowlist
    // so that policy and size/timeout decisions take precedence; the domain allowlist
    // is applied as a final safety net below.
    const guardResult = await this.guard.check({ ...input, skipDomainCheck: true });

    // Determine final decision:
    // 1. Guard blocks (SSRF/private IP/metadata/redirects) -> BLOCK (safety first)
    // 2. Category policy BLOCK -> POLICY_BLOCK
    // 3. Category policy QUARANTINE -> allow, log
    // 4. Size/timeout limits -> their specific codes
    // 5. Domain allowlist as final safety net
    let finalOk = guardResult.ok;
    let finalCode = guardResult.code;
    let finalReason = guardResult.reason;

    if (!guardResult.ok) {
      // Guard blocked for SSRF/private IP/metadata/redirect reasons - keep that decision
      finalOk = false;
    } else if (policyDecision === "BLOCK") {
      finalOk = false;
      finalCode = "POLICY_BLOCK";
      finalReason = `Blocked by policy for category ${category}`;
    } else if (policyDecision === "QUARANTINE") {
      // Quarantine means allow but log and maybe alert; we treat as allow for now.
      finalOk = true;
      finalCode = "POLICY_QUARANTINE";
      finalReason = `Quarantined by policy for category ${category}`;
    } else {
      // ALLOW - check response size and timeout limits
      if (input.responseSize !== undefined && input.responseSize > this.config.maxBodySize) {
        finalOk = false;
        finalCode = "BODY_TOO_LARGE";
        finalReason = `Response size ${input.responseSize} exceeds limit ${this.config.maxBodySize}`;
      } else if (input.delayMs !== undefined && input.delayMs > this.config.timeoutMs) {
        finalOk = false;
        finalCode = "TIMEOUT";
        finalReason = `Request delay ${input.delayMs}ms exceeds timeout ${this.config.timeoutMs}ms`;
      } else {
        // Final safety net: domain allowlist
        const domainCheck = this.checkDomainAllowlist(input.url);
        if (!domainCheck.ok) {
          finalOk = false;
          finalCode = domainCheck.code;
          finalReason = domainCheck.reason;
        } else {
          finalOk = true;
          finalCode = guardResult.code;
          finalReason = guardResult.reason;
        }
      }
    }

    // Generate audit ID
    const auditId = Math.random().toString(36).substring(2, 15);

    // Prepare audit entry (redact any payload-like fields from input)
    const auditPayload = {
      url: input.url,
      method: undefined, // input doesn't have method; but we can extend if needed
      redirectChain: input.redirectChain,
      responseSize: input.responseSize,
      delayMs: input.delayMs,
    };
    const redactedPayload = this.audit.redact(auditPayload as Record<string, unknown>);

    // Log audit entry
    this.audit.log({
      category,
      url: input.url,
      decision: finalOk ? "ALLOW" : "BLOCK",
      reason: finalReason ?? "no reason",
      redactedPayload,
      auditId,
    });

    // Emit metric (optional)
    this.config.onMetric?.(
      "egress_check_total",
      1,
      { category, decision: finalOk ? "allow" : "block", reason: finalCode ?? "unknown" },
    );

    // Build result
    const result: EgressFilterResult = {
      ...guardResult,
      ok: finalOk,
      category,
      policyDecision,
      auditId,
      loggedAt: new Date(),
    };
    if (finalCode !== undefined) {
      result.code = finalCode;
    } else {
      delete result.code;
    }
    if (finalReason !== undefined) {
      result.reason = finalReason;
    } else {
      delete result.reason;
    }
    return result;
  }

  /** Check domain allowlist for a URL. */
  private checkDomainAllowlist(url: string): { ok: boolean; code?: string; reason?: string } {
    try {
      const u = new URL(url);
      const hostname = u.hostname;
      
      // Skip domain check for IP addresses (they're checked by guard for private ranges)
      const isIPv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
      const isIPv6 = hostname.includes(":") && (hostname.startsWith("[") || hostname.includes("::"));
      if (isIPv4 || isIPv6) {
        return { ok: true };
      }
      
      if (!this.config.allowedDomains.some(d => hostname === d || hostname.endsWith("." + d))) {
        return { ok: false, code: "DOMAIN_NOT_ALLOWED", reason: `Domain ${hostname} not in allowlist` };
      }
    } catch {
      // Invalid URL - let guard handle it
    }
    return { ok: true };
  }

  /** Categorize a URL based on configured rules. */
  private categorize(url: string): EgressCategory {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      const path = u.pathname.toLowerCase();

      // Check each rule in order; first match wins.
      for (const rule of this.config.categoryRules) {
        if (rule.pattern.test(host) || rule.pattern.test(path) || rule.pattern.test(url)) {
          return rule.category;
        }
      }
    } catch (_) {
      // Invalid URL falls through to unknown
    }
    return "unknown";
  }

  /** Apply policy decision for a category (default ALLOW). */
  private applyPolicy(category: EgressCategory): "ALLOW" | "BLOCK" | "QUARANTINE" {
    const policy = this.config.categoryPolicy[category];
    return policy ?? "ALLOW";
  }

  /** Get audit logger (for testing). */
  getAuditLogger(): AuditLogger {
    return this.audit;
  }

  /** Update category rules at runtime (for testing). */
  updateCategoryRules(rules: Array<{ pattern: RegExp; category: EgressCategory }>): void {
    this.config.categoryRules = rules;
  }

  /** Update category policy at runtime (for testing). */
  updateCategoryPolicy(policy: Partial<Record<EgressCategory, "ALLOW" | "BLOCK" | "QUARANTINE">>): void {
    this.config.categoryPolicy = { ...this.config.categoryPolicy, ...policy };
  }
}

/** Default category rules for EgressFilter. */
export const DEFAULT_CATEGORY_RULES: Array<{ pattern: RegExp; category: EgressCategory }> = [
  // Research traffic
  { pattern: /news|blog|research|api\.news|api\.blog/i, category: "research" },
  { pattern: /\.gov|\.edu|arxiv|ssrn|repec/i, category: "research" },
  // Market data vendors
  { pattern: /api\.polymarket|cdn\.polymarket|gamma\.api\.polymarket/i, category: "market_data" },
  { pattern: /api\.coingecko|api\.coinmarketcap|api\.glassnode/i, category: "market_data" },
  // Executor/signer endpoints (internal)
  { pattern: /executor|signer|wallet|polyroot\.local/i, category: "executor" },
  // Strategy endpoints
  { pattern: /strategy|worker|compute/i, category: "strategy" },
  // Private DB (should never happen, but if it does)
  { pattern: /postgres|mysql|mongodb|redis/i, category: "private_db" },
  // External APIs (catch-all for known SaaS)
  { pattern: /api\.(github|gitlab|slack|discord|twitter|linkedin)\.com/i, category: "external_api" },
  // Generic external API pattern (e.g., api.external.com, api.foo.bar)
  { pattern: /^api\.[^.]+\.(com|net|org|io)$/i, category: "external_api" },
];

/** Default category policy (research may be quarantined in some environments). */
export const DEFAULT_CATEGORY_POLICY: Partial<Record<EgressCategory, "ALLOW" | "BLOCK" | "QUARANTINE">> = {
  research: "QUARANTINE", // research traffic allowed but logged and monitored
  market_data: "ALLOW",
  executor: "ALLOW",
  signer: "ALLOW",
  private_db: "BLOCK", // should never talk directly to private DB from untrusted contexts
  strategy: "ALLOW",
  external_api: "QUARANTINE", // external APIs require review
  unknown: "BLOCK", // unknown URLs blocked by default
};
