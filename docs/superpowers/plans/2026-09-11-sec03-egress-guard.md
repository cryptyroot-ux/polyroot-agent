# SEC-03: SSRF & Egress Protection Implementation Plan

## Goal
Implement SSRF & Egress Protection (PR-SEC-03P0, T-PR-SEC-03P0) per PRD §PR-SEC-03P0 and Blueprint T-PR-SEC-03P0.

**Requirement (PR-SEC-03P0):**
- Validate schemes/domains/IPs
- Block localhost/private/link-local/metadata ranges
- Revalidate redirects/DNS
- Cap size/decompression/time
- Route research traffic through controlled egress

**Acceptance (T-PR-SEC-03P0):**
> URL redirect/DNS-rebind to 127.0.0.1/RFC1918 is blocked and logged.

**Gate:** G2-G7

## Architecture

New module: `@polyroot/security` (or extend `@polyroot/security`) with:
- `EgressGuard` class - validates outbound requests
- `DnsResolver` with cache + TTL + RFC1918/localhost/metadata blocking
- `HttpClientWrapper` - wraps fetch/http clients with guard
- `RedirectValidator` - follows redirects up to max depth, blocks private ranges

## Files to Create/Modify

| File | Purpose |
|------|---------|
| `src/pm/security/src/egress-guard.ts` | Core egress guard logic |
| `src/pm/security/src/dns-resolver.ts` | DNS resolver with RFC1918/localhost blocking |
| `src/pm/security/src/egress-guard.ts` | Main egress guard class |
| `src/pm/security/src/http-client.ts` | Wrapper for fetch/undici with guard |
| `src/pm/security/src/index.ts` | Exports |
| `tests/pm/contracts/egress-guard.test.ts` | Contract tests |

## Test Plan (TDD)

### Test File: `tests/pm/contracts/egress-guard.test.ts`

**Test Cases (from T-PR-SEC-03P0):**
1. `GET http://127.0.0.1` → blocked & logged
2. `GET http://10.0.0.1` (RFC1918) → blocked
3. `GET http://169.254.169.254` (AWS metadata) → blocked
4. `GET http://[::1]` → blocked
5. `GET http://localhost` → blocked
4. Redirect chain: `example.com` → `127.0.0.1` → blocked
5. DNS rebind: domain resolving to 127.0.0.1 after first request → blocked
6. Private IP ranges blocked: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 127.0.0.0/8, ::1/128, fc00::/7
7. Redirect chain validation (max 5 hops)
8. DNS cache TTL respected, revalidation on TTL expiry
9. Size limit enforcement (configurable max body)
10. Decompression bomb protection (max ratio)
11. Timeout enforcement (connect/read/write)
12. Allowed domains/IPs pass through
12. Logs contain blocked attempt details

## Implementation Steps

### Step 1: Write failing tests (RED)
- [ ] Create `tests/pm/contracts/egress-guard.test.ts` with all test cases
- [ ] Run tests → confirm RED

### Step 2: Implement minimal (GREEN)
- [ ] `src/pm/security/src/egress-guard.ts` - main guard class
- [ ] `src/pm/security/src/dns-resolver.ts` - DNS resolver with blocking
- [ ] `src/pm/security/src/http-client.ts` - wrapped fetch client
- [ ] `src/pm/security/src/egress-guard.ts` - main export
- [ ] Export from `src/pm/security/src/index.ts`

### Step 3: Run tests → GREEN

### Step 4: Lint + Typecheck + Build

### Step 5: Commit

---

## Acceptance Criteria (from T-PR-SEC-03P0)

> **URL redirect/DNS-rebind to 127.0.0.1/RFC1918 is blocked and logged.**

Test verifies:
- Direct request to 127.0.0.1 blocked
- Redirect chain resolving to 127.0.0.1 blocked
- DNS rebind (domain initially resolves to public IP, then to 127.0.0.1) blocked
- All RFC1918 ranges blocked
- Metadata endpoints (169.254.169.254, 169.254.169.254) blocked
- Logs contain blocked attempt details

---

## Dependencies
- `undici` or native `fetch` with `undici` for HTTP
- `dns` (Node built-in) for DNS resolution
- `ipaddr.js` or custom IP range matching

## Acceptance Criteria (Definition of Done)

- [ ] All contract tests pass (GREEN)
- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] `npm run test:unit` all pass
- [ ] `npm run traceability` passes
- [ ] Commit with conventional commit message

---

## Risk Mitigation
- DNS rebinding protection requires DNS cache with short TTL and re-resolution on redirect
- Redirect following must have max depth (5) and total size limit
- Decompression bomb protection (gzip bomb)
- Timeout enforcement (connect/read/write)
- Size limits on response bodies

---

**Ready to execute?** If approved, I'll start with Step 1 (write failing tests).