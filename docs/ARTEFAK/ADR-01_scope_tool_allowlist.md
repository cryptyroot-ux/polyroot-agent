# ADR-01: Agent Scope & Tool Allowlist

**Status:** Accepted  
**Date:** 2026-09-09  
**Deciders:** Crypty Root (Tech Lead)  
**Technical Story:** PRD PM-GOV-01…03, Blueprint B2 §3 (Agent graph), B3 §3 (Domain)

---

## Context

Polyroot adopts a **controlled autonomy** architecture: the AI agent reasons about
markets, constructs evidence, and *proposes* `TradeIntent` objects. It **never**
holds private keys and **never** signs or submits orders. A separate deterministic
`Executor` performs all on-chain operations.

To enforce this boundary at the code level, the agent graph must be restricted
to a **read / learn / propose** tool allowlist. Any tool that could mutate state,
sign transactions, or bypass the risk engine is forbidden from the agent's
call graph.

---

## Decision

The agent's tool registry (`src/agents/tool-registry.ts` in upstream) will be
replaced with an **allowlist-only** registry that exposes exactly three
categories:

| Category | Tools | Purpose |
|----------|-------|---------|
| **Read** | `getMarketSnapshot`, `getOrderBook`, `getRecentTrades`, `getFundingRate`, `getPositions` | Pure queries — no side effects |
| **Learn** | `ingestEvidence`, `runCalibration`, `fetchNews`, `queryKnowledgeBase` | Write to *evidence store* only (append-only, no trading) |
| **Propose** | `proposeIntent` | Emit a `TradeIntent` DTO → routed to `Executor` |

**Forbidden** (removed from agent graph, kept only in Executor / Control):
- `signOrder`, `submitOrder`, `cancelOrder`, `modifyOrder`
- `transferFunds`, `withdraw`, `deposit`
- `setRiskPolicy`, `overrideSizing`, `emergencyStop` (these are owner-only commands via Control API)
- Any tool that accepts a private key or signer object

---

## Consequences

### Positive
- **Enforceable boundary**: TypeScript + CI can verify no forbidden tool is
  reachable from the agent entry point.
- **Auditability**: Every proposal is a logged `TradeIntent` with traceability
  to the evidence that produced it.
- **Compliance**: Matches PRD PM-GOV-01 (no private keys in agent) and
  Blueprint B3 §3 (intent-only output).

### Negative
- **More upfront work**: Must wrap all Polymarket SDK calls in read-only adapters.
- **No "quick fix" via agent**: If a market edge requires a complex multi-step
  order (bracket, TWAP), the *strategy* must encode it as a structured intent;
  the agent cannot improvise.

### Neutral
- Owner commands (pause, policy update, emergency stop) move to the Control API
  with auth + audit log — this is a feature, not a limitation.

---

## Validation

- **Contract test** (`tests/pm/contracts/tool-allowlist.test.ts`):  
  Assert that the agent's tool registry contains *only* the allowlisted tools.
- **Static analysis** (CI):  
  `grep -r "signOrder\|submitOrder\|privateKey" src/pm/intelligence src/pm/strategy` must return zero hits.
- **Runtime guard**: Agent entry point throws if injected tool registry contains
  any forbidden tool name.

---

## Related

- ADR-02 (SDK / wallet / collateral)
- Blueprint B2 §3 (Agent graph changes)
- Blueprint B3 §3 (Domain: TradeIntent, RiskDecision)
- PRD PM-GOV-01, PM-GOV-02, PM-GOV-03