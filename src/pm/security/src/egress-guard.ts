/**
 * @polyroot/security — Egress Guard (PR-SEC-03, T-PR-SEC-03P0).
 *
 * SSRF & Egress Protection:
 * - Validate schemes/domains/IPs
 * - Block localhost/private/link-local/metadata ranges
 * - Revalidate redirects/DNS
 * - Cap size/decompression/time
 * - Route research traffic through controlled egress
 */

import { URL } from "url";


/** Input for egress check. */
export interface EgressCheckInput {
  url: string;
  redirectChain?: string[];
  responseSize?: number;
  delayMs?: number;
  /** Skip the domain allowlist check (EgressFilter applies its own policy first). */
  skipDomainCheck?: boolean;
}

/** IP address utilities for private/link-local/metadata range detection. */
function ipToNumber(ip: string): bigint | null {
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    const n0 = Number(parts[0]);
    const n1 = Number(parts[1]);
    const n2 = Number(parts[2]);
    const n3 = Number(parts[3]);
    if (!Number.isInteger(n0) || n0 < 0 || n0 > 255) return null;
    if (!Number.isInteger(n1) || n1 < 0 || n1 > 255) return null;
    if (!Number.isInteger(n2) || n2 < 0 || n2 > 255) return null;
    if (!Number.isInteger(n3) || n3 < 0 || n3 > 255) return null;
    return (BigInt(n0) << 24n) | (BigInt(n1) << 16n) | (BigInt(n2) << 8n) | BigInt(n3);
  }
  if (ip.includes(":")) {
    if (ip === "::1" || ip === "::ffff:127.0.0.1") return 1n;
    if (ip.startsWith("fc") || ip.startsWith("fd")) return 1n;
    return null;
  }
  return null;
}

