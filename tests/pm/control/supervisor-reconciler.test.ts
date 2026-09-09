import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryPersistence } from "@polyroot/control";
import { Reconciler } from "@polyroot/control";
import { Supervisor } from "@polyroot/control";
import type { Executor, OrderLifecycleState } from "@polyroot/executor";
import type { RiskPolicy, SignedOrder } from "@polyroot/domain";

// Mock Executor for testing
class FakeExecutor {
  reconciledOrders = new Map<string, OrderLifecycleState>();

  async reconcile(orderId: string): Promise<OrderLifecycleState> {
    return this.reconciledOrders.get(orderId) ?? "ACKNOWLEDGED";
  }
}

describe("Phase 11: Supervisor & Reconciler Persistence", () => {
  const t0 = new Date("2026-09-09T00:00:00Z");
  const dummyPolicy: RiskPolicy = {
    schema_version: "1.0.0",
    policy_id: "pol_1",
    version: 1,
    max_position_per_market_usd: 100,
    max_portfolio_var_95_usd: 500,
    max_drawdown_daily_pct: 5,
    kill_switch_active: false,
    kill_switch_scope: "NONE",
    signer_lease_duration_sec: 300,
    lease_ttl_sec: 300,
    max_leverage: 1,
    max_loss_per_asset_usd: 50,
    min_edge_after_cost: 0.02,
    order_type_restriction: "POST_ONLY",
    reconcile_interval_s: 15,
  };

  it("stores and queries unknown orders using InMemoryPersistence", () => {
    const store = new InMemoryPersistence();
    store.set("o1", "SUBMISSION_UNKNOWN");
    store.set("o2", "ACKNOWLEDGED");

    assert.equal(store.get("o1"), "SUBMISSION_UNKNOWN");
    assert.equal(store.get("o2"), "ACKNOWLEDGED");
    assert.deepEqual(store.listUnknown(), ["o1"]);
  });

  it("reconciles unknown orders via Reconciler", async () => {
    const store = new InMemoryPersistence();
    store.set("o1", "SUBMISSION_UNKNOWN");
    store.set("o2", "SUBMISSION_UNKNOWN");

    const fakeExecutor = new FakeExecutor();
    fakeExecutor.reconciledOrders.set("o1", "ACKNOWLEDGED");
    fakeExecutor.reconciledOrders.set("o2", "DEFINITIVE_REJECT");

    const reconciler = new Reconciler(fakeExecutor as unknown as Executor, store);
    await reconciler.reconcileAll();

    assert.equal(store.get("o1"), "ACKNOWLEDGED");
    assert.equal(store.get("o2"), "DEFINITIVE_REJECT");
    assert.deepEqual(store.listUnknown(), []);
  });

  it("supervisor records orchestrate results and monitors health", () => {
    const store = new InMemoryPersistence();
    const fakeExecutor = new FakeExecutor();
    const reconciler = new Reconciler(fakeExecutor as unknown as Executor, store);

    const supervisor = new Supervisor({
      reconciler,
      persistence: store,
      policy: dummyPolicy,
      now: () => t0,
    });

    const dummyOrder: SignedOrder = {
      schema_version: "1.0.0",
      order_id: "ord_test_1",
      market_id: "mkt_1",
      token_id: "10001",
      side: "BUY",
      price: 0.5,
      size: 10,
      salt: "s1",
      signature: "0x123",
      signer: "0xabc",
      funder: "0xdef",
      expiration: 10000,
      nonce: 1,
    };

    // 1. Submit unknown outcome
    supervisor.onOrchestrateResult({
      ok: true,
      outcome: "NEEDS_RECONCILIATION",
      state: "SUBMISSION_UNKNOWN",
      order: dummyOrder,
      permit: {} as any,
    });

    let health = supervisor.getHealthReport();
    assert.equal(health.unknownOrderCount, 1);
    assert.equal(health.totalOrderCount, 1);

    // 2. Submit another acknowledged order
    supervisor.onOrchestrateResult({
      ok: true,
      outcome: "SUBMITTED",
      state: "ACKNOWLEDGED",
      order: { ...dummyOrder, order_id: "ord_test_2" },
      permit: {} as any,
    });

    health = supervisor.getHealthReport();
    assert.equal(health.unknownOrderCount, 1);
    assert.equal(health.totalOrderCount, 2);
  });
});
