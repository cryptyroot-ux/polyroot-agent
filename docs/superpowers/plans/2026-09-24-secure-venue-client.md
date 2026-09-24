# Secure Venue Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire a real authenticated Polymarket secure client into the live CLI path so SHADOW reads live books and MICRO_LIVE *can* submit, while domain-shaped orders stay fail-closed until CLOB order translation exists.

**Architecture:** New `secure-client.ts` in `@polyroot/venue` builds an ethers-backed SDK `Signer`, reads fail-closed env, and returns a `PolymarketVenueAdapter` wrapping the real `SecureClient`. `placeOrder` gains a CLOB-shape guard (`VENUE_ORDER_SHAPE_UNSUPPORTED`) so our domain `SignedOrder` can never be posted malformed to the real CLOB.

**Tech Stack:** TypeScript, ethers v6, `@polymarket/client` 0.9.0, Node test runner with `tsx`.

## Global Constraints

- Node.js `>=24.0.0`.
- Mandatory gates: `npm run ci` + secret scan.
- No network calls in unit tests (inject a fake client creator).
- No production secrets in tests, docs, or shell history.
- MICRO_LIVE/LIVE stay fail-closed; this plan adds capability, not permission.

---

### Task 1: Secure client factory (no network in tests)

**Files:**
- Create: `src/pm/venue/src/secure-client.ts`
- Modify: `src/pm/venue/src/index.ts` (add `export * from "./secure-client.js";`)
- Test: `tests/pm/contracts/venue-secure-client.test.ts` (new)

**Interfaces:**
- Consumes: `PRIVATE_KEY_HEX`/`WALLET_PRIVATE_KEY`, `WALLET_ACCOUNT`, `RPC_URL`, `POLYMARKET_API_KEY`, `POLYMARKET_API_SECRET`, `POLYMARKET_API_PASSPHRASE`.
- Produces: `readSecureClientEnv(env)`, `buildSdkSigner(privateKeyHex, rpcUrl)`, `buildLiveVenueAdapter(env, overrides?)`.

- [ ] **Step 1: Write the failing test**

```typescript
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildLiveVenueAdapter,
  buildSdkSigner,
  PolymarketVenueAdapter,
  readSecureClientEnv,
} from "@polyroot/venue";

describe("secure venue client factory", () => {
  it("refuses when the wallet key is missing", () => {
    assert.throws(() => readSecureClientEnv({}), /SECURE_CLIENT_ENV_MISSING/);
  });

  it("refuses when API credentials are missing", () => {
    assert.throws(
      () =>
        readSecureClientEnv({
          PRIVATE_KEY_HEX: "0x" + "1".repeat(64),
          WALLET_ACCOUNT: "0x" + "2".repeat(40),
          RPC_URL: "https://polygon-rpc.com",
        }),
      /POLYMARKET_API_KEY/,
    );
  });

  it("builds an offline-capable signer whose address derives from the key", async () => {
    const key = "0x" + "3".repeat(64);
    const signer = buildSdkSigner(key, "https://polygon-rpc.com");
    const address = await signer.getAddress();
    assert.match(address, /^0x[0-9a-fA-F]{40}$/);
    const sig = await signer.signMessage("polyroot-probe");
    assert.match(sig, /^0x[0-9a-f]{130}$/);
  });

  it("passes wallet, credentials, and signer to the injected client creator", async () => {
    let seen: unknown;
    const adapter = await buildLiveVenueAdapter(
      {
        PRIVATE_KEY_HEX: "0x" + "4".repeat(64),
        WALLET_ACCOUNT: "0x" + "5".repeat(40),
        RPC_URL: "https://polygon-rpc.com",
        POLYMARKET_API_KEY: "key",
        POLYMARKET_API_SECRET: "secret",
        POLYMARKET_API_PASSPHRASE: "phrase",
      },
      {
        createClient: (async (opts: unknown) => {
          seen = opts;
          return {};
        }) as never,
      },
    );
    assert.ok(adapter instanceof PolymarketVenueAdapter);
    const opts = seen as Record<string, unknown>;
    assert.equal(opts["wallet"], "0x" + "5".repeat(40));
    assert.deepEqual(opts["credentials"], {
      key: "key",
      secret: "secret",
      passphrase: "phrase",
    });
    assert.equal(typeof (opts["signer"] as Record<string, unknown>)["getAddress"], "function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test --import tsx tests/pm/contracts/venue-secure-client.test.ts
```

