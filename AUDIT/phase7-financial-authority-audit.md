# Phase 7: Financial Authority Audit Report

## Executive Summary

This report documents the comprehensive audit of the Financial Authority implementation in the Polyroot system, covering the MoneyAuthority interface, PgMoneyAuthority implementation, MoneyKernel integration, and error handling.

**Audit Date**: 2025-09-22  
**Auditor**: Phase 7 Financial Authority Audit  
**Scope**: MoneyAuthority interface, PgMoneyAuthority implementation, MoneyKernel integration, PgBalanceStore, PgKernelEventSink, Error Code Taxonomy

---

## Executive Summary

The Financial Authority implementation is **architecturally sound** with strong foundations for production use. The core implementation follows PostgreSQL best practices with REPEATABLE READ isolation, proper transaction management, and fail-closed error handling.

### Critical Findings Summary

| Severity     | Count | Description                                                                |
| ------------ | ----- | -------------------------------------------------------------------------- |
| **CRITICAL** | 1     | Fallback path in MoneyKernel when authority is not provided                |
| **HIGH**     | 4     | Missing error codes, hardcoded TTL, missing balance row creation           |
| **MEDIUM**   | 5     | Missing error codes, hardcoded TTL, missing timeouts, balance row creation |
| **LOW**      | 3     | Optional types in interface, missing timeouts, unbounded event payloads    |

---

## 7.1 MoneyAuthority Interface Contract Audit

### Interface Contract Analysis

**File**: `/root/polyroot-agent/src/pm/risk/src/money-kernel.ts` (lines 75-103)

#### Interface Contract: `MoneyAuthority`

```typescript
interface MoneyAuthority {
  reserve(
    account: string,
    asset: string,
    cashNeededBase: bigint,
    decisionId: string,
    intentId: string,
    leaseEpoch: number,
    now: Date,
    amountSharesBase?: bigint,
    policyHash?: string,
    quoteId?: string,
    riskDecision?: {
      schema_version: string;
      policy_version: string;
      ledger_version: string;
      allowed_order_style: string[];
      venue_mode: string;
    },
  ): Promise<MoneyAuthorityResult>;
}

type MoneyAuthorityResult =
  | { ok: true; reservationId: string; permitId: string }
  | { ok: false; reason: string; code: string };
```

### Interface Contract Audit Results

| Check                         | Status     | Details                                                       |
| ----------------------------- | ---------- | ------------------------------------------------------------- |
| Method signature completeness | ✅ PASS    | Single `reserve` method with all required parameters          |
| Parameter types               | ✅ PASS    | All parameters properly typed with `bigint`, `string`, `Date` |
| Optional parameters           | ✅ PASS    | Optional parameters properly marked with `?`                  |
| Return type                   | ✅ PASS    | Discriminated union with `ok` discriminant                    |
| Error code taxonomy           | ⚠️ PARTIAL | Missing `PERMIT_EXPIRED`, `BALANCE_ROW_MISSING`               |
| Parameter validation          | ⚠️ PARTIAL | JSDoc says "NOT empty string" but types allow `undefined`     |

**Finding FA-001**: Interface JSDoc states `policyHash` and `quoteId` are "NOT empty string" but type signature allows `undefined` (optional `?`).

---

## 7.2 PgMoneyAuthority Implementation Audit

### Transaction Atomicity ✅ PASS

```typescript
const client: PoolClient = await this.pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  // ... all operations ...
  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
} finally {
  client.release();
}
```

**PASS**: Proper BEGIN/COMMIT/ROLLBACK with REPEATABLE READ isolation level.

### Duplicate-Intent Guard (Lines 185-205)

```typescript
const dup = await client.query(
  `SELECT id FROM reservations WHERE intent_id = $1::uuid AND account = $2 AND asset = $3 AND status = 'ACTIVE' LIMIT 1`,
  [intentId, account, asset],
);
if (dup.rowCount && dup.rowCount > 0) {
  await client.query("ROLLBACK");
  return {
    ok: false,
    reason: "duplicate economic intent",
    code: "DUPLICATE_INTENT",
  };
}
```

