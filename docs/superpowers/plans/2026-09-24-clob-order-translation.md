# CLOB Order Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate our domain `SignedOrder` (LIMIT/POST_ONLY) into SDK `placeLimitOrder` calls so MICRO_LIVE can submit real orders through the secure client, with every untranslatable case refused fail-closed.

**Architecture:** Pure function `translateDomainOrderToLimit` in new `order-translation.ts` (no network, fully unit-testable). `placeOrder` flow becomes: mode gate → CLOB-shaped direct post → domain-shaped translate → `placeLimitOrder` → map 0.9 response. Response mapper handles both SDK 0.9 (`ok`/`orderId`) and legacy (`success`/`orderID`) shapes.

**Tech Stack:** TypeScript, `@polymarket/client` 0.9.0, Node test runner + `tsx`.

## Global Constraints

- Node.js `>=24.0.0`; gates `npm run ci` + secret scan.
- No network in unit tests.
- Only LIMIT and POST_ONLY translate. FOK/IOC/expiration/market-id-opaque refuse with named codes.
- Never round through float for money: pass through domain `price`/`size` numbers unchanged (they already are human-unit shares/probability).

---

### Task 1: Pure translation function (TDD)

**Files:**
- Create: `src/pm/venue/src/order-translation.ts`
- Modify: `src/pm/venue/src/index.ts` (export)
- Test: `tests/pm/contracts/venue-order-translation.test.ts` (new)

**Interfaces:**
- Consumes: domain `SignedOrder`.
- Produces: `{ ok: true; request: LimitOrderRequest } | { ok: false; code; reason }` where `LimitOrderRequest = { assetId: string; price: number; size: number; side: "BUY" | "SELL"; postOnly: boolean }`.

Translation rules:
- `market_id` must match `/^(0x[0-9a-fA-F]+|[0-9]+)$/` else `VENUE_MARKET_UNRESOLVED` (rejects `mkt_*`, `mock_*`, opaque ids).
- `order_type`: `LIMIT` → `postOnly: false`; `POST_ONLY` → `postOnly: true`; missing → LIMIT; `FOK`/`IOC` → `VENUE_ORDER_TYPE_UNSUPPORTED`.
- `expiration` present → `VENUE_EXPIRATION_UNSUPPORTED` (GTD semantics need explicit design).
- `price` must be finite and `0 < price < 1` else `VENUE_PRICE_INVALID`; `size` finite `> 0` else `VENUE_SIZE_INVALID`.
- Pass `price`/`size` through unchanged (domain already stores human-unit shares and probability).

- [ ] **Step 1: Write the failing test**

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { translateDomainOrderToLimit } from "@polyroot/venue";

const BASE = {
  schema_version: "1.1",
  order_id: "00000000-0000-4000-8000-000000000001",
  side: "BUY",
  price: 0.55,
  size: 10,
  fee_rate_bps: 0,
  signature: "0xsig",
  signer: "0x" + "1".repeat(40),
  signed_at: new Date(0),
} as const;

