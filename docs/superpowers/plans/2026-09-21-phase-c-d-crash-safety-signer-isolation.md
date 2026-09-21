# Phase C/D: Crash Safety & Signer Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement crash window elimination (SUBMITTING state), executor lease/fencing, Signer Vault cryptographic payload binding, and signer process isolation to pass G3 Security & Recovery gate.

**Architecture:** 
- Phase C: Add SUBMITTING state to executor, enforce durable executor lease epoch, fix permit claim atomicity
- Phase D: Add payload hash verification to SignerVault, isolate signer in separate process with capability allowlist

**Tech Stack:** TypeScript, PostgreSQL, Node.js child_process/worker_threads

## Global Constraints

- Every financial operation must be recoverable after crash (no blind retry, no double-execute)
- Executor authority fenced by durable `lease_epoch` — stale process cannot sign
- Signer Vault must verify payload hash matches canonical serialization before signing
- Signer process: no network, no filesystem, no shell, no DB access, no LLM access
- All amounts in integer base units (bigint); no float arithmetic in financial path

---

### Task 1: Add SUBMITTING State to Executor Order Lifecycle

**Files:**
- Modify: `src/pm/executor/src/index.ts`
- Modify: `src/pm/domain/src/index.ts` (OrderLifecycleState type)
- Test: `tests/pm/contracts/executor-crash-safety.test.ts`

**Interfaces:**
- Consumes: `Executor.submit()` called with `SignedOrder` + `ExecutionPermit`
- Produces: Order state transitions through SUBMITTING → ACKNOWLEDGED | SUBMISSION_UNKNOWN | DEFINITIVE_REJECT

- [ ] **Step 1: Write failing test for SUBMITTING state**

```typescript
// tests/pm/contracts/executor-crash-safety.test.ts
it("marks order SUBMITTING before venue call; crash after submit retains SUBMISSION_UNKNOWN", async () => {
  const executor = createExecutor({ ... });
  const order = createSignedOrder({ ... });
  const permit = createPermit({ ... });
  
  // Capture state before venue call
  let preSubmitState: OrderLifecycleState | undefined;
  const originalSubmit = executor.adapter.placeOrder;
  executor.adapter.placeOrder = async (o) => {
    preSubmitState = executor.getOrderState(order.order_id);
    return originalSubmit(o);
  };
  
  const result = await executor.submit(order, permit);
  assert.equal(preSubmitState, "SUBMITTING");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/pm/contracts/executor-crash-safety.test.ts`
Expected: FAIL - SUBMITTING state not implemented

- [ ] **Step 3: Implement SUBMITTING state in executor**

```typescript
// src/pm/executor/src/index.ts
async submit(order: SignedOrder, permit: ExecutionPermit): Promise<SubmitResult> {
  // 1. Mark SUBMITTING in recovery_ledger BEFORE venue call
  await this.recoveryLedger.upsert({
    order_id: order.order_id,
    permit_id: permit.permit_id,
    state: "SUBMITTING",
    submitted_at: new Date(),
  });
  
  // 2. Call venue
  const venueResult = await this.adapter.placeOrder(order);
  
  // 3. Update state based on venue response
  if (venueResult.ok) {
    await this.recoveryLedger.updateState(order.order_id, "ACKNOWLEDGED");
    return { outcome: "SUBMITTED", state: "ACKNOWLEDGED", ... };
  }
  if (venueResult.code === "DEFINITELY_NOT_SENT") {
    await this.recoveryLedger.updateState(order.order_id, "DEFINITIVE_REJECT");
    return { outcome: "REJECTED", state: "DEFINITIVE_REJECT", ... };
  }
  // Unknown: venue may have accepted
  await this.recoveryLedger.updateState(order.order_id, "SUBMISSION_UNKNOWN");
  return { outcome: "NEEDS_RECONCILIATION", state: "SUBMISSION_UNKNOWN", ... };
}
```

