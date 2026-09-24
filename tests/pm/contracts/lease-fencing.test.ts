/**
 * Contract test for lease epoch fencing (PR-OPS-02, EXE-08).
 *
 * Verifies that permits bound to a stale lease epoch are rejected,
 * preventing split-brain submission after crash recovery.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemLeaseStore, MemPermitStore } from "@polyroot/venue";
import type { ExecutionPermit } from "@polyroot/domain";

describe("Lease epoch fencing (PR-OPS-02 / EXE-08)", () => {
  it("rejects permit validation when lease epoch mismatches", async () => {
    const leaseStore = new MemLeaseStore();
    const permitStore = new MemPermitStore();

    const walletId = "w1";

    // Epoch 1 acquires lease
    await leaseStore.acquireExecutorLease(walletId, "holder-1", 1, 30);

    // Create a permit with lease_epoch = 1
    const permit: ExecutionPermit = {
      schema_version: "1.0.0",
      permit_id: "permit-1",
      decision_id: "dec-1",
      intent_id: "intent-1",
      ledger_version: 1,
      policy_version: 1,
      policy_hash: "hash-1",
      quote_id: "quote-1",
      lease_epoch: 1,
      reservation_ids: ["res-1"],
      max_qty: 100,
      max_cash: 1000,
      allowed_order_style: ["LIMIT"],
      venue_mode: "NORMAL",
      issued_at: new Date(),
      expires_at: new Date(Date.now() + 60000),
      single_use: true,
      used_at: null,
      side: "YES",
      market_id: "mkt-1",
      price_min_base: null,
      price_max_base: null,
    };

    await permitStore.save(permit);

    // Epoch 2 takes over (simulates crash recovery)
    await leaseStore.acquireExecutorLease(walletId, "holder-2", 2, 30);

    // Epoch 1 permit validated against current epoch 2 should be rejected
    const valid = await permitStore.validatePermit(permit.permit_id, 2);
    assert.equal(valid, false, "stale epoch permit rejected");
  });

  it("accepts permit validation when lease epoch matches current epoch", async () => {
    const leaseStore = new MemLeaseStore();
    const permitStore = new MemPermitStore();

    const walletId = "w2";

    // Epoch 1 acquires lease
    await leaseStore.acquireExecutorLease(walletId, "holder-1", 1, 30);

    // Create a permit with lease_epoch = 1
    const permit: ExecutionPermit = {
      schema_version: "1.0.0",
      permit_id: "permit-2",
      decision_id: "dec-2",
      intent_id: "intent-2",
      ledger_version: 1,
      policy_version: 1,
      policy_hash: "hash-2",
      quote_id: "quote-2",
      lease_epoch: 1,
      reservation_ids: ["res-2"],
      max_qty: 100,
      max_cash: 1000,
      allowed_order_style: ["LIMIT"],
      venue_mode: "NORMAL",
      issued_at: new Date(),
      expires_at: new Date(Date.now() + 60000),
      single_use: true,
      used_at: null,
      side: "YES",
      market_id: "mkt-2",
      price_min_base: null,
      price_max_base: null,
    };

    await permitStore.save(permit);

    // Current epoch is 1, so permit should be valid
    const valid = await permitStore.validatePermit(permit.permit_id, 1);
    assert.equal(valid, true, "current epoch permit accepted");
  });

  it("returns false for non-existent permit", async () => {
    const permitStore = new MemPermitStore();
    const valid = await permitStore.validatePermit("non-existent", 1);
    assert.equal(valid, false, "non-existent permit returns false");
  });
});