describe("domain to CLOB limit-order translation", () => {
  it("translates a LIMIT order with a hex asset id", () => {
    const res = translateDomainOrderToLimit({
      ...BASE,
      market_id: "0x" + "ab".repeat(32),
      order_type: "LIMIT",
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.request.assetId, "0x" + "ab".repeat(32));
      assert.equal(res.request.price, 0.55);
      assert.equal(res.request.size, 10);
      assert.equal(res.request.side, "BUY");
      assert.equal(res.request.postOnly, false);
    }
  });

  it("maps POST_ONLY to postOnly", () => {
    const res = translateDomainOrderToLimit({
      ...BASE,
      market_id: "12345",
      order_type: "POST_ONLY",
    });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.request.postOnly, true);
  });

  it("refuses opaque market ids", () => {
    for (const market_id of ["mkt_abc", "mock_market_1", ""]) {
      const res = translateDomainOrderToLimit({ ...BASE, market_id });
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.code, "VENUE_MARKET_UNRESOLVED");
    }
  });

  it("refuses FOK/IOC, expirations, and bad price/size", () => {
    const fok = translateDomainOrderToLimit({
      ...BASE,
      market_id: "123",
      order_type: "FOK",
    });
    assert.equal(fok.ok, false);
    if (!fok.ok) assert.equal(fok.code, "VENUE_ORDER_TYPE_UNSUPPORTED");

    const exp = translateDomainOrderToLimit({
      ...BASE,
      market_id: "123",
      expiration: 9999999999,
    });
    assert.equal(exp.ok, false);
    if (!exp.ok) assert.equal(exp.code, "VENUE_EXPIRATION_UNSUPPORTED");

    const badPrice = translateDomainOrderToLimit({
      ...BASE,
      market_id: "123",
      price: 1.5,
    });
    assert.equal(badPrice.ok, false);
    if (!badPrice.ok) assert.equal(badPrice.code, "VENUE_PRICE_INVALID");

    const badSize = translateDomainOrderToLimit({
      ...BASE,
      market_id: "123",
      size: 0,
    });
    assert.equal(badSize.ok, false);
    if (!badSize.ok) assert.equal(badSize.code, "VENUE_SIZE_INVALID");
  });
});
```

- [ ] **Step 2: Run test, expect FAIL** (`translateDomainOrderToLimit is not a function`):

```bash
node --test --import tsx tests/pm/contracts/venue-order-translation.test.ts
```

- [ ] **Step 3: Implement** `src/pm/venue/src/order-translation.ts` per the rules above; export from `index.ts`.
- [ ] **Step 4: Build venue + run test, expect PASS**:

```bash
npm run build --workspace=@polyroot/venue && node --test --import tsx tests/pm/contracts/venue-order-translation.test.ts
```

---

### Task 2: Wire translation into placeOrder + 0.9 response mapping (TDD)

**Files:**
- Modify: `src/pm/venue/src/polymarket-adapter.ts`
- Modify: `tests/pm/contracts/venue-sdk-bind.test.ts`
- Test: same file + translation test file.

**Interfaces:**
- Consumes: `translateDomainOrderToLimit`, client with optional `placeLimitOrder`.
- Produces: domain orders that translate are submitted via `placeLimitOrder`; untranslatable or missing-method cases refuse without network.

placeOrder flow (after mode gate):
1. CLOB-shaped → existing `postOrder` path (unchanged).
2. Else translate: fail → return `{ ok: false, code, reason }` (no client call).
3. Translated + `client.placeLimitOrder` present → call with request; map response:
   - `{ ok: true, orderId }` → `{ ok: true, result: { success: true, order_id: orderId, timestamp } }`
   - `{ ok: false, code, message }` → `{ ok: false, code: "VENUE_REJECTED", reason: message ?? code }`
   - legacy `{ success, orderID/orderId, errorMsg }` → existing mapping (keep).
   - thrown error → existing network/unknown classification (keep).
4. Translated but no `placeLimitOrder` on client → `VENUE_ORDER_SHAPE_UNSUPPORTED` (existing code).

Add `placeLimitOrder?(request: unknown): Promise<unknown>` to `PolymarketClientLike`.

- [ ] **Step 1: Write failing tests** in `venue-sdk-bind.test.ts`:

```typescript
it("submits translatable domain orders via placeLimitOrder", async () => {
  let seen: unknown;
  const client: PolymarketClientLike = {
    fetchOrderBook: async () => ({ bids: [], asks: [] }),
    placeLimitOrder: async (req: unknown) => {
      seen = req;
      return { ok: true, orderId: "clob_1", status: "live" };
    },
  };
  const adapter = new PolymarketVenueAdapter(client);
  const res = await adapter.placeOrder({
    order_id: "o1",
    market_id: "12345",
    side: "SELL",
    price: 0.4,
    size: 5,
    fee_rate_bps: 0,
    signature: "0xsig",
    signer: "0x" + "1".repeat(40),
    signed_at: new Date(0),
    order_type: "LIMIT",
  } as never);
  assert.equal(res.ok, true);
  assert.deepEqual(seen, {
    assetId: "12345",
    price: 0.4,
    size: 5,
    side: "SELL",
    postOnly: false,
  });
  if (res.ok) assert.equal(res.result.order_id, "clob_1");
});

it("maps rejected 0.9 responses to VENUE_REJECTED", async () => {
  const client: PolymarketClientLike = {
    fetchOrderBook: async () => ({ bids: [], asks: [] }),
    placeLimitOrder: async () => ({
      ok: false,
      code: "INSUFFICIENT_BALANCE",
      message: "no funds",
    }),
  };
  const adapter = new PolymarketVenueAdapter(client);
  const res = await adapter.placeOrder({
    order_id: "o1",
    market_id: "12345",
    side: "BUY",
    price: 0.5,
    size: 1,
    fee_rate_bps: 0,
    signature: "0xsig",
    signer: "0x" + "1".repeat(40),
    signed_at: new Date(0),
  } as never);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, "VENUE_REJECTED");
    assert.match(res.reason, /no funds/);
  }
});

it("refuses FOK domain orders without calling the client", async () => {
  let called = 0;
  const client: PolymarketClientLike = {
    fetchOrderBook: async () => ({ bids: [], asks: [] }),
    placeLimitOrder: async () => {
      called += 1;
      return { ok: true, orderId: "x" };
    },
  };
  const adapter = new PolymarketVenueAdapter(client);
  const res = await adapter.placeOrder({
    order_id: "o1",
    market_id: "12345",
    side: "BUY",
    price: 0.5,
    size: 1,
    fee_rate_bps: 0,
    signature: "0xsig",
    signer: "0x" + "1".repeat(40),
    signed_at: new Date(0),
    order_type: "FOK",
  } as never);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "VENUE_ORDER_TYPE_UNSUPPORTED");
  assert.equal(called, 0);
});
```

- [ ] **Step 2: Run, expect the 3 new tests FAIL.**
- [ ] **Step 3: Implement** per flow above.
- [ ] **Step 4: Build + run both venue test files, expect all PASS.**

---

### Task 3: Docs + full verification

**Files:**
- Modify: `docs/PUBLIC_API.md` (replace the `VENUE_ORDER_SHAPE_UNSUPPORTED`-blocks-everything note with the supported set: LIMIT/POST_ONLY, no expiration).
- Test: `npm run ci` (exit 0), prettier, `git diff --check`, gitleaks.
