import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  Executor,
  type OrderLifecycleState,
} from "@polyroot/executor";
import type { VenueAdapter, SubmitOutcome } from "@polyroot/venue";
import type {
  ExecutionPermit,
  SignedOrder,
  MarketSnapshot,
  OrderResult,
  VenueMode,
} from "@polyroot/domain";
import {
  MemPermitStore,
  MemRecoveryLedger,
  MemLeaseStore,
} from "@polyroot/venue";
import {
  InMemoryEventStore,
  PgOutboxProcessor,
} from "@polyroot/ledger";

class CountingAdapter implements VenueAdapter {
  mode: VenueMode = "NORMAL";
  calls: string[] = [];
  async getOrderBook(): Promise<MarketSnapshot> {
    throw new Error("not used in tests");
  }
  async placeOrder(_o: SignedOrder): Promise<SubmitOutcome> {
    this.calls.push("placeOrder");
    return {
      ok: true,
      result: {
        success: true,
        submit_status: "ACKNOWLEDGED",
        order_status: "LIVE",
        timestamp: new Date(),
      },
    };
  }
  async cancelOrder(_id: string): Promise<SubmitOutcome> {
    this.calls.push("cancelOrder");
    return {
      ok: true,
      result: {
        success: true,
        submit_status: "ACKNOWLEDGED",
        timestamp: new Date(),
      },
    };
  }
  async getOrderStatus(_id: string): Promise<OrderResult | null> {
    return null;
  }
  setMode(m: VenueMode) {
    this.mode = m;
  }
}

function makePermit(over: Partial<ExecutionPermit> = {}): ExecutionPermit {
  return {
    schema_version: "1.1",
    permit_id: randomUUID(),
    decision_id: randomUUID(),
    intent_id: randomUUID(),
    ledger_version: "0003",
    policy_version: "v0-bootstrap",
    policy_hash: "ph_audited",
    quote_id: "quote_x",
    lease_epoch: 1,
    reservation_ids: ["res_1"],
    max_qty: 100,
    max_cash: 50,
    max_qty_base: 100_000_000n,
    max_cash_base: 50_000_000n,
    market_id: "mkt_1",
    side: "BUY",
    price_min_base: 500_000n,
    price_max_base: 500_000n,
    allowed_order_style: ["LIMIT", "POST_ONLY"],
    venue_mode: "NORMAL",
    issued_at: new Date("2026-01-01T00:00:00Z"),
    expires_at: new Date("2026-01-01T00:01:00Z"),
    single_use: true,
    used_at: null,
    ...over,
  };
}

function makeOrder(id = "ord_1"): SignedOrder {
  return {
    schema_version: "1.1",
    order_id: id,
    market_id: "mkt_1",
    side: "BUY",
    price: 0.5,
    size: 10,
    fee_rate_bps: 0,
    signature: "sig_1",
    signer: "0xSIGNER",
    signed_at: new Date("2026-01-01T00:00:30Z"),
  };
}

function makeExecutor(adapter: CountingAdapter) {
  const now = new Date("2026-01-01T00:00:30Z");
  const seen = new Map<string, OrderLifecycleState>();
  return new Executor({
    adapter,
    now: () => now,
    seen: {
      has: (id: string) => seen.has(id),
      add: (id: string, st: OrderLifecycleState) => void seen.set(id, st),
      get: (id: string) => seen.get(id),
    },
    permitStore: new MemPermitStore({ clock: () => now }),
    recoveryLedger: new MemRecoveryLedger(),
    leaseEpoch: 1,
    walletId: "0xWALLET",
    holder: "0xHOLDER",
    leaseStore: new MemLeaseStore({ clock: () => now }),
  });
}

describe("Phase 23 G1 no-bypass: forged permits never reach the venue", () => {
  it("stale-epoch permit refuses with zero venue calls", async () => {
    const adapter = new CountingAdapter();
    const ex = makeExecutor(adapter);
    const res = await ex.submit(makeOrder(), makePermit({ lease_epoch: 999 }));
    assert.notEqual((res as any).outcome, "SUBMITTED");
    assert.deepEqual(adapter.calls, []);
  });

  it("permit/order binding mismatch refuses with zero venue calls", async () => {
    const adapter = new CountingAdapter();
    const ex = makeExecutor(adapter);
    const permit = makePermit();
    const order = { ...makeOrder(), permit_id: "some-other-permit" };
    const res = await ex.submit(order, permit);
    assert.notEqual((res as any).outcome, "SUBMITTED");
    assert.deepEqual(adapter.calls, []);
  });
});

describe("Phase 23 G1 restore lab: crash mid-batch redelivers, handler idempotent", () => {
  function ledgerEvent(id: string) {
    return {
      schema_version: "1.0",
      id,
      type: "ORDER_SUBMITTED",
      aggregate_id: "agg_1",
      aggregate_type: "Order",
      payload: { id },
      timestamp: new Date(),
    } as any;
  }

  function fakePoolWithCheckpoints() {
    // A real Pool instance (so `instanceof Pool` passes) with its query
    // transport stubbed: no network ever happens, yet the processor runs
    // its genuine checkpoint logic against an in-memory checkpoint row.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool } = createRequire(import.meta.url)("pg");
    let checkpoint: string | null = null;
    const pool = new Pool({
      connectionString: "postgresql://u:p@127.0.0.1:1/db",
    });
    (pool as any).query = async (sql: string, params: any[]) => {
      if (sql.includes("SELECT last_job_id")) {
        return { rows: checkpoint ? [{ last_job_id: checkpoint }] : [] };
      }
      if (sql.includes("UPDATE outbox_checkpoints")) {
        checkpoint = params[1];
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    };
    return {
      pool,
      getCheckpoint: () => checkpoint,
    };
  }

  it("checkpoint advances only past dispatched events; redelivery applies once", async () => {
    const store = new InMemoryEventStore();
    await store.append(ledgerEvent(randomUUID()));
    await store.append(ledgerEvent(randomUUID()));
    await store.append(ledgerEvent(randomUUID()));

    const fake = fakePoolWithCheckpoints();
    const processor = new PgOutboxProcessor(fake.pool as any, store);

    // First drain crashes on the second event (simulated process death:
    // checkpoint must NOT have advanced past the first event).
    const appliedFirst: string[] = [];
    await assert.rejects(
      processor.drain(async (job) => {
        appliedFirst.push(job.eventId);
        if (appliedFirst.length === 2) throw new Error("simulated crash");
      }),
    );
    assert.equal(appliedFirst.length, 2);
    assert.equal(fake.getCheckpoint(), appliedFirst[0]);

    // Second drain redelivers from the checkpoint; an idempotent handler
    // (deduped by event id) applies each unique event exactly once.
    const appliedUnique = new Set<string>();
    const second = await processor.drain(async (job) => {
      appliedUnique.add(job.eventId);
    });
    assert.equal(second.processed, 2);
    assert.equal(appliedUnique.size, 2);
  });
});