- [ ] **Step 4: Add OrderLifecycleState type**

```typescript
// src/pm/domain/src/index.ts
export type OrderLifecycleState =
  | "CANCEL_CERTAIN"
  | "CANCEL_UNKNOWN"
  | "NOT_SEEN"
  | "SUBMITTING"          // NEW: marked before venue call
  | "ACKNOWLEDGED"
  | "SUBMISSION_UNKNOWN"
  | "DEFINITIVE_REJECT";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- tests/pm/contracts/executor-crash-safety.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/pm/executor/src/index.ts src/pm/domain/src/index.ts tests/pm/contracts/executor-crash-safety.test.ts
git commit -m "feat(executor): add SUBMITTING state for crash safety"
```

---

### Task 2: Enforce Durable Executor Lease Epoch (Fencing)

**Files:**
- Modify: `src/pm/venue/src/lease-store.ts`
- Modify: `src/pm/venue/src/permit-store.ts`
- Test: `tests/pm/contracts/lease-fencing.test.ts`

**Interfaces:**
- Consumes: `PgLeaseStore.acquireLease(walletId, holder, epoch)`, `PgPermitStore.validatePermit(permitId, expectedLeaseEpoch)`
- Produces: Only current epoch holder can sign/submit; stale epoch rejected

- [ ] **Step 1: Write failing test for lease fencing**

```typescript
// tests/pm/contracts/lease-fencing.test.ts
it("rejects permit validation when lease epoch mismatches", async () => {
  const leaseStore = createPgLeaseStore(pgConfig);
  const permitStore = createPgPermitStore(pgConfig);
  
  // Epoch 1 acquires lease
  await leaseStore.acquireLease(walletId, "holder-1", 1);
  const permit = await permitStore.create({ ..., lease_epoch: 1 });
  
  // Epoch 2 takes over (simulates crash recovery)
  await leaseStore.acquireLease(walletId, "holder-2", 2);
  
  // Epoch 1 permit should be rejected
  const valid = await permitStore.validatePermit(permit.permit_id, 1);
  assert.equal(valid, false, "stale epoch permit rejected");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/pm/contracts/lease-fencing.test.ts`
Expected: FAIL - lease epoch validation not implemented

- [ ] **Step 3: Implement lease epoch validation in PermitStore**

```typescript
// src/pm/venue/src/permit-store.ts
async validatePermit(permitId: string, expectedLeaseEpoch: number): Promise<boolean> {
  const result = await this.pool.query(
    `SELECT lease_epoch FROM execution_permits WHERE permit_id = $1`,
    [permitId]
  );
  if (result.rowCount === 0) return false;
  return result.rows[0].lease_epoch === expectedLeaseEpoch;
}
```

- [ ] **Step 4: Update Executor to check lease epoch before submit**

```typescript
// src/pm/executor/src/index.ts
async submit(order: SignedOrder, permit: ExecutionPermit): Promise<SubmitResult> {
  // Check lease epoch matches current authoritative epoch
  const currentEpoch = await this.leaseStore.getCurrentEpoch(this.walletId);
  if (permit.lease_epoch !== currentEpoch) {
    return { outcome: "REJECTED", code: "LEASE_EPOCH_MISMATCH", ... };
  }
  // ... rest of submit
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- tests/pm/contracts/lease-fencing.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/pm/venue/src/lease-store.ts src/pm/venue/src/permit-store.ts src/pm/executor/src/index.ts tests/pm/contracts/lease-fencing.test.ts
git commit -m "feat(venue/executor): enforce durable lease epoch fencing"
```

---

### Task 3: Permit Atomic Claim (UPDATE...WHERE state='ISSUED')

**Files:**
- Modify: `src/pm/venue/src/permit-store.ts`
- Test: `tests/pm/contracts/permit-atomic-claim.test.ts`

