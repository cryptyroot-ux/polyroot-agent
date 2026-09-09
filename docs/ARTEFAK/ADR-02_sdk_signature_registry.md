# ADR-02: SDK Signature Registry, Wallet & Collateral

**Status:** Accepted  
**Date:** 2026-09-09  
**Deciders:** Crypty Root (Tech Lead)  
**Technical Story:** PRD PM-GOV-04, PM-RISK-01…04, Blueprint B2 §8 (Signer), B4 §4 (Venue), B8 (Security)

---

## Context

Polyroot must interact with the Polymarket CLOB (Central Limit Order Book) on
Polygon (chain ID 137). The official TypeScript SDK is `@polymarket/client`,
which provides:
- `ClobClient` for order placement, cancellation, and query
- `NegRiskClient` for neg-risk (complement) markets
- Order signing via `Signer` (ethers v6 `Wallet` or `JsonRpcSigner`)

Upstream CloddsBot uses `unofficial-opinion-clob-sdk` (v0.1.10) and a custom
`polymarket-order-signer.ts` that assumes `negRisk` fee = 25/0 bps — a bug per
Blueprint research. We must migrate to the official SDK and define our own
signer adapter.

**Critical constraints from Blueprint:**
- **Executor only** holds the signing key (AI never sees it).
- Wallet type is **owner-configured** (hardware wallet via Clef, HSM, or
  encrypted keystore — not a plaintext `.env` private key).
- Collateral is **pUSD** (Polygon USDC bridged, token `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`).
- All order signing must go through a **signature registry** that validates
  order structure, checks risk reservations, and emits a signed payload — no
  direct SDK `signOrder` calls in business logic.

---

## Decision

### 1. Official SDK Pin
Pin `@polymarket/client` at a specific version (to be determined in Sprint 2
after compatibility testing). Do **not** use `unofficial-opinion-clob-sdk`.

### 2. Venue Adapter (`@polyroot/venue`)
Wrap `ClobClient` / `NegRiskClient` in a **venue adapter** with the interface:

```ts
interface VenueAdapter {
  // Read
  getOrderBook(marketId: string): Promise<OrderBook>;
  getMarkets(params: MarketFilter): Promise<Market[]>;
  getPositions(address: string): Promise<Position[]>;

  // Write (Executor only)
  placeOrder(order: SignedOrder): Promise<OrderResult>;
  cancelOrder(orderId: string): Promise<CancelResult>;
  cancelAll(marketId?: string): Promise<CancelResult[]>;
}
```

All write methods **require** a `SignedOrder` produced by the Signature Registry.
The adapter never sees the private key.

### 3. Signature Registry (`src/pm/executor/signature-registry.ts`)
A pure function (no side effects) that:

```ts
interface SignatureRegistry {
  signOrder(
    unsigned: UnsignedOrder,
    riskDecision: RiskDecision,
    wallet: WalletAdapter
  ): Promise<SignedOrder>;
}
```

- Validates `UnsignedOrder` against Zod schema (market, side, price, size,
  fee tier, expiration, nonce).
- Verifies `riskDecision.reservationId` exists and is **active** (ledger check).
- Delegates actual signing to `WalletAdapter` (see below).
- Returns `SignedOrder` with `signature`, `signer`, `signedAt`.

### 4. Wallet Adapter (`src/pm/executor/wallet-adapter.ts`)
Abstraction over the owner's key material. Implementations:

| Type | Description | Status |
|------|-------------|--------|
| `ClefWallet` | Ethereum Clef (external signer process) | **Preferred for prod** |
| `HsmWallet` | AWS CloudHSM / Azure Key Vault / GCP KMS (via ethers `ExternalSigner`) | **Preferred for prod** |
| `KeystoreWallet` | Encrypted JSON keystore (scrypt, password from env) | **Dev / fallback** |
| `TestWallet` | In-memory `ethers.Wallet` (random key) | **Test only** |

**Plaintext private key in `.env` is forbidden** — CI secret scan (Gitleaks) will
fail the build if detected.

### 5. Collateral & Chain Constants
Hardcode in `@polyroot/domain/constants.ts` (not env):

```ts
export const POLYMARKET = {
  CHAIN_ID: 137,
  P_USD: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  CLOB_ADDRESS: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  NEG_RISK_CLOB: "0x5F47C39E8B7e7d2e4E8d8D8d8D8d8D8d8D8d8D8d8",
  FEE_TIERS: { maker: 0, taker: 2 } as const, // bps, per official docs
} as const;
```

### 6. NegRisk Fee Fix
Replace upstream's hardcoded 25/0 bps with official fee tiers (maker 0, taker 2
bps for standard; neg-risk uses same schedule). This is tracked as a **patch
to upstream** and documented in the release manifest.

---

## Consequences

### Positive
- **Single signing path**: All orders flow through `SignatureRegistry` → auditable.
- **Wallet flexibility**: Owner can swap Clef ↔ HSM ↔ Keystore without code changes.
- **SDK upgrade safety**: Venue adapter isolates SDK breaking changes.
- **Fee correctness**: NegRisk fee bug eliminated.

### Negative
- **More indirection**: Extra layer vs. direct SDK calls.
- **Clef/HSM setup**: Requires owner infrastructure (documented in ops runbook).

### Neutral
- Test wallet enables deterministic CI tests without secrets.

---

## Validation

- **Contract test** (`tests/pm/contracts/signature-registry.test.ts`):
  - Invalid order → rejected
  - Missing risk reservation → rejected
  - Valid order + TestWallet → produces valid `SignedOrder` verifiable by SDK
- **Integration test** (against Polygon Amoy testnet):
  - Place + cancel order via full stack (Executor → Registry → Wallet → Adapter)
- **Secret scan** (CI): Gitleaks rule for `PRIVATE_KEY`, `MNEMONIC`, `SEED_PHRASE`

---

## Related

- ADR-01 (Agent scope)
- Blueprint B2 §8 (`src/utils/polymarket-order-signer.ts` changes)
- Blueprint B4 §4 (VenueAdapter interface)
- Blueprint B8 (Security: secret isolation)
- PRD PM-GOV-04, PM-RISK-01…04