Expected: FAIL with "Cannot find module" or "does not provide an export named".

- [ ] **Step 3: Write minimal implementation**

Create `src/pm/venue/src/secure-client.ts`:

```typescript
import { Wallet, JsonRpcProvider, type Provider } from "ethers";
import {
  createSecureClient,
  type Signer as SdkSigner,
} from "@polymarket/client";
import {
  PolymarketVenueAdapter,
  type PolymarketClientLike,
} from "./polymarket-adapter.js";

export interface SecureClientEnv {
  privateKeyHex: string;
  wallet?: string;
  rpcUrl: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
}

const REQUIRED_VARS = [
  "PRIVATE_KEY_HEX",
  "WALLET_ACCOUNT",
  "RPC_URL",
  "POLYMARKET_API_KEY",
  "POLYMARKET_API_SECRET",
  "POLYMARKET_API_PASSPHRASE",
] as const;

export function readSecureClientEnv(
  env: NodeJS.ProcessEnv = process.env,
): SecureClientEnv {
  const key = env["PRIVATE_KEY_HEX"] ?? env["WALLET_PRIVATE_KEY"];
  const missing: string[] = [];
  if (!key) missing.push("PRIVATE_KEY_HEX (or WALLET_PRIVATE_KEY)");
  if (!env["WALLET_ACCOUNT"]) missing.push("WALLET_ACCOUNT");
  if (!env["RPC_URL"]) missing.push("RPC_URL");
  if (!env["POLYMARKET_API_KEY"]) missing.push("POLYMARKET_API_KEY");
  if (!env["POLYMARKET_API_SECRET"]) missing.push("POLYMARKET_API_SECRET");
  if (!env["POLYMARKET_API_PASSPHRASE"]) missing.push("POLYMARKET_API_PASSPHRASE");
  if (missing.length > 0) {
    throw new Error(
      `SECURE_CLIENT_ENV_MISSING: ${missing.join(", ")} required to build the Polymarket secure client`,
    );
  }
  return {
    privateKeyHex: key as string,
    wallet: env["WALLET_ACCOUNT"],
    rpcUrl: env["RPC_URL"] as string,
    apiKey: env["POLYMARKET_API_KEY"] as string,
    apiSecret: env["POLYMARKET_API_SECRET"] as string,
    apiPassphrase: env["POLYMARKET_API_PASSPHRASE"] as string,
  };
}

export function buildSdkSigner(
  privateKeyHex: string,
  rpcUrl: string,
  provider?: Provider,
): SdkSigner {
  const normalized = privateKeyHex.startsWith("0x")
    ? privateKeyHex
    : `0x${privateKeyHex}`;
  const connected =
    provider ?? new Wallet(normalized).connect(new JsonRpcProvider(rpcUrl));
  const wallet =
    connected instanceof Wallet
      ? connected
      : new Wallet(normalized).connect(connected as Provider);
  return {
    getAddress: () => wallet.getAddress(),
    signMessage: (message: string) => wallet.signMessage(message),
    signTypedData: (payload: never) =>
      wallet.signTypedData(
        (payload as { domain: never }).domain,
        (payload as { types: never }).types,
        (payload as { message: never }).message,
      ) as Promise<`0x${string}`>,
    sendTransaction: async (request: never) => {
      const tx = await wallet.sendTransaction(request);
      return {
        hash: tx.hash,
        wait: async () => {
          const receipt = await tx.wait();
          return { status: receipt?.status === 1 ? "success" : "failed" };
        },
      } as never;
    },
  };
}

export async function buildLiveVenueAdapter(
  env: NodeJS.ProcessEnv = process.env,
  overrides: {
    createClient?: typeof createSecureClient;
  } = {},
): Promise<PolymarketVenueAdapter> {
  const cfg = readSecureClientEnv(env);
  const signer = buildSdkSigner(cfg.privateKeyHex, cfg.rpcUrl);
  const create = overrides.createClient ?? createSecureClient;
  const client = await create({
    signer,
    wallet: cfg.wallet,
    credentials: {
      key: cfg.apiKey,
      secret: cfg.apiSecret,
      passphrase: cfg.apiPassphrase,
    },
  });
  return new PolymarketVenueAdapter(
    client as unknown as PolymarketClientLike,
  );
}
```

