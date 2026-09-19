import { ExecutionPermitSchema } from "./src/pm/domain/src/index.ts";
import { Executor } from "./src/pm/executor/src/index.ts";
import { MemPermitStore, MemRecoveryLedger, MemLeaseStore } from "./src/pm/venue/src/index.ts";
import type { ExecutionPermit, SignedOrder, VenueMode } from "./src/pm/domain/src/index.ts";
import { randomUUID } from "crypto";

class FakeAdapter {
  mode: VenueMode = "NORMAL";
  async placeOrder() { return { ok: true, result: { success: true, submit_status: "ACKNOWLEDGED", order_status: "LIVE", timestamp: new Date() } }; }
  async cancelOrder() { return { ok: true, result: { success: true, submit_status: "ACKNOWLEDGED", timestamp: new Date() } }; }
  async getOrderStatus() { return null; }
  async getOrderBook() { throw new Error("not used"); }
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

function makeSignedOrder(id?: string, permitId?: string): SignedOrder {
  return {
    schema_version: "1.1",
    order_id: id && id.includes("-") ? id : randomUUID(),
    market_id: "mkt_1",
    side: "BUY",
    price: 0.5,
    size: 10,
    fee_rate_bps: 0,
    signature: "sig_1",
    signer: "0xSIGNER",
    signed_at: new Date("2026-01-01T00:00:30Z"),
    permit_id: permitId,
  };
}

const now = new Date("2026-01-01T00:00:30Z");
const seen = new Map<string, import("./src/pm/executor/src/index.ts").OrderLifecycleState>();
const permitStore = new MemPermitStore({ clock: () => now });
const recoveryLedger = new MemRecoveryLedger();
const leaseStore = new MemLeaseStore({ clock: () => now });

const deps = {
  adapter: new FakeAdapter(),
  now: () => now,
  seen: {
    has: (id: string) => seen.has(id),
    add: (id: string, state: import("./src/pm/executor/src/index.ts").OrderLifecycleState) => seen.set(id, state),
    get: (id: string) => seen.get(id),
  },
  permitStore,
  recoveryLedger,
  leaseEpoch: 1,
  walletId: "0xWALLET",
  holder: "0xHOLDER",
  leaseStore,
};

const ex = new Executor(deps);

// Test the exact scenario from the failing test
console.log("Testing fresh order submission...");
const permitObj = makePermit();
const orderObj = makeSignedOrder();

// Validate the permit before submitting
const permitCheck = ExecutionPermitSchema.safeParse(permitObj);
console.log("Permit validation:", permitCheck.success);
if (!permitCheck.success) {
  console.log("Permit errors:", JSON.stringify(permitCheck.error, null, 2));
}

const result = await ex.submit(orderObj, permitObj);
console.log("Result:", JSON.stringify(result, null, 2));