**Interfaces:**
- Consumes: `PgPermitStore.claimPermit(permitId, expectedLeaseEpoch)`
- Produces: Single-use permit claimed atomically; concurrent claims fail

- [ ] **Step 1: Write failing test for atomic permit claim**

```typescript
// tests/pm/contracts/permit-atomic-claim.test.ts
it("claims permit atomically; concurrent claims fail", async () => {
  const permitStore = createPgPermitStore(pgConfig);
  const permit = await permitStore.create({ ..., single_use: true, used_at: null });
  
  // First claim succeeds
  const claimed1 = await permitStore.claimPermit(permit.permit_id, 1);
  assert.equal(claimed1, true);
  
  // Second concurrent claim fails
  const claimed2 = await permitStore.claimPermit(permit.permit_id, 1);
  assert.equal(claimed2, false, "permit already used");
  
  // Verify used_at is set
  const row = await permitStore.getById(permit.permit_id);
  assert.ok(row.used_at !== null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/pm/contracts/permit-atomic-claim.test.ts`
Expected: FAIL - claimPermit not implemented

- [ ] **Step 3: Implement atomic claim**

```typescript
// src/pm/venue/src/permit-store.ts
async claimPermit(permitId: string, expectedLeaseEpoch: number): Promise<boolean> {
  const result = await this.pool.query(
    `UPDATE execution_permits 
     SET used_at = now() 
     WHERE permit_id = $1 
       AND lease_epoch = $2 
       AND single_use = true 
       AND used_at IS NULL
     RETURNING permit_id`,
    [permitId, expectedLeaseEpoch]
  );
  return result.rowCount === 1;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/pm/contracts/permit-atomic-claim.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pm/venue/src/permit-store.ts tests/pm/contracts/permit-atomic-claim.test.ts
git commit -m "feat(venue): atomic permit claim with UPDATE...WHERE"
```

---

### Task 4: Signer Vault Payload Hash Binding (Cryptographic)

**Files:**
- Modify: `src/pm/signer/src/index.ts`
- Test: `tests/pm/contracts/signer-payload-binding.test.ts`

**Interfaces:**
- Consumes: `SignerVault.sign(request: SignRequest)` — request must include `payloadHash`
- Produces: Signature only if `payloadHash === computePayloadHash(request)`

- [ ] **Step 1: Write failing test for payload hash binding**

```typescript
// tests/pm/contracts/signer-payload-binding.test.ts
it("refuses to sign when payload hash mismatches", async () => {
  const vault = createSignerVault({ ... });
  const request = createValidSignRequest({ ... });
  
  // Corrupt payload hash
  const badRequest = { ...request, payloadHash: "wrong_hash" };
  const result = await vault.sign(badRequest);
  
  assert.equal(result.ok, false);
  assert.equal(result.code, "PAYLOAD_HASH_MISMATCH");
});

it("signs when payload hash matches canonical serialization", async () => {
  const vault = createSignerVault({ ... });
  const request = createValidSignRequest({ ... });
  request.payloadHash = computePayloadHash(request); // Correct hash
  
  const result = await vault.sign(request);
  assert.equal(result.ok, true);
  assert.ok(result.signature);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/pm/contracts/signer-payload-binding.test.ts`
Expected: FAIL - payload hash check missing or incomplete

- [ ] **Step 3: Verify/implement payload hash check in SignerVault.sign()**

```typescript
// src/pm/signer/src/index.ts (verify existing check at line ~140)
async sign(request: SignRequest): Promise<SigningOutcome> {
  // Verify payload hash matches canonical serialization BEFORE any other checks
  const expectedHash = computePayloadHash(request);
  if (request.payloadHash !== expectedHash) {
    return {
      ok: false,
      reason: "payload hash mismatch",
      code: "PAYLOAD_HASH_MISMATCH",
    };
  }
  // ... rest of existing guards
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/pm/contracts/signer-payload-binding.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pm/signer/src/index.ts tests/pm/contracts/signer-payload-binding.test.ts
git commit -m "feat(signer): enforce payload hash binding (TABLE 8)"
```