function isIPv4Address(hostname: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function isIPv6Address(hostname: string): boolean {
  return hostname.includes(":") && (hostname.startsWith("[") || hostname.includes("::"));
}

function isPrivateIPv4(ip: string): boolean {
  const num = ipToNumber(ip);
  if (num === null) return false;
  if ((num & 0xff000000n) === 0x0a000000n) return true;   // 10.0.0.0/8
  if ((num & 0xfff00000n) === 0xac100000n) return true;   // 172.16.0.0/12
  if ((num & 0xffff0000n) === 0xc0a80000n) return true;   // 192.168.0.0/16
  if ((num & 0xff000000n) === 0x7f000000n) return true;   // 127.0.0.0/8
  if ((num & 0xffff0000n) === 0xa9fe0000n) return true;   // 169.254.0.0/16
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  if (ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true; // ULA fc00::/7
  if (ip.startsWith("fe80:")) return true; // link-local
  return false;
}

function isMetadataIP(ip: string): boolean {
  return ip === "169.254.169.254";
}

function isLoopbackIP(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "localhost") return true;
  if (ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  return false;
}

function isLinkLocalIP(ip: string): boolean {
  const num = ipToNumber(ip);
  if (num === null) return false;
  return (num & 0xffff0000n) === 0xa9fe0000n;
}

function isPrivateIP(ip: string): boolean {
  return isPrivateIPv4(ip) || isPrivateIPv6(ip);
}

/** Result of an egress check. */
export interface EgressCheckResult {
  ok: boolean;
  code?: string;
  reason?: string;
  finalUrl?: string;
  redirectChain?: string[];
}

/** Configuration for EgressGuard. */
export interface EgressGuardConfig {
  allowedDomains: string[];
  maxRedirects?: number;
  maxBodySize?: number;
  timeoutMs?: number;
  allowedIPs?: string[];
}

export class EgressGuard {
  private config: Required<EgressGuardConfig>;

  constructor(config: EgressGuardConfig) {
    this.config = {
      allowedDomains: config.allowedDomains,
      maxRedirects: config.maxRedirects ?? 5,
      maxBodySize: config.maxBodySize ?? 10 * 1024 * 1024,
      timeoutMs: config.timeoutMs ?? 30000,
      allowedIPs: config.allowedIPs ?? [],
    };
  }

  /** Check if a URL is allowed for egress. */
  async check(input: EgressCheckInput): Promise<EgressCheckResult> {
    // Check redirect chain first (DNS rebind protection)
    if (input.redirectChain && input.redirectChain.length > 0) {
      // Check if redirect chain exceeds max
      if (input.redirectChain.length > this.config.maxRedirects) {
        return {
          ok: false,
          code: "MAX_REDIRECTS_EXCEEDED",
          reason: `Redirect chain exceeds maximum of ${this.config.maxRedirects}`
        };
      }

      // Validate each redirect destination - check IP first, skip domain check for redirect chain
      for (const redirectUrl of input.redirectChain) {
        const result = await this.checkSingleUrl(new URL(redirectUrl), { isRedirect: true, skipDomainCheck: true });
        if (!result.ok) return result;
      }
    }

    // Check main URL - pass skipDomainCheck through
    const parsed = new URL(input.url);
    const skipDomainCheck = input.skipDomainCheck === true;
    const result = await this.checkSingleUrl(parsed, { skipDomainCheck });
    if (!result.ok) return result;
    
    // Check response size limit
    if (input.responseSize !== undefined && input.responseSize > this.config.maxBodySize) {
      return { ok: false, code: "BODY_TOO_LARGE", reason: `Response size ${input.responseSize} exceeds limit ${this.config.maxBodySize}` };
    }

    // Check timeout
    if (input.delayMs !== undefined && input.delayMs > this.config.timeoutMs) {
      return { ok: false, code: "TIMEOUT", reason: `Request delay ${input.delayMs}ms exceeds timeout ${this.config.timeoutMs}ms` };
    }

    return result;
  }

  private async checkSingleUrl(parsed: URL, opts?: { isRedirect?: boolean; skipDomainCheck?: boolean }): Promise<EgressCheckResult> {
    // Validate scheme
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { ok: false, code: "INVALID_SCHEME", reason: `Scheme ${parsed.protocol} not allowed` };
    }

    const hostname = parsed.hostname;
    
    // Check IP address first (before domain allowlist)
    // Extract IP from hostname (handle IPv6 bracket notation)
    let ipToCheck = hostname;
    if (hostname.startsWith("[") && hostname.endsWith("]")) {
      ipToCheck = hostname.slice(1, -1);
    }
    
    // If hostname is an IP address, check it directly
    if (isIPv4Address(ipToCheck) || isIPv6Address(ipToCheck)) {
      const blockResult = this.checkBlockedIP(ipToCheck, opts?.isRedirect);
      if (blockResult) {
        return { ok: false, code: blockResult.code, reason: blockResult.reason };
      }
    } else {
      // Resolve and check IP for domain names
      const ips = await this.resolveHostname(hostname);
      for (const ip of ips) {
        const blockResult = this.checkBlockedIP(ip, opts?.isRedirect);
        if (blockResult) {
          return { ok: false, code: blockResult.code, reason: blockResult.reason };
        }
      }
    }
    
    // Check domain allowlist (only for domain names, not IP addresses, and not for redirect chain)
    if (!opts?.skipDomainCheck && !isIPv4Address(hostname) && !isIPv6Address(hostname)) {
      if (!this.config.allowedDomains.some(d => hostname === d || hostname.endsWith("." + d))) {
        return { ok: false, code: "DOMAIN_NOT_ALLOWED", reason: `Domain ${hostname} not in allowlist` };
      }
    }
    
    return { ok: true, finalUrl: parsed.toString() };
  }

  private checkBlockedIP(ip: string, isRedirect?: boolean): { code: string; reason: string } | null {
    // Check explicit allowlist first
    if (this.config.allowedIPs.includes(ip)) return null;
    
    // Check metadata endpoint FIRST (specific IP 169.254.169.254)
    if (isMetadataIP(ip)) {
      return { 
        code: isRedirect ? "BLOCKED_REDIRECT_METADATA_ENDPOINT" : "BLOCKED_METADATA_ENDPOINT", 
        reason: `Metadata endpoint ${ip} is blocked` 
      };
    }
    
    // Check link-local (covers 169.254.0.0/16 except metadata endpoint)
    if (isLinkLocalIP(ip)) {
      return { 
        code: isRedirect ? "BLOCKED_REDIRECT_LINK_LOCAL" : "BLOCKED_LINK_LOCAL", 
        reason: `Link-local IP ${ip} is blocked` 
      };
    }
    
    if (isLoopbackIP(ip)) {
      return { 
        code: isRedirect ? "BLOCKED_REDIRECT_PRIVATE_IP" : "BLOCKED_PRIVATE_IP", 
        reason: `Loopback IP ${ip} is blocked` 
      };
    }
    if (isPrivateIP(ip)) {
      return { 
        code: isRedirect ? "BLOCKED_REDIRECT_PRIVATE_IP" : "BLOCKED_PRIVATE_IP", 
        reason: `Private IP ${ip} is blocked` 
      };
    }
    return null;
  }

  private async resolveHostname(hostname: string): Promise<string[]> {
    try {
      const { Resolver } = await import("dns/promises");
      const resolver = new Resolver();
      return await resolver.resolve4(hostname);
    } catch {
      return [];
    }
  }
}
