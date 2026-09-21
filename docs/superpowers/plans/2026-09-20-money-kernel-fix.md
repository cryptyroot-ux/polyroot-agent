# Money Kernel Fix and Pipeline Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix critical Money Kernel financial defects (atomic reservation/permit) and resolve import conflicts in the G4 pipeline.

**Architecture:** 
1. **Pipeline Fix:** Clean up duplicate imports in `src/pm/runtime/src/g4-pipeline.ts` to restore buildability.
2. **Money Kernel Fix:** Refactor `src/pm/risk/src/money-kernel.ts` to enforce atomicity between reservations and permits, ensuring PostgreSQL consistency.

**Tech Stack:** TypeScript, PostgreSQL, Zod

## Global Constraints

- Use exact integer base-unit arithmetic (bigint) for all financial fields (no float drift).
- Every atomic reservation must be bound to a permit with matching ledger/policy versions.
- All operations must be PostgreSQL-transaction safe to avoid partial state.

---

### Task 1: Fix G4 Pipeline Import Conflicts

**Files:**
- Modify: `src/pm/runtime/src/g4-pipeline.ts`

**Interfaces:**
- Cleans up duplicate imports identified by build failure.

- [ ] **Step 1: Clean duplicate imports in `src/pm/runtime/src/g4-pipeline.ts`**
- [ ] **Step 2: Run build to verify clean**
- [ ] **Step 3: Commit**

---

### Task 2: Implement Atomic Money Kernel (Money Authority)

**Files:**
- Modify: `src/pm/risk/src/money-kernel.ts`

**Interfaces:**
- Updates `MoneyAuthority.reserve` to enforce transaction atomicity.

- [ ] **Step 1: Define atomic reservation structure**
- [ ] **Step 2: Implement atomic reservation logic**
- [ ] **Step 3: Run property tests**
- [ ] **Step 4: Commit**