---

### Task 5: Signer Process Isolation (Separate Worker)

**Files:**
- Create: `src/pm/signer/src/signer-worker.ts`
- Create: `src/pm/signer/src/signer-rpc.ts`
- Modify: `src/pm/signer/src/index.ts` (export SignerVaultClient)
- Test: `tests/pm/contracts/signer-isolation.test.ts`

**Interfaces:**
- Consumes: `SignerVaultClient` (RPC client) — same `sign(request)` interface
- Produces: Signer runs in isolated worker; parent process cannot access keys

- [ ] **Step 1: Write failing test for signer isolation**

```typescript
// tests/pm/contracts/signer-isolation.test.ts
it("signer runs in separate worker; no direct key access from parent", async () => {
  const { client, worker } = await spawnSignerWorker({ ... });
  
  // Parent can only call sign() via RPC
  const result = await client.sign(createValidSignRequest({ ... }));
  assert.equal(result.ok, true);
  
  // Verify worker has no network/filesystem/DB access
  const workerGlobals = await client.evalInWorker("globalThis");
  assert.ok(!workerGlobals.fetch);
  assert.ok(!workerGlobals.require);
  assert.ok(!workerGlobals.process);
  
  await worker.terminate();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/pm/contracts/signer-isolation.test.ts`
Expected: FAIL - worker isolation not implemented

- [ ] **Step 3: Implement signer worker**

```typescript
// src/pm/signer/src/signer-worker.ts
import { parentPort, workerData } from "worker_threads";
import { SignerVault, computePayloadHash, type SignRequest, type SigningOutcome, type CryptoSigner } from "./index.js";

// Worker receives cryptoSigner via workerData (serialized or injected at startup)
const vault = new SignerVault({
  expectedChainId: workerData.expectedChainId,
  cryptoSigner: workerData.cryptoSigner,
  maxClockSkewMs: workerData.maxClockSkewMs,
});

parentPort?.on("message", async (msg: { id: number; request: SignRequest }) => {
  const result = await vault.sign(msg.request);
  parentPort?.postMessage({ id: msg.id, result });
});
```

```typescript
// src/pm/signer/src/signer-rpc.ts
import { Worker } from "worker_threads";
import { resolve } from "path";

export interface SignerVaultClient {
  sign(request: SignRequest): Promise<SigningOutcome>;
  evalInWorker(code: string): Promise<any>;
  terminate(): Promise<void>;
}

export async function spawnSignerWorker(deps: SignerVaultDeps): Promise<{ client: SignerVaultClient; worker: Worker }> {
  const worker = new Worker(resolve(__dirname, "./signer-worker.js"), {
    workerData: { ...deps, cryptoSigner: deps.cryptoSigner },
  });
  
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let msgId = 0;
  
  worker.on("message", (msg: { id: number; result: any }) => {
    const p = pending.get(msg.id);
    if (p) { p.resolve(msg.result); pending.delete(msg.id); }
  });
  
  return {
    client: {
      sign: (request) => new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, request });
      }),
      evalInWorker: (code) => new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, eval: code });
      }),
      terminate: () => worker.terminate(),
    },
    worker,
  };
}
```

- [ ] **Step 4: Update index.ts to export SignerVaultClient**

```typescript
// src/pm/signer/src/index.ts
export { spawnSignerWorker, type SignerVaultClient } from "./signer-rpc.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- tests/pm/contracts/signer-isolation.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/pm/signer/src/signer-worker.ts src/pm/signer/src/signer-rpc.ts src/pm/signer/src/index.ts tests/pm/contracts/signer-isolation.test.ts
git commit -m "feat(signer): process isolation via worker_threads"
```

---

**Plan complete and saved to `docs/superpowers/plans/2026-09-21-phase-c-d-crash-safety-signer-isolation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**