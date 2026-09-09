# ADR-02: Official SDK/Version, Wallet Support, Asset/Approval Registry and Credential Lifecycle

**Status:** Accepted
**Date:** 2026-09-09 (updated to PRD/Blueprint v1.1)
**Deciders:** Crypty Root (Tech Lead)
**Technical Story:** PR-WAL-01…08; Blueprint B5 (wallet/signer), B10 (VenueAdapter)

---

## Context

CLOB V2 is the production reality; current official examples use the unified
TypeScript client (`@polymarket/client`, observed 0.9.0 at research cut, Node
≥ 24). The pinned upstream uses `unofficial-opinion-clob-sdk` plus a manual
signer that explicitly lacks the wallet type 3 / POLY_1271 path — so the
manual signer cannot be the production authority. Deposit Wallet is the
current default account wallet (wallet type 3). pUSD is the trading
collateral; a nominal USDC/USDC.e balance is not automatically spendable pUSD.
Matching-engine realities (HTTP 425 restarts, post-only/cancel-only modes,
rate-limit queueing, category-dependent fees, dynamic rebates) mean every
SDK name, endpoint, fee table and contract address is a research baseline
that G0 must revalidate — never an eternal constant (Blueprint B18).

## Decision

### 1. Official SDK behind a pinned VenueAdapter (PR-WAL-01, PR-EXE-02)

Business logic never calls the SDK directly. A `VenueAdapter` wraps the exact
pinned official SDK/runtime (frozen at G0 after contract checks) and exposes
one capability contract: market data, canonical order construction, submit
(ACK / DEFINITIVE_REJECT / UNKNOWN — ACK is not a fill), order/trade lookup,
cancel/cancelAll with per-order results, streams/heartbeat, balances /
allowances / positions, and settlement/redeem. Unsupported behavior is an
explicit fail-closed state, and an SDK upgrade that changes a method/schema
fails the adapter contract test before release (T-PR-WAL-01).

### 2. Wallet support (PR-WAL-02/03)

Deposit Wallet / wallet type 3 is the default modern account model; EOA,
legacy Proxy and Safe are supported only when contract tests prove
compatibility. Signer address, account/deposit wallet, funder/collateral
owner and wallet type are modelled as separate verified identifiers
(`wallets` table) — never inferred from one address field. Swapping signer
and wallet in a fixture must fail before any financial side effect
(T-PR-WAL-03).

### 3. Asset and approval registry (PR-WAL-06)

pUSD, USDC/USDC.e and outcome tokens are distinct assets in `asset_registry`
(chain, contract, decimals, symbol) with an `approvals` table for
allowance/operator state. Spendable balance = verified settled pUSD minus
active reservations; a wallet with nominal balance but missing allowance
reports lower free cash and entries are rejected until setup is valid
(T-PR-WAL-06). Contract addresses live in the versioned registry, never
hardcoded in source.

### 4. Credential lifecycle (PR-WAL-04/05)

L1 authentication, CLOB L2 API credentials and Relayer/Builder credentials
are stored and scoped separately (`credentials` table: kind, scope,
creation/derivation, rotation, revocation, health, last verification) with no
secret material in the ledger, logs, prompts, exports or backups. Revoked or
rotated L2 credentials safely transition the executor and can never authorize
new requests (T-PR-WAL-04). Relayer/builder keys are isolated from ordinary
order execution and invisible to research containers (T-PR-WAL-05).

### 5. Narrow Signer Vault (PR-WAL-07)

Private signing capability lives in a minimal signer boundary that accepts
only typed, allowlisted Polymarket operations bound to an unexpired execution
permit, policy hash, chain/contract and amount limits. Arbitrary calldata,
mismatched amounts or policy hashes are refused and audited (T-PR-WAL-07).
Funding, bridging, withdrawal and key-compromise evacuation are a separate
governance/break-glass workflow, never strategy autonomy (PR-WAL-08).

## Consequences

### Positive

- One signing path, fully auditable; wallet/credential upgrades don't touch
  strategy code.
- Fee/rebate/address drift is caught by contract checks at G0, not by
  production failures.

### Negative

- VenueAdapter + registry + vault is more indirection than direct SDK calls.
- G0 must run live read-only contract checks — mocks alone never qualify a
  release (T-PR-VAL-01).

## Validation

- Adapter contract tests against current read-only API/SDK; mismatch blocks
  release (T-PR-EXE-02, T-PR-VAL-01).
- Wallet-type fixtures incl. unsupported-signature refusal (T-PR-WAL-02).
- Allowance-missing fixture rejects entry (T-PR-WAL-06).
- Arbitrary-calldata signing fixture refused + audited (T-PR-WAL-07).

## Related

- ADR-01 (fork/allowlist), ADR-03 (schemas/permits), ADR-08 (signer deployment)
- Blueprint B5, B10; PR-WAL-01…08
