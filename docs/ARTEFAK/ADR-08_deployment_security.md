# ADR-08: Deployment/Security/Signer Vault/Egress Isolation/Backup/Rollback

**Status:** Accepted
**Date:** 2026-09-09
**Deciders:** Crypty Root (Tech Lead)
**Technical Story:** PR-SEC-04/05/07, PR-OPS-01/02/04/06/07; Blueprint B13, B14

---

## Context

Privilege separation on paper means nothing if every container shares one
network, one secret mount and one database role. The 24/7 runtime needs
separated deployment roles, a signer vault with the smallest possible
blast radius, controlled research egress, encrypted off-host backups with
proven restores, and rollback that refuses incompatible schemas while
keeping live orders reconcilable.

## Decision

### 1. Separated deployment roles (PR-OPS-01, Blueprint B14.1)

Reverse proxy, gateway/control, data/research, intelligence, strategy
workers, money kernel/executor, signer vault, PostgreSQL and
backup/monitoring run as separate units with private networks and
least-privilege roles: the proxy exposes only public HTTPS dashboard/API;
the gateway holds no trading secret; data/research/intelligence carry
read-only/research roles with CPU/memory limits so research can never
starve execution (PR-OPS-06); strategy workers are sandboxed to exact
strategy images with proposal-only output (PR-SEC-05); money
kernel/executor sit on the private network under the single wallet-lease
authority with financial DB roles and no general web browsing or LLM;
PostgreSQL binds privately with per-role credentials, connection/statement
limits and WAL/disk monitoring. A network-policy test proves research and
gateway cannot reach the signer socket or the financial DB writer role
(T-PR-OPS-01). Clock is synchronized and signing blocks when skew/health
exceeds policy.

### 2. Signer vault checks (PR-WAL-07, Blueprint B5.2)

Before signing: permit exists, durable, unexpired and unused where
single-use applies, with matching intent/payload/policy/lease hashes;
expected signer/account wallet/wallet type on Polygon/current contract
registry; only allowlisted order/cancel/position-lifecycle actions, no
arbitrary destination or calldata; canonical exact amount within permit
reservation and hard policy; quote/market/rules/venue-mode/clock within TTL;
canonical payload hash recorded before side effect with raw key material
never logged. Initial capacity target: ~4 vCPU / 8 GiB RAM / ≥40 GiB free
SSD plus off-host backup, benchmarked against real market/stream/research
load before co-locating anything heavy.

### 3. Secret isolation (PR-SEC-04)

Trading, L2, relayer/builder and provider secrets live only in required
service scopes (secret store/file permissions, per-service mounts).
Logs, prompts, exports, telemetry, backups and debug paths are redacted
and secret-canary tested: the canary must never appear after fault and
debug paths (T-PR-SEC-04).

### 4. Authenticated product API (PR-SEC-07)

Dashboard behind TLS with strong owner auth, secure sessions, CSRF
protection and reauthentication for governance; internal routes, DB and
executor are never internet-exposed. Unauthenticated internet clients can
neither read the portfolio, mutate policy nor reach internal executor
routes (T-PR-SEC-07).

### 5. Backup, PITR and rollback (PR-OPS-04/07)

Encrypted PostgreSQL base backup/WAL (or equivalent) off-host plus
config/manifest backup, targeting RPO 15m / RTO 60m — proven by a restore
drill on a clean machine that reports measured RPO/RTO, lost/gap data and
post-restore reconciliation; entry stays blocked until state reconciles
(T-PR-OPS-04). Builds are reproducible and immutable with tested
migration/rollback compatibility; PAPER canary deploys first; LIVE
binaries never self-update; incompatible-schema rollback is refused while
existing live orders stay reconcilable across deployment (T-PR-OPS-07).

## Consequences

### Positive

- A compromise anywhere outside the vault buys the attacker nothing
  financial.
- Recovery is a drilled procedure with measured numbers, not a hope.

### Negative

- Role-separated, TLS-terminated, backup-drilled operations are real
  ongoing toil on a single VPS.

## Validation

- T-PR-OPS-01/02/04/06/07, T-PR-SEC-04/05/07, T-PR-WAL-07.

## Related

- ADR-01 (allowlist), ADR-02 (credentials), ADR-04 (leases/recovery)
- Blueprint B13, B14; PR-SEC-04/05/07, PR-OPS-01/02/04/06/07
