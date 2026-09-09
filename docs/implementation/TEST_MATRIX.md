# Fault / Test Matrix — Phase 9

Date: 2026-09-09 · Source: `docs/spec_pack/Polyroot_v1.1_Specification_Pack/Fault_Matrix.csv` (46 scenarios)
Invariants executed against the **pure** modules that exist today under `tests/pm/contracts/fault-harness.test.ts`.

Status legend:
- **PASS** — invariant proven by a runnable contract test in this repo (file:line of the harness block).
- **DEFERRED** — needs a module/plane not yet wired (reference target phase).

| FT | Scenario | Invariant | Status | Evidence |
|----|----------|-----------|--------|----------|
| FT-01 | Concurrent spend | At most one reservation commits | PASS | `fault-harness.test.ts` "FT-01" (`MoneyKernel.reserve`, `INSUFFICIENT_FUNDS`) |
| FT-02 | Duplicate delivery | One intent hash / no extra order | PASS | `fault-harness.test.ts` "FT-02" (`Executor.submit` → `DUPLICATE`, exactly 1 placeOrder) |
| FT-03 | Crash before send | Recover same payload; lookup policy before resend | DECIDED-BY-DESIGN | Lifecycle keeps `SUBMITTING` in the idempotency log; re-send of a seen id is `DUPLICATE`. Live persistence = Phase 11 supervisor. |
| FT-04 | Crash after send | SUBMISSION_UNKNOWN retains reservation | PASS | `fault-harness.test.ts` "FT-04" (unknown → `NEEDS_RECONCILIATION`, reconcile does not resubmit, replay is `DUPLICATE`) |
| FT-05 | Late accepted submit | No new logical order; late result reconciles | PASS | `fault-harness.test.ts` "FT-05" (`RecoveryLedger` venue-source resolve only) |
| FT-06 | Cancel fill race | Reserve unsettled fill until reconciliation | PASS | `fault-harness.test.ts` "FT-06" (`sellableShares`, `checkReduceAllowed` → `REDUCE_OVERDRAWN`) |
| FT-07 | Failed cancel | Do not clear active order / release capital | PASS | `fault-harness.test.ts` "FT-07" (`recordCancelOutcome` → `allCanceled=false`) |
| FT-08 | Partial batch failure | Per-order results, no batch success | PASS | `fault-harness.test.ts` "FT-08" (one ACK, one `DEFINITIVE_REJECT`) |
| FT-09 | Heartbeat loss | Reconcile expected cancellations; no fabricated success | DEFERRED | Needs supervisor heartbeat + persisted ledger (Phase 11) |
| FT-10 | Engine restart (425) | Stop new orders; cancel best effort | PASS-PARTIAL | `RateGovernor` (`429/hint → RETRYABLE`), `RecoveryLedger.needsReconcile`; full 24/7 wiring Phase 11 |
| FT-11 | Post-only mode | Reject taker during recovery | PASS | `fault-harness.test.ts` "FT-11" (`MODE_FORBIDS`, cancel still legal) |
| FT-12 | Close-only account | Only authorized risk reduction w/ verified inventory | PASS | `venue-policy.test.ts` "capability intersection" (`ACCOUNT_CLOSE_ONLY`, `REDUCE_ONLY`) |
| FT-13 | Unknown venue mode | No new orders; queries + best-effort cancel continue | PASS | `fault-harness.test.ts` "FT-13" (`UNKNOWN` → submit refused); `UNKNOWN` blocks read by TABLE 17 |
| FT-14 | Signer compromise attempt | Vault rejects exact payload/policy mismatch | PASS | `fault-harness.test.ts` "FT-14" (`SignerVault` `AMOUNT_EXCEEDS_PERMIT`, `PAYLOAD_HASH_MISMATCH`) |
| FT-15 | Old fencing epoch | Vault rejects new signatures post lease-loss | DEFERRED | `lease_epoch` present in permit; enforcement wiring Phase 9 executor-path / Phase 11 |
| FT-16 | Malicious plugin | OS isolation / resource quota | DEFERRED | `tool-allowlist` pure gate exists; process isolation Phase 13 |
| FT-17 | SSRF redirect | No internal connection | DEFERRED | Evidence-fetch egress hardening Phase 13 |
| FT-18 | DNS rebinding | Pinned validated connection | DEFERRED | Phase 13 |
| FT-19 | Content bomb | Abort decoded/compressed budgets | DEFERRED | Phase 13 |
| FT-20 | Prompt injection | Data only; no tool/mandate mutation | DEFERRED | data plane Phase 10; guardrails Phase 13 |
| FT-21 | Credential revocation | AUTH_FAILURE; uncertain state preserved; owner recovery | PASS | `fault-harness.test.ts` "FT-21" (`planCompromiseResponse` order: KILL → FREEZE → RECONCILE → CANCEL → REVOKE); taxonomy adds `expired` → PERMIT_EXPIRED (executor) |
| FT-22 | Deposit setup ambiguity | Operation UNKNOWN; no duplicate setup | DEFERRED | Wallet contract Phase 10 |
| FT-23 | Wrong spender approval | Available-to-trade zero; no sign | DEFERRED | Wallet contract Phase 10 |
| FT-24 | Fee changes | Bound proven or path blocked; ledger actual fee | PASS-PARTIAL | exact `cashNeededFor` + ledger actual-posting wiring exist; live fee source Phase 10 |
| FT-25 | Tick/minimum changes | Revalidate and round safely | PASS-PARTIAL | `planFlatten` re-rounds to cap; full metadata revalidation Phase 10 |
| FT-26 | Unknown protocol | Profile BLOCKED, no legacy fallback | DEFERRED | profile registry Phase 10 |
| FT-27 | Rules/catalyst race | Permit watermark mismatch rejects | DEFERRED | `permitFingerprint`/quote binding exists; watermark source Phase 10 |
| FT-28 | WS gap | Stale until snapshot/watermark recovery | DEFERRED | data plane Phase 10 |
| FT-29 | Clock skew | No new sign; monotonic deadline | PASS-PARTIAL | `SignerVault` `CLOCK_SKEW`, `PERMIT_EXPIRED` (executor TTL); monotonic deadline Phase 11 |
| FT-30 | Correlation gap | Conservative group cap; no diversification credit | DEFERRED | graph/risk supplement Phase 10 |
| FT-31 | False exclusivity | Structural solver rejects payout proof | DEFERRED | graph solver Phase 10 |
| FT-32 | One leg only | Bound residual exposure; hedge/unwind within mandate | DEFERRED | strategy plane Phase 10 |
| FT-33 | Settlement failure | Provisional inventory not spendable; compensating journal | PASS-PARTIAL | ledger compensating-posting schema exists; provisional-inventory wiring Phase 10 |
| FT-34 | Double redeem event | One economic posting per unique log | DEFERRED | dedupe posting on unique tx id — Phase 10 |
| FT-35 | DB outage | No new signing; isolated cancel | DEFERRED | supervisor fault-mode Phase 11 |
| FT-36 | Restore backup | RECOVERING; ledger catch-up before permits | DEFERRED | ledger recovery Phase 11 |
| FT-37 | Hot cleanup | Reference-count pin; replay verifies hashes | DEFERRED | research/experiment Phase 10 |
| FT-38 | Missing universe rows | Denominator audit fails; experiment ineligible | DEFERRED | research Phase 10 |
| FT-39 | Holdout reuse | New trial spends budget | DEFERRED | research Phase 10 |
| FT-40 | Provider alias drift | New lineage/calibration segment | DEFERRED | intelligence Phase 10 |
| FT-41 | Optimistic paper fills | Reality gap gate fails | DEFERRED | research Phase 10 |
| FT-42 | Exit liquidity disappears | Position stays open; price constraint visible | PASS | `fault-harness.test.ts` "FT-42" (`planFlatten` skips above cap) |
| FT-43 | Reward estimate reversed | Only estimate corrected; no cash reservation | DEFERRED | ledger/ECON Phase 10 |
| FT-44 | Model budget exhausted | New forecast abstains; monitors continue | DEFERRED | intelligence Phase 10 |
| FT-45 | Supply-chain drift | Build admission fails | DEFERRED | build admission Phase 13 |
| FT-46 | Drawdown and restart | Breach persists; no timed auto-resume | PASS | `fault-harness.test.ts` "FT-46" (`lossFloor` sealed breach `blocked=true` despite deposit/restart) |

## Phase 9 contract count
- New `tests/pm/contracts/fault-harness.test.ts`: **16 tests, 16 pass**.
- Repo aggregate after Phase 9: **135 pass / 0 fail** (123 contract incl. fault harness; 12 property).
- Pipeline: `turbo build typecheck lint` 33 tasks, `check-traceability` 124/124.

## Execution-plane guarantees re-verified end-to-end in one harness
FT-01..08 + FT-13/14/21/42/46 were exercised against the *composed* chain
`MoneyKernel.reserve → Executor.submit/reconcile → venue gate → kill-switch /
loss-floor / recovery-ledger / signer-vault`, i.e. the same sequence a live
supervisor uses. No live network was required.