Add to `src/pm/venue/src/index.ts`:

```typescript
export * from "./secure-client.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm run build --workspace=@polyroot/venue && node --test --import tsx tests/pm/contracts/venue-secure-client.test.ts
```

Expected: PASS (4 tests). Adjust implementation details (ethers v6 API, SDK type names) until green — but do not weaken assertions.

---

### Task 2: CLOB-shape guard on placeOrder

**Files:**
- Modify: `src/pm/venue/src/polymarket-adapter.ts`
- Modify: `tests/pm/contracts/venue-sdk-bind.test.ts` (CLOB-shaped success case)
- Test: `tests/pm/contracts/venue-secure-client.test.ts` (refusal case) + `venue-sdk-bind.test.ts`

**Interfaces:**
- Consumes: order object passed to `placeOrder`.
- Produces: `VENUE_ORDER_SHAPE_UNSUPPORTED` refusal unless the order carries CLOB fields (`tokenId`, `maker`, `takerAmount`, `salt`, `signatureType`, `signature`).

- [ ] **Step 1: Write the failing tests**

Append to `venue-secure-client.test.ts`:

```typescript
it("refuses domain-shaped orders without touching the venue client", async () => {
  let called = 0;
  const adapter = new PolymarketVenueAdapter({
    postOrder: async () => {
      called += 1;
      return { success: true, orderID: "must-not-happen" };
    },
  });
  const res = await adapter.placeOrder({
    order_id: "o1",
    market_id: "m1",
    side: "BUY",
    price: 0.5,
    size: 1,
  } as never);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "VENUE_ORDER_SHAPE_UNSUPPORTED");
  assert.equal(called, 0);
});

it("passes CLOB-shaped orders through to the venue client", async () => {
  let seen: unknown;
  const adapter = new PolymarketVenueAdapter({
    postOrder: async (order: unknown) => {
      seen = order;
      return { success: true, orderID: "venue_1" };
    },
  });
  const clobOrder = {
    maker: "0x" + "1".repeat(40),
    takerAmount: "1000000",
    makerAmount: "500000",
    tokenId: "123",
    salt: "1",
    expiration: 9999999999,
    side: 0,
    orderType: 0,
    signatureType: 0,
    signer: "0x" + "1".repeat(40),
    signature: "0x" + "2".repeat(130),
    timestamp: "1",
    builder: "0x" + "0".repeat(40),
    metadata: "0x",
  };
  const res = await adapter.placeOrder(clobOrder as never);
  assert.equal(res.ok, true);
  assert.equal(seen, clobOrder);
});
```