**PASS**: Proper duplicate-intent guard with proper rollback and typed error code.

### Balance Locking (FOR UPDATE)

```typescript
const bal = await client.query(
  `SELECT available_base FROM balance_entries WHERE account = $1 AND asset = $2 FOR UPDATE`,
  [account, asset],
);
```

**PASS**: Proper `SELECT ... FOR UPDATE` for row-level locking.

### Gap: Missing Balance Row Creation

```typescript
const bal = await client.query(
  `SELECT available_base FROM balance_entries WHERE account = $1 AND asset = $2 FOR UPDATE`,
  [account, asset],
);
if (bal.rowCount === 0 || BigInt(bal.rows[0].available_base) < cashNeededBase) {
  await client.query("ROLLBACK");
  return {
    ok: false,
    reason: "INSUFFICIENT_AVAILABLE_BALANCE",
    code: "INSUFFICIENT_AVAILABLE_BALANCE",
  };
}
```

**Finding**: If balance row doesn't exist, returns `INSUFFICIENT_AVAILABLE_BALANCE` instead of creating the row (as `PgBalanceStore.get` does).

---

## Gap Analysis Summary

### Critical Issues (P0)

| ID     | Component        | Issue                                    | Severity |
| ------ | ---------------- | ---------------------------------------- | -------- |
| FA-001 | PgMoneyAuthority | Missing `PERMIT_EXPIRED` error code      | HIGH     |
| FA-002 | PgMoneyAuthority | Missing `BALANCE_ROW_MISSING` error code | HIGH     |
| FA-003 | MoneyKernel      | Fallback path when `!this.authority`     | CRITICAL |
| FA-004 | PgMoneyAuthority | Missing `PERMIT_EXPIRED` error code      | HIGH     |
| FA-005 | PgMoneyAuthority | Missing `BALANCE_ROW_MISSING` error code | HIGH     |

### Medium Issues

| ID     | Component                | Issue                                                         |
| ------ | ------------------------ | ------------------------------------------------------------- |
| MA-001 | MoneyAuthority interface | `policyHash`/`quoteId` optional in type but required per docs |
| MA-002 | PgMoneyAuthority         | Missing connection timeout config                             |
| MA-003 | PgMoneyAuthority         | Balance row not auto-created                                  |
| MA-004 | MoneyKernel              | `mode` not passed to authority                                |
| MA-005 | PgMoneyAuthority         | Hardcoded permit TTL (60s)                                    |

### Low Issues

| ID     | Component                | Issue                                                         |
| ------ | ------------------------ | ------------------------------------------------------------- |
| LA-001 | MoneyAuthority interface | `policyHash`/`quoteId` optional in type but required per docs |
| LA-002 | PgMoneyAuthority         | Missing connection timeout config                             |
| LA-003 | PgKernelEventSink        | Event payload size unbounded                                  |

---

## Recommendations

### Immediate (P0)

1. **Remove fallback path** in `MoneyKernel.reserve()` when `!this.authority`
2. Add missing error codes: `PERMIT_EXPIRED`, `BALANCE_ROW_MISSING`
3. Pass `mode` to authority for context-aware behavior

### Short-term (P1)

1. Add missing error codes to PgMoneyAuthority
2. Add connection/statement timeouts
3. Auto-create balance rows on first access
4. Make permit TTL configurable via `permitTtlMs`

### Follow-up

1. Add integration tests for error code paths
2. Add property-based tests for financial invariants
3. Add mutation testing for critical paths

---

## Verification Status

All findings are based on direct code inspection of:

- `/root/polyroot-agent/src/pm/risk/src/money-kernel.ts`
- `/root/polyroot-agent/src/pm/risk/src/money-kernel-pg.ts`
- `/root/polyroot-agent/src/pm/risk/src/money-kernel.ts`
- `/root/polyroot-agent/src/pm/control/src/orchestrator-pg.ts`
- `/root/polyroot-agent/src/pm/runtime/src/main.ts`

All findings are verifiable by direct code inspection.