Update the existing success case in `venue-sdk-bind.test.ts` (lines 73-94) to use the same CLOB-shaped order instead of the domain-shaped one.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run build --workspace=@polyroot/venue && node --test --import tsx tests/pm/contracts/venue-secure-client.test.ts tests/pm/contracts/venue-sdk-bind.test.ts
```

Expected: FAIL — domain-shaped order currently posts; CLOB-shaped order currently posts (that part passes) but the refusal case fails.

- [ ] **Step 3: Implement the guard**

In `polymarket-adapter.ts`, widen the signature and add the guard at the top of `placeOrder` (after the mode gate):

```typescript
const CLOB_ORDER_FIELDS = [
  "tokenId",
  "maker",
  "takerAmount",
  "salt",
  "signatureType",
  "signature",
] as const;

function isClobSignedOrder(order: unknown): boolean {
  if (typeof order !== "object" || order === null) return false;
  return CLOB_ORDER_FIELDS.every(
    (field) => (order as Record<string, unknown>)[field] !== undefined,
  );
}

async placeOrder(order: SignedOrder | unknown): Promise<SubmitOutcome> {
  const gate = venueActionGate(this._mode, "ORDER_SUBMIT");
  if (!gate.allowed) {
    return { ok: false, code: gate.code, reason: gate.reason };
  }
  if (!isClobSignedOrder(order)) {
    return {
      ok: false,
      code: "VENUE_ORDER_SHAPE_UNSUPPORTED",
      reason:
        "order is not a CLOB-signed order (missing tokenId/maker/takerAmount/salt/signatureType/signature); domain SignedOrder translation is not implemented",
    };
  }
  // ... existing postOrder logic unchanged
}
```

Verify the `SubmitOutcome` error-code type accepts the new code; if it is a closed union, extend it in `types.ts` (check first).

- [ ] **Step 4: Run tests to verify they pass**

Run the same command as Step 2. Expected: all PASS.

---

### Task 3: Wire the CLI live path + document env

**Files:**
- Modify: `src/pm/runtime/src/cli.ts`
- Modify: `.env.example`
- Modify: `docker-compose.prod.yml`
- Modify: `docs/PUBLIC_API.md`
- Test: `npm run ci`

**Interfaces:**
- Consumes: `buildLiveVenueAdapter`.
- Produces: live CLI path injects a real secure client; docs list the new env vars.

- [ ] **Step 1: Wire the CLI**

In `cli.ts`, replace:

```typescript
venueAdapter: new PolymarketVenueAdapter({}),
```

with:

```typescript
venueAdapter: await buildLiveVenueAdapter(),
```

Update the import from `@polyroot/venue` accordingly (`PolymarketVenueAdapter` import may become unused — remove it if so).

- [ ] **Step 2: Document env**

`.env.example` — add under a new `VENUE (live only)` section:

```env
# Polymarket CLOB API credentials (REQUIRED for MICRO_LIVE/LIVE).
# Create at polymarket.com profile → API credentials.
# POLYMARKET_API_KEY=
# POLYMARKET_API_SECRET=
# POLYMARKET_API_PASSPHRASE=
```

`docker-compose.prod.yml` — pass the three vars through as empty-default envs (same pattern as the other optional vars).

`docs/PUBLIC_API.md` — document the three vars as required for MICRO_LIVE/LIVE, and state explicitly: SHADOW/MICRO_LIVE reads use the secure client; order submission of domain `SignedOrder`s is refused with `VENUE_ORDER_SHAPE_UNSUPPORTED` until CLOB order translation lands.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm run ci
```

Expected: exit code `0`.

---

### Task 4: Record the remaining order-translation gap

**Files:**
- Modify: this plan file (append) — no code.
- Test: none.

- [x] **Step 1: Explicit follow-up note (recorded here)**

OPEN: domain `SignedOrder` → CLOB signed-order translation (prepare/sign/post via SDK order workflows, asset/token-id resolution per market, EIP-712 signing through the injected SDK signer). MICRO_LIVE submission stays blocked by `VENUE_ORDER_SHAPE_UNSUPPORTED` until that lands with its own TDD cycle. SHADOW live reads work as of this plan. Do NOT fund the wallet for live trading until that translation exists and is covered by contract tests.
