**POLYROOT**

**Modular Autonomous Prediction-Market\
Intelligence & Trading System**

**Technical Blueprint**

**Version 1.1 • Correction & Completion Release • 9 September 2026**

Research baseline: official Polymarket CLOB V2 documentation, current
official TypeScript SDK, pinned CloddsBot fork source, security
guidance, PostgreSQL durability guidance, and live/prospective
forecasting literature.

---

**Autonomy contract.** After one-time commissioning, PolyRoot operates
24/7 with zero human approval per trade. It autonomously discovers
markets, researches, forecasts, selects qualified strategies, sizes
positions, enters, cancels/replaces, exits, redeems, reconciles,
recovers, and resumes inside an immutable hard-cap policy. Human
governance is reserved for commissioning, capital/signer changes,
compliance blocks, and exceptional security recovery, not market
decisions.
-----------------------------------------------------------------------

---

_Status: implementation specification. Not a claim of profitability,
production readiness, or legal eligibility in any jurisdiction._

# B0. Architecture Decision

---

**Chosen architecture** PolyRoot is not one giant AI process. It is a
24/7 autonomous system with strict privilege separation: untrusted data
and LLM reasoning are upstream; deterministic money authority and
signing are downstream. The system needs no human approval for routine
market execution, but no AI component can change its own hard financial
authority.
-----------------------------------------------------------------------

---

---

OWNER / CONTROL UI\
commission Autonomy Charter \| governance changes \| observe / emergency revoke\
\|\
v\
+\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-- 24/7 SUPERVISOR / EVENT BUS \-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+\
\| \|\
v v\
DATA / GRAPH RESEARCH QUARANTINE\
markets/events/books/user stream web/news/primary data\
fees/modes/rules/catalysts SSRF/size/rights gates\
\| \|\
+\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+\
v\
INTELLIGENCE: normalized evidence -\> component forecasts -\> ensemble/calibration\
\|\
v\
SANDBOXED STRATEGY RUNTIME -\> Proposal / TradeIntent\
\|\
v\
DETERMINISTIC MONEY KERNEL\
eligibility -\> economics -\> sizing -\> graph/portfolio risk -\> atomic reservation\
\| ExecutionPermit\
v\
EXECUTOR / VENUE ADAPTER -\> typed sign request -\> SIGNER VAULT -\> POLYMARKET\
submit \| cancel/replace \| heartbeat \| rate governor \| settle \| reconcile\
\|\
v\
POSTGRESQL EVENT LEDGER / OUTBOX / EXPERIMENTS / READ MODELS
------------------------------------------------------------------------------------------------------------------------------------------

---

# B1. Fork Disposition --- CloddsBot Is Raw Material, Not the Runtime Authority

---

Upstream area Disposition PolyRoot rule

---

**package.json / dependency graph** REDUCE Keep MIT notice and required runtime;
remove unrelated
venues/DeFi/messaging/tools from LIVE
image. Review postinstall/native hooks.

**src/feeds/polymarket/\*** ADAPT Reuse useful parsing/stream concepts
behind canonical MarketDataAdapter;
revalidate current CLOB V2
schemas/freshness.

**src/execution/index.ts** REPLACE HOT PATH No broad direct signer/retry path. New
executor uses durable
intent/permit/unknown-state protocol.

**src/utils/polymarket-order-signer.ts** RETIRE / QUARANTINE Pinned source lacks wallet type
3/POLY_1271 support. Official SDK/wallet
adapter becomes default; manual signer
not production authority.

**src/utils/polymarket-setup.ts** ADAPT Approval/address helpers only after
current pUSD/deposit-wallet/contract
registry tests.

**src/feeds/polymarket/user-ws.ts** ADAPT Raw order/trade events retained but
reconciliation remains authoritative.

**src/risk/engine.ts** ADAPT CONCEPTS Reuse check taxonomy/observability
concepts; rewrite around durable ledger
snapshot, atomic reservation and
graph-aware caps.

**src/risk/var.ts / stress.ts / RESEARCH / OPTIONAL Use as analytics/protective signals only
volatility.ts** after validation; never bypass hard
caps.

**src/trading/kelly.ts** REWRITE Remove verbal-confidence and win-streak
sizing. Use calibrated payoff
distributions + capped fractional Kelly
only after empirical gate.

**src/trading/safety.ts / circuit breakers** ADAPT Fold into Money Kernel protective states
and durable latches.

**src/agents/tool-registry.ts** REPLACE FOR PRODUCTION Existing 630+ dynamic tool universe is
incompatible with least privilege.
PolyRoot intelligence gets explicit
read/research/propose capabilities only.

**src/providers/index.ts** ADAPT Reuse provider routing/retry/cost ideas;
require structured output, capability
probe, abort, lineage, rate card and
fallback isolation.

**src/skills/bundled/trading-polymarket/\*** REWIRE No direct trading tool; commands create
proposals/control requests only.

**src/strategies/hft-divergence/\*** QUARANTINE Not part of first LIVE release; any
future use must satisfy its own
latency/execution gate.

**src/arbitrage/\* / opportunity executor** RESEARCH ONLY No direct execution path; structural
market-graph strategy is rebuilt under
Money Kernel.

**gateway/control/risk routes** HARDEN Owner authentication/read models/control
commands only; no secret or financial DB
writer.

**SQLite/chat persistence** NON-FINANCIAL ONLY Cannot contain authoritative
balances/orders/mandates/reservations.
PostgreSQL is sole financial truth.

**Dockerfile / compose** HARDEN Role-separated containers, read-only
filesystems where feasible, private
networks, no Docker socket, secret
mounts, limits.

**BullMQ/Redis and optional infra** REMOVE v1 UNLESS PostgreSQL outbox/jobs first; add
PROFILED another stateful component only with
measured need.

**auto-redeem / settlement helpers** REWRITE Redeem only after finality, permission
and confirmed transaction, through typed
executor/signer flow.
---------------------------------------------------------------------------------------------------------------

# B2. Process and Trust Boundaries

---

Process / role Can do Cannot do

---

**Control Gateway** Authenticate owner; write Hold trading keys; directly
governance command inbox; read write ledger/reservation;
redacted projections. call venue financial
endpoint.

**Market/Data** Read public Sign, trade, mutate policy.
market/stream/metadata; build  
canonical snapshots/graph.

**Research Quarantine** Fetch allowed external content; Access signer, financial DB
normalize evidence; emit writer, shell on host,
provenance. private-network metadata,
arbitrary egress.

**Intelligence** Read normalized evidence/market Direct financial call,
snapshots; produce structured secret, arbitrary SQL/shell,
forecasts. policy mutation.

**Strategy Sandbox** Read validated Signer, secret, host env,
forecast/graph/economics; raw financial SQL,
propose desired exposure. governance.

**Money Kernel** Read durable financial Browse web, call LLM, sign
projection/policy; arbitrary transactions.
authorize/reject; reserve exact
assets.

**Executor** Consume durable permit; Increase policy, execute
build/submit/cancel/reconcile arbitrary transfer/contract
typed venue actions. call.

**Signer Vault** Sign strictly typed allowlisted General
action bound to network/browser/shell/LLM;
permit/policy/chain/amount. policy or market reasoning.

**Ledger/Reconciler** Append/post financial state and Create strategy ideas or
corrections; rebuild secret-bearing prompts.
projections.
------------------------------------------------------------------------------------

# B3. 24/7 Runtime, Autonomy and Recovery State Machines

## B3.1 Runtime supervisor

> • Supervisor is independent of the LLM loop. It owns service liveness,
> schedules, backpressure, incident state and safe restart
> orchestration.
>
> • Executor authority is fenced by durable wallet lease_epoch. A
> replacement cannot submit until the previous epoch is invalid and
> in-flight/unknown obligations are reconciled.
>
> • Autonomous cycle triggers from periodic discovery plus event-driven
> catalysts, book/price shocks, rule/metadata changes, user-stream
> events and scheduled deadlines.
>
> • Research starvation/provider failure degrades intelligence; it never
> disables heartbeat, cancellation, reconciliation, risk monitoring or
> settlement management.

## B3.2 Runtime transitions

---

From Trigger To Automatic action /
resume rule

---

BOOTSTRAPPING manifest/clock/credentials RECOVERING Acquire lease, rebuild
loaded projections, fetch venue
state, classify
unknowns.

RECOVERING all blockers reconciled ACTIVE Arm
streams/heartbeat/rate
governor; begin
autonomous loop.

ACTIVE data/provider/venue DEGRADED Reduce/stop entries by
degradation capability; maintain
existing risk;
auto-return when
healthy.

ACTIVE/DEGRADED loss/fault/liquidity policy PROTECTIVE_PAUSE Cancel entry orders
threshold where safe; keep
reconcile; resume only
by preconfigured
deterministic criteria.

any geoblock/access hard block ACCESS_BLOCKED No entries; only
permitted close/cancel;
do not location-hop.

any secret compromise / EMERGENCY_HALT Stop signing, preserve
integrity failure / hard state, alert; requires
drawdown governance/security
recovery because
automated self-fix would
cross authority
boundary.
------------------------------------------------------------------------------------------

# B4. Canonical Domain Contracts

---

Object Required fields / semantics

---

**AutonomyCharter** charter_id, wallet_id,
release_manifest,
policy_version/hash, capital
ceiling, strategy/version
allowlist, market-class allowlist,
allowed actions, risk limits/tiers,
auto-recovery rules,
effective/expiry/revocation,
commissioning actor/proof.

**MarketSnapshot** event/market/condition/question
IDs, token/outcome map,
chain/collateral, rules_hash,
fee/tick/min-size/status,
venue_mode, quote/book hash,
source_at/received_at, graph
node/version.

**EvidenceItem** id, source
URL/publisher/family/authority,
published_at?, fetched_at,
available_at, content hash,
claim/facts, relevance,
rights/retention policy, untrusted
flag.

**Forecast** forecast_id, market/rules/graph
version, p_raw/component forecasts,
aggregate/calibrated/conservative
probability,
evidence/counterevidence,
assumptions, invalidators, horizon,
valid_until, lineage,
abstain_reason.

**StrategyProposal** proposal_id,
strategy/version/params,
forecast/graph refs, target
exposure, entry/exit thesis, cost
assumptions, expected edge
distribution, expiry,
reason/no-trade code.

**TradeIntent** intent_id, dedupe_key, purpose
ENTRY/REDUCE/EXIT/REBALANCE,
token/side, desired_qty/notional,
limit/deadline, quote/rules/policy
refs, strategy/forecast refs. No
credentials/arbitrary calldata.

**RiskDecision/ExecutionPermit** decision_id, intent,
ledger/policy/quote/lease versions,
max qty/cash, exact reservation
IDs/asset units, allowed order
style, venue mode, reasons,
issued/expires.

**Order/Trade/Settlement** raw venue status + internal
monotonic status, IDs/hashes,
requested/filled/remaining
quantities, fee/rebate, timestamps,
tx receipt, correction links.
-----------------------------------------------------------------------

**Serialization rule:** schema_version on every persisted/exchanged
object; financial decimal values serialized as strings or exact typed
values; token/condition IDs remain opaque strings; unknown fields cannot
expand capabilities.

# B5. Wallet, Credentials and Signer Vault

## B5.1 Identity and account setup

---

SIGNER (owner-controlled key)\
\| L1 ownership signature\
+\--\> CLOB L2 API credentials\
\|\
+\--\> Deposit Wallet / account wallet (wallet type verified)\
\| pUSD + outcome tokens + approvals\
+\--\> gasless relayer operations when explicitly scoped
-----------------------------------------------------------------------

---

> • Current default new-account model is Deposit Wallet; legacy
> EOA/Proxy/Safe support is adapter capability, not an assumption.
>
> • L2 order credentials, Relayer/Builder credentials and private signer
> are stored/scoped separately. Credential health is checked on startup
> and errors are classified without logging secret material.
>
> • Trading approvals may be set up during commissioning through named,
> allowlisted wallet operations; autonomous strategy code cannot create
> arbitrary approvals.

## B5.2 Signer request contract

---

Check before signing Invariant

---

**Permit** Exists durable, unexpired, unused
where single-use is required;
intent/payload/policy/lease hash
match.

**Wallet/chain** Expected signer/account
wallet/wallet type; Polygon/current
contract registry.

**Action** Only allowlisted
order/cancel/position-lifecycle
action; no arbitrary
destination/calldata.

**Amount** Canonical exact amount \<= permit
reservation and hard policy.

**Freshness** Quote/market/rules/venue mode/clock
within required TTL.

**Audit** Canonical payload hash recorded
before side effect; sensitive raw
key never logged.
-----------------------------------------------------------------------

# B6. Data Plane, Event Graph and Catalyst Bus

## B6.1 Data pipeline

---

Gamma / market discovery + CLOB market metadata + market WS + user WS +
Data API\
\|\
v\
canonical identity / rules / fee / book / activity / account snapshots\
\|\
+\--\> Native Event Graph (event + negative-risk)\
+\--\> Inferred Relation Graph (conditional/correlated/temporal)\
+\--\> Catalyst/Event Bus (news/rules/price/volume/schedule changes)\
+\--\> Decision Snapshot Archive
-----------------------------------------------------------------------

---

## B6.2 Market Graph edge contract

---

relation_type Trust level Use

---

NATIVE_NEG_RISK / VERIFIED_PLATFORM Risk grouping;
NATIVE_EVENT_MEMBER structural strategy if
payout/rules validated.

COMPLEMENT VERIFIED_RULES or Probability constraint
INFERRED and risk. Structural
execution only when
deterministic.

MUTUALLY_EXCLUSIVE VERIFIED_RULES or Portfolio/event cap;
INFERRED relative-value
research.

SUBSET / SUPERSET INFERRED/VERIFIED_RULES Logical consistency
checks; conservative
risk until validated.

CONDITIONAL / INFERRED Forecast features and
TEMPORAL_DEPENDENCY correlation risk; never
treated as risk-free.

SHARED_RESOLUTION_SOURCE / INFERRED Risk clustering and
CORRELATED evidence/catalyst
propagation.
----------------------------------------------------------------------------

# B7. Research and Forecast Intelligence

## B7.1 Research quarantine

> • Retrieval worker receives a market research question, source
> allow/deny policy and resource budget, not system authority or
> financial secrets.
>
> • HTTP egress validates URL scheme, DNS/IP and redirects; blocks
> localhost/private/link-local/metadata networks; caps bytes, archive
> expansion, content type and time.
>
> • Raw content is normalized into evidence claims with provenance.
> Embedded instructions remain quoted data and are never placed into
> privileged system instructions.
>
> • Sports-specific Polymarket stream is treated as informational only;
> sports strategies require independently validated authoritative sports
> feeds because official docs explicitly disclaim it as a
> trading-decision basis.

## B7.2 Forecast ensemble pipeline

---

market baseline / prior \-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+\
retrieved primary evidence -\> forecaster A \|\
counterevidence \-\-\-\-\-\-\-\-\-\-\--\> forecaster B \|\--\>
deterministic aggregation \--\> calibration\
market microstructure \-\-\-\-\--\> statistical C \| \|\
graph relations \-\-\-\-\-\-\-\-\-\-\--\> structural D \| v\
component lineage actionable distribution
-----------------------------------------------------------------------

---

> • Each component is independently scored; aggregator does not hide
> disagreement. Market price is captured at the same decision timestamp
> and is benchmark/prior signal, never a future input.
>
> • Calibration is segmented by model/provider/category/horizon/regime
> only when sample suffices. Aggregate forecasts may require their own
> recalibration.
>
> • Emerging likelihood-aggregation research can be tested as an
> experimental forecaster, but no new preprint methodology becomes LIVE
> authority without prospective qualification.
>
> • Provider fallback creates a new lineage; model alias/system
> fingerprint/API version are stored when the provider exposes them.

# B8. Strategy Runtime and Autonomous Arbiter

---

Strategy Input Output / gate

---

**evidence_directional_v2** Calibrated Desired directional
probability + evidence exposure or NO_TRADE.
quality + executable P0 core candidate.
book + catalysts/costs.

**market_graph_relative_value_v1** Verified graph Paired/multi-leg
constraints + proposal; requires
synchronized executable atomicity/risk behavior
quotes + settlement appropriate to actual
compatibility. venue capabilities.

**maker_liquidity_v1** Book microstructure + Maker quotes; P1
inventory + post-only experimental until
capability + fee/rebate micro-LIVE fill/rebate
schedule + calibration.
adverse-selection  
model.

**smart_money_consensus_v1** Public wallet Forecast
activity + reproducible feature/proposal; P1;
wallet-score history + never blind copy.
causally available  
timestamps.
------------------------------------------------------------------------------------

## B8.1 Arbiter algorithm

> **1.** Collect only proposals from exact strategy versions marked
> eligible for current mode/risk tier.
>
> **2.** Discard expired/rules-changed/data-stale proposals and those
> whose required graph/source/capabilities are unavailable.
>
> **3.** Normalize proposals into desired economic exposure, not raw
> order quantities.
>
> **4.** Deduplicate/net correlated proposals through Market Graph and
> strategy budget rules.
>
> **5.** Compare incremental portfolio utility/net EV including
> opportunity cost and exit/reallocation alternatives.
>
> **6.** Emit bounded TradeIntent(s); final authority remains with Money
> Kernel.

# B9. Economics, Position Sizing and Money Kernel

## B9.1 Net economics

---

**Economic equation** Net economic EV = expected payout value -
executable cash debit - taker fee - adverse-selection/slippage/latency
cost - allocated AI/data/infra cost + conservatively eligible
maker/taker rebates. Realized rebates replace estimates in accounting.
-----------------------------------------------------------------------

---

> • Do not hardcode current rebate tables as durable alpha.
> Query/version fee/rebate parameters where available; otherwise assume
> no rebate in pre-trade EV and record realized payments later.
>
> • VWAP already incorporates depth. Do not double-count the same
> slippage component. Make assumptions explicit and test against
> micro-LIVE.

## B9.2 Robust position sizer

---

calibrated actionable probability / payout distribution\
\| uncertainty + market liquidity\
v\
raw suggested risk amount\
\| optional bounded fractional-Kelly AFTER validation\
v\
strategy cap -\> market/event/correlation cap -\> portfolio cap -\>
loss tier -\> exact reservation
-----------------------------------------------------------------------

---

**Explicit rejection of an upstream heuristic.** Pinned Clodds dynamic
Kelly maps edge to a probability proxy, uses an arbitrary confidence
input and can boost size after win streaks. PolyRoot does not use that
as authoritative sizing. Recent wins are not new information about the
current event unless a pre-registered model proves otherwise.

## B9.3 Atomic authorization sequence

> **1.** Validate LIVE + active Autonomy Charter + exact qualified
> strategy/version + account/access/readiness.
>
> **2.** Validate market identity/rules/graph/fee/venue
> mode/quote/forecast freshness and clock.
>
> **3.** Compute net economics and liquidity-constrained suggested size.
>
> **4.** Apply graph-aware market/event/correlation/strategy/portfolio
> and loss/protective-tier limits including unknown obligations.
>
> **5.** Within one short DB transaction lock policy/wallet risk row,
> revalidate projection version, write reservation + RiskDecision +
> outbox/permit atomically.
>
> **6.** Executor rechecks short permit TTL, lease, venue mode,
> quote/rules and balance before typed signer request.

# B10. VenueAdapter and Execution State Machines

## B10.1 Adapter surface

---

Method family Contract

---

**capabilities/getMarket/getBook** Return current order types,
wallet/collateral support, tick/min
size/fee/status/mode and verified
snapshot. Unsupported is explicit.

**buildCanonicalOrder** Exact units, chain/contract/wallet
identity, order style/deadline.
Business layer never hand-builds
SDK payloads.

**submit** Return ACK / DEFINITIVE_REJECT /
UNKNOWN; ACK is not a fill.
Ambiguous response remains UNKNOWN.

**get/list orders & trades** Overlap/pagination; preserve raw
status; detect external/manual
activity.

**cancel/cancelAll** Per-order result and late-fill
reconciliation; cancel does not
undo matched trades.

**userStream/marketStream/heartbeat** Independent health/readiness;
reconnect snapshot/lookback;
heartbeat behavior versioned by
contract test.

**balances/allowances/positions** Fresh asset-aware state for
spendability/reconciliation.

**settlement/redeem** Only final eligible positions;
typed signer action; confirmed
receipt before ledger credit.
---------------------------------------------------------------------------

## B10.2 Intent/order/trade states

---

Domain Core states Invariant

---

**Intent** CREATED -\> VALIDATED EXPIRED releases only if
-\> RESERVED -\> no ambiguous submit
DISPATCHED \| REJECTED exists.
\| EXPIRED

**Submit** SUBMITTING -\> UNKNOWN retains
ACKNOWLEDGED \| reservation and triggers
SUBMISSION_UNKNOWN \| lookup/reconcile; no blind
DEFINITIVE_REJECT replacement.

**Order** LIVE / PARTIAL / Raw venue status stored;
MATCHED / CANCELED / remaining quantity is
EXPIRED / REJECTED / source for replace, never
UNKNOWN original size.

**Cancel** CANCEL_REQUESTED -\> Release only verified
CANCELED \| canceled remainder; late
CANCEL_UNKNOWN \| fill stays economic.
NOT_CANCELED

**Trade** MATCHED -\> Arrival can be
MINED/RETRYING -\> duplicated/out-of-order;
CONFIRMED \| FAILED final state cannot be
downgraded by stale event.

**Position** pending -\> settled -\> Pending consumes risk but
redeemable -\> is not freely sellable
redeemed; disputed unless venue/settlement
separate state says so.

**Resolution** open -\> proposed -\> Trade settlement and
challenged/disputed -\> market resolution are
final separate lifecycles.
--------------------------------------------------------------------------

# B11. Timeout, Rate Limits, Restricted Modes and Automatic Recovery

## B11.1 Submission protocol

> • A logical decision has a stable dedupe_key within
> wallet/strategy/decision scope. Same key with different payload is
> conflict.
>
> • Intent/reservation/outbox are durable before network. Canonical
> payload/order hash is persisted before an ambiguous side effect where
> possible.
>
> • Network timeout after possible acceptance is UNKNOWN, not failure.
> Lookup uses order ID/hash/account/time/pagination/trades; insufficient
> lookup keeps UNKNOWN.
>
> • Financial transport retry is narrower than ordinary API retry.
> 425/restricted-mode retry still requires TTL/quote/rules/venue-mode
> revalidation before a new submit attempt.

## B11.2 Venue mode action matrix

---

Venue mode New taker New Cancel Reconcile
maker/postOnly

---

**NORMAL** Allowed if Allowed if Allowed Required
permit valid permit valid

**POST_ONLY** Blocked Allowed only if Allowed Required
strategy/order  
still valid  
post-only

**CANCEL_ONLY** Blocked Blocked Allowed Required

**RESTARTING / Blocked Retry only after Best effort Required when
425** backoff + full per endpoint available
revalidation availability

**UNKNOWN / Blocked Blocked Best effort if Required /
UNAVAILABLE** reachable recovery
snapshot
-------------------------------------------------------------------------------

## B11.3 Rate governor

> • Maintain separate budgets for critical cancel/reconcile/heartbeat
> versus market-data/research traffic; do not spend the emergency budget
> on discovery scans.
>
> • Record queue_age_ms and deadline. Because Cloudflare can throttle by
> delaying/queueing, a request that reaches the front of a queue after
> intent TTL is no longer automatically valid.
>
> • Use local token buckets below documented maximums, adaptive backoff,
> Retry-After where supplied and circuit-breaker behavior under
> persistent throttling.

# B12. Ledger, Accounting, Reconciliation and Settlement

---

Table / projection Key constraints

---

wallets / credentials / Verified
asset_registry signer/wallet/wallet_type/chain/contracts/decimals;
secret references only, never raw secret in ledger.

autonomy_charters / policy_versions Immutable version/hash/effective/expiry/revocation;
governance proof.

markets / market_versions / Official IDs; rules/fee/mode validity;
graph_edges native/inferred relation provenance.

evidence / forecasts / experiments available_at/source cutoff,
model/prompt/calibrator/ensemble lineage, labels only
after finality.

intents / decisions / reservations UNIQUE(wallet,dedupe_key), exact asset units,
ledger/policy/quote/lease versions.

orders / venue_trades / settlements Unique venue/account IDs; raw + internal status,
quantities, fee/rebate, timestamps/receipt.

ledger_events / postings Append-only, dedupe/version; balanced postings per
asset; correction_of_event_id.

wallet_projections / position_lots projected_event_seq; free/reserved/pending/settled;
weighted-average or frozen cost-basis method.

outbox_jobs / inbox_events / leases Transactional outbox, event/status dedupe, retry
class, lease epoch/expiry.

audit / costs / gate_reports Actor/correlation IDs, before/after hash,
model/data/infra costs, release/test evidence,
redacted secrets.
-----------------------------------------------------------------------------------------

> • Free cash = verified settled spendable pUSD - active cash
> reservations, without counting a reservation twice after it becomes a
> fill. Free shares = settled inventory - sell reservations.
>
> • Pending matched exposure consumes risk even before it is sellable.
> ACK/open order produces no realized PnL.
>
> • Net economic PnL = trading PnL - operating costs + realized rebates;
> deposits/withdrawals are cash flows, not profit.
>
> • Reconcile immediately at startup/reconnect/unknown and target every
> 15s while healthy. Material drift blocks new entry and is never
> "rounded away."

# B13. Security Architecture

---

Threat Control stack

---

**Indirect prompt injection** Research quarantine -\>
source/HTML/text normalization -\>
untrusted marker -\> structured schema
-\> privileged forecast context without
executable instructions -\> no signer
capability.

**SSRF/internal-network probing** Controlled egress, scheme/domain/IP
validation,
private/link-local/localhost/metadata
deny, DNS/redirect revalidation,
response/decompression/time caps.

**Malicious strategy/plugin** Separate process/container or hardened
worker, no host env/Docker socket/raw
DB/signer, explicit capability
manifest, signed release.

**Credential leakage** Secret store/file permissions,
per-service secret mounts,
canary/redaction, no secret in
prompt/log/export/backups, narrow
signer.

**Supply-chain compromise** Dependency amputation, exact
lock/digests, SBOM/provenance,
install-script review,
vulnerability/secret scans, immutable
image.

**Privilege escalation from UI** TLS, strong auth,
HttpOnly/Secure/SameSite, CSRF,
governance reauth, internal network
isolation, audit.
---------------------------------------------------------------------------

# B14. Deployment, Persistence and Observability

## B14.1 Initial VPS layout

---

Unit Boundary / resource rule

---

**Reverse proxy** Only public HTTPS dashboard/API;
rate limits/headers; no internal
executor/DB routes.

**Gateway/control** Non-root; no trading secret; owner
session + read models + governance
command inbox.

**Data/research/intelligence** Read-only/research roles;
controlled egress; CPU/memory
limits; no signer/financial writer.

**Strategy workers** Sandboxed, exact strategy
image/version; no secrets; proposal
output only.

**Money kernel/executor** Private network; single wallet
lease authority; financial DB
roles; no general web browsing/LLM.

**Signer Vault** Smallest possible process/secret
scope; allowlisted local RPC from
executor only.

**PostgreSQL** Private bind; separate roles;
durable storage;
connection/statement limits;
WAL/disk monitoring.

**Backup/monitor** Encrypted off-host backups, restore
key separate from VPS,
metrics/log/alert pipeline.
-----------------------------------------------------------------------

---

**Initial capacity target** Start with a measured budget around 4 vCPU
/ 8 GiB RAM / \>=40 GiB free SSD for this service plus off-host backup,
inherited as a planning baseline from v1.0. Benchmark real market
count, streams, research load and storage growth before co-locating
other heavy services.
-----------------------------------------------------------------------

---

## B14.2 Observability

**Required metrics:** runtime_state, venue_mode, risk_tier,
quote_age_ms, metadata_age_s, forecast_age_s, graph_version_age,
user_stream_lag, heartbeat_age, rate_bucket_remaining, queue_age,
permit_age, unknown_order_count, reconciliation_diff, reserved/free
cash, pending settlement, exposure by cluster, loss latch, strategy
health, forecast cost, llm/data cost, clock skew, disk/WAL, backup_age,
restore_test_age, execution_reality_gap.

**Log identity:** correlation_id, charter/policy hash,
strategy/forecast/intent/decision/order IDs, event_seq, venue_mode and
reason_code. High-cardinality labels such as arbitrary evidence
URLs/order IDs stay in structured logs, not unbounded metric labels.

# B15. Paper, Shadow, Prospective Research and Autonomous Learning

---

Stage Protocol

---

**Preregistration** Universe/eligibility,
strategy/model/prompt/calibrator/aggregator,
parameter envelope, costs, benchmarks,
metrics, CI/bootstrap, stopping rule and
sensitivity frozen before final evaluation.

**Historical replay** Rolling-origin/time-respecting; evidence
available_at enforced; complete
market-selection log; use as debugging/priors
only because LLM pretraining contamination may
exist.

**PAPER live** Use contemporaneous
book/depth/tick/min-size/fees, latency and
conservative queue/fill model; report
uncertain fill rather than inventing one.

**SHADOW prospective** Freeze exact version; record hypothetical
intents/quotes/research without orders;
same-time market baseline; no post-resolution
leakage.

**micro-LIVE** Validate actual signing, rate/mode behavior,
fill/settlement, fees/rebates and simulator
reality gap under small explicit cap.

**Autonomous experiment factory** System may propose/test new hypotheses in
PAPER/SHADOW inside compute budget; all
variants enter registry; no code/strategy
auto-promotes to LIVE.
----------------------------------------------------------------------------------

> • Forecast metrics: Brier, log loss, calibration/reliability,
> sharpness, abstention/coverage and same-timestamp market baseline by
> category/horizon/model/ensemble.
>
> • Trading metrics: gross/net PnL and edge, drawdown, turnover,
> fill/cancel ratio, execution reality gap, fees/rebates, LLM/data/infra
> cost, capacity/depth, concentration and independent event clusters.
>
> • Use clustered bootstrap or equivalent preregistered uncertainty
> where dependencies exist. Too few independent clusters means
> inconclusive, not "pass."
>
> • Track all tried variants and failed hypotheses. Multiple testing and
> repeated peeking are explicit risks; best-of-many historical result
> alone is not promotion evidence.

# B16. Traceability and 96 Primary Acceptance Scenarios

**Trace rule.** Each PR-\* requirement from the PRD maps to exactly one
primary T-PR-\* scenario below. These are acceptance specifications, not
claims of executed tests. Implementation expands each into unit,
property, contract, concurrency, fault and security tests as
appropriate.

## B16.1 Acceptance --- Governance & autonomy charter

---

Test / priority Scenario -\> required Gate
result

---

**T-PR-GOV-01\ Change an G0-G1
P0** upstream/dependency  
hash: release is  
rejected until the  
manifest and  
disposition matrix are  
updated.

**T-PR-GOV-02\ Enable a second venue G0-G7
P0** without its venue gate:
LIVE routing refuses it
while research/PAPER  
remains available.

**T-PR-GOV-03\ With an active charter, G0-G7
P0** 100 eligible intents  
can execute without  
interactive approval;  
an expired/superseded  
charter blocks new  
risk.

**T-PR-GOV-04\ Disconnect the G1-G7
P0** dashboard/operator: an  
eligible autonomous  
cycle continues; only  
governance-changing  
actions are  
unavailable.

**T-PR-GOV-05\ Prompt/tool call G1-G3
P0** attempts to raise  
limits or enable an  
unqualified strategy  
are rejected, audited,  
and do not change the  
policy hash.

**T-PR-GOV-06\ Simulate G0-G7
P0** CLOSE_ONLY/BLOCKED:  
entry is denied; only  
platform-permitted risk
reduction/cancel is  
attempted and status is
visible.

**T-PR-GOV-07\ Attempt governance G0-G7
P0** mutation from  
LLM/research process:  
403/capability  
rejection and immutable
audit event.

**T-PR-GOV-08\ Add a connector without G0-G3
P1** license/data-right  
record: build or  
strategy eligibility  
gate fails.
-----------------------------------------------------------------------

## B16.2 Acceptance --- 24/7 autonomy runtime

---

Test / priority Scenario -\> required result Gate

---

**T-PR-AUT-01\ Kill each service at G2-G7
P0** randomized boundaries:  
supervisor restores it; no  
duplicate economic execution  
occurs.

**T-PR-AUT-02\ Run a 24-hour deterministic G2-G7
P0** scenario with no UI session:  
the loop completes  
entries/exits/reconciliation  
within charter limits.

**T-PR-AUT-03\ Inject network/DB/provider G2-G7
P0** outages: entries pause, state  
reconciles, and the system  
resumes automatically only  
after blockers clear.

**T-PR-AUT-04\ Primary provider fails G1-G7
P0** mid-cycle: fallback either  
produces a valid new-lineage  
forecast or abstains;  
executor/reconciler remain  
healthy.

**T-PR-AUT-05\ Two qualified strategies issue G3-G7
P0** conflicting intents: arbiter  
applies frozen  
precedence/portfolio rules and
never double-counts desired  
exposure.

**T-PR-AUT-06\ Trigger each tier: all new G2-G7
P0** decisions use stricter limits;
recovery to a higher tier  
follows only preconfigured,  
auditable criteria.

**T-PR-AUT-07\ Adaptive tuner proposes G3-G7
P0** out-of-envelope parameter:  
rejected; in-envelope change  
creates a new  
parameter/version record.

**T-PR-AUT-08\ Auto-generated strategy runs G3-G7
P1** in isolated PAPER/SHADOW only;
attempted LIVE promotion  
without signed release gate  
fails.
------------------------------------------------------------------------------

## B16.3 Acceptance --- Wallet, credentials & signer

---

Test / priority Scenario -\> required Gate
result

---

**T-PR-WAL-01\ SDK upgrade changes a G0-G1
P0** method/schema: adapter  
contract test fails  
before release;  
financial domain code  
remains unchanged.

**T-PR-WAL-02\ Exercise supported G0-G4
P0** fixtures for wallet  
types; unsupported  
signature type fails  
before  
signing/submission.

**T-PR-WAL-03\ Swap signer and wallet G0-G4
P0** in a fixture:  
startup/submit fails  
before any financial  
side effect.

**T-PR-WAL-04\ Revoke/rotate L2 G1-G7
P0** credentials: executor  
transitions safely and  
old credentials cannot  
authorize new requests.

**T-PR-WAL-05\ Compromise research G1-G4
P0** container: no  
relayer/builder key is  
readable; wallet  
administration  
endpoints are absent.

**T-PR-WAL-06\ Wallet has nominal G0-G7
P0** balance but missing  
allowance: free  
spendable cash is lower
and entry is rejected  
until setup is valid.

**T-PR-WAL-07\ Send arbitrary contract G1-G4
P0** calldata or mismatched  
amount/policy hash to  
signer: signing is  
refused and audited.

**T-PR-WAL-08\ Strategy/LLM requests a G0-G7
P1** transfer/bridge: no  
tool exists; approved  
break-glass workflow  
remains separate from  
trading autonomy.
-----------------------------------------------------------------------

## B16.4 Acceptance --- Market data & graph

---

Test / priority Scenario -\> required result Gate

---

**T-PR-DATA-01\ Two same-title markets with G1-G7
P0** different IDs never share  
positions, forecasts or  
ledger state.

**T-PR-DATA-02\ Change rules/clarification G1-G7
P0** after forecast: stale intent
fails RULES_CHANGED and  
requires a new forecast.

**T-PR-DATA-03\ Drop/reorder stream events: G1-G7
P0** entry stops until fresh  
snapshot/reconciliation  
proves a coherent state.

**T-PR-DATA-04\ Inject G1-G7
P0** post-only/cancel-only/425:  
order behavior changes  
correctly instead of blind  
retry.

**T-PR-DATA-05\ Negative-risk event fixture G1-G7
P0** creates  
mutually-exclusive/native  
edges and consistent  
exposure grouping.

**T-PR-DATA-06\ Low-confidence inferred edge G2-G7
P0** may inform risk/research but
cannot trigger  
structural-arbitrage  
execution.

**T-PR-DATA-07\ Replay universe for a day G2-G7
P0** reproduces the exact  
eligible/rejected set and  
reason codes.

**T-PR-DATA-08\ Complete experiment remains G3-G7
P1** reproducible after hot  
raw-book retention expires.
----------------------------------------------------------------------------

## B16.5 Acceptance --- Intelligence & forecasting

---

Test / priority Scenario -\> required result Gate

---

**T-PR-INT-01\ Malformed/out-of-range/missing-lineage G1-G7
P0** forecast is rejected before strategy  
use.

**T-PR-INT-02\ Evaluation report compares model to G2-G7
P0** same-timestamp market baseline without  
leakage from later prices.

**T-PR-INT-03\ Seed a one-sided evidence set: G2-G7
P0** counter-search surfaces opposing  
evidence or records a documented  
coverage failure.

**T-PR-INT-04\ Three syndicated copies contribute one G2-G7
P0** independent source; first-party primary  
source remains distinguishable.

**T-PR-INT-05\ Remove one component: ensemble reruns G3-G7
P0** with changed lineage and no hidden  
substitution; all component outputs  
remain auditable.

**T-PR-INT-06\ Model/category shift cannot silently G3-G7
P0** inherit an incompatible calibrator;  
system abstains or uses an eligible  
fallback.

**T-PR-INT-07\ Canary future evidence never appears in G3-G7
P0** historical replay; model alias change  
creates a new lineage record.

**T-PR-INT-08\ Exhaust all LLM quota: no stale forecast G2-G7
P1** creates an entry and financial safety  
processes continue.
----------------------------------------------------------------------------------------

## B16.6 Acceptance --- Strategy platform

---

Test / priority Scenario -\> required Gate
result

---

**T-PR-STR-01\ Malicious strategy G2-G7
P0** attempts  
filesystem/env/network  
escape:  
sandbox/allowlist blocks
it and signer remains  
unreachable.

**T-PR-STR-02\ Positive raw edge that G3-G7
P0** disappears after  
conservative  
probability/cost/depth  
produces NO_TRADE.

**T-PR-STR-03\ Inconsistent native G3-G7
P0** negative-risk group is  
detected in PAPER;  
inferred-only  
relationship cannot  
bypass validation gate.

**T-PR-STR-04\ Maker rebate rises but G4-G7
P1** adverse selection makes  
net EV negative: no  
quote is placed.

**T-PR-STR-05\ High-PnL wallet without G4-G7
P1** sufficient independent  
history/causal timing is
excluded or  
down-weighted.

**T-PR-STR-06\ Simultaneous intents for G3-G7
P0** same token/event are  
netted into one bounded  
desired exposure.

**T-PR-STR-07\ A position with G3-G7
P0** deteriorated hold EV  
exits/reduces without  
waiting for human  
approval or market  
resolution.

**T-PR-STR-08\ Change one threshold G3-G7
P0** during holdout: new  
experiment/version  
created and old results  
remain immutable.
------------------------------------------------------------------------

## B16.7 Acceptance --- Money kernel & risk

---

Test / priority Scenario -\> required Gate
result

---

**T-PR-RISK-01\ Parallel intents that G1-G7
P0** together breach a cap  
result in at most the  
safe subset being  
reserved.

**T-PR-RISK-02\ Three markets from one G2-G7
P0** event cannot each  
consume a separate full
market cap.

**T-PR-RISK-03\ Crash after G1-G7
P0** reservation/before  
submit and  
timeout-after-submit  
preserve correct  
capacity across  
restart.

**T-PR-RISK-04\ LLM says "95% G3-G7
P0** confident" with  
unchanged calibrated  
distribution: position  
size does not increase.

**T-PR-RISK-05\ Safe size falls below G1-G7
P0** min_size: system  
abstains instead of  
rounding up.

**T-PR-RISK-06\ Daily stop persists G2-G7
P0** through restart;  
configured next-period  
recovery resumes at  
reduced tier without  
human trade approval.

**T-PR-RISK-07\ Cancel failure does not G1-G7
P0** falsely free shares;  
flatten reports  
partial/failure rather  
than claiming zero  
exposure.

**T-PR-RISK-08\ Unknown order cannot be G1-G7
P0** ignored to place  
replacement exposure;  
external trade  
immediately changes  
available risk.
-----------------------------------------------------------------------

## B16.8 Acceptance --- Execution & venue lifecycle

---

Test / priority Scenario -\> required Gate
result

---

**T-PR-EXE-01\ Call-graph/security G1-G7
P0** tests find no active  
direct order/sign path  
outside the executor  
boundary.

**T-PR-EXE-02\ Read-only contract test G0-G7
P0** against current API/SDK  
matches frozen adapter  
fixtures; mismatch  
blocks release.

**T-PR-EXE-03\ Repeat identical logical G1-G7
P0** request 100 times: one  
intent and at most one  
active economic order  
result.

**T-PR-EXE-04\ Venue accepts but G1-G7
P0** response is lost: system
finds/holds the order  
without a duplicate  
submit.

**T-PR-EXE-05\ Partial fill arrives G1-G7
P0** during cancel:  
replacement does not  
duplicate position and  
reservations transition  
exactly once.

**T-PR-EXE-06\ Out-of-order/duplicate G1-G7
P0** trade events cannot  
downgrade terminal state
or double-post economic  
effect.

**T-PR-EXE-07\ Throttle/425/post-only G1-G7
P0** fixture delays request  
beyond TTL: stale intent
is re-evaluated or  
cancelled, not submitted
late.

**T-PR-EXE-08\ Paper predicts fill but G4-G7
P0** micro-LIVE repeatedly  
misses: simulator  
calibration worsens and  
strategy gate reflects  
the reality gap.
------------------------------------------------------------------------

## B16.9 Acceptance --- Ledger & reconciliation

---

Test / priority Scenario -\> required result Gate

---

**T-PR-LED-01\ Replay identical event stream G1-G7
P0** produces identical balances/PnL  
with no duplicate economic  
effect.

**T-PR-LED-02\ Property tests across G1-G7
P0** rounding/fee-in-cash-or-shares  
preserve asset identities.

**T-PR-LED-03\ Delete projections and rebuild G1-G7
P0** from events: result matches  
before deletion.

**T-PR-LED-04\ Inject balance/trade drift: new G1-G7
P0** entries stop and discrepancy is  
resolved or explicitly  
escalated.

**T-PR-LED-05\ Manual trade appears on venue: G2-G7
P0** it is detected, posted and  
reduces free capacity.

**T-PR-LED-06\ Rebate/cost changes alter net G3-G7
P0** economics without rewriting  
gross trading PnL.

**T-PR-LED-07\ FAILED after MATCHED reverses G2-G7
P0** pending effect exactly once and  
preserves audit lineage.

**T-PR-LED-08\ Export reconciles to ledger G3-G7
P1** totals and contains no private  
keys/API secrets.
--------------------------------------------------------------------------------

## B16.10 Acceptance --- Security boundaries

---

Test / priority Scenario -\> required result Gate

---

**T-PR-SEC-01\ Evidence containing "transfer G2-G7
P0** funds/reveal key" changes  
neither tools nor policy and  
is stored as untrusted text.

**T-PR-SEC-02\ Compromise retrieval worker: G2-G7
P0** attacker cannot reach  
executor/signing/private DB  
roles.

**T-PR-SEC-03\ URL redirect/DNS-rebind to G2-G7
P0** 127.0.0.1/RFC1918 is blocked  
and logged.

**T-PR-SEC-04\ Secret canary never appears G1-G7
P0** in  
prompt/log/export/telemetry  
after fault and debug paths.

**T-PR-SEC-05\ Malicious plugin cannot open G2-G7
P0** arbitrary socket/read  
env/write financial DB.

**T-PR-SEC-06\ Reintroduce unrelated G0-G7
P0** trading/shell package into  
LIVE image: dependency  
allowlist/build gate fails.

**T-PR-SEC-07\ Unauthenticated internet G2-G7
P0** client cannot read portfolio,
mutate policy or reach  
internal executor routes.

**T-PR-SEC-08\ Known attack corpus remains G2-G7
P1** blocked; regression in a  
critical path blocks  
promotion.
-----------------------------------------------------------------------------

## B16.11 Acceptance --- Operations & reliability

---

Test / priority Scenario -\> required Gate
result

---

**T-PR-OPS-01\ Network-policy test G2-G7
P0** proves research/gateway
cannot directly reach  
signer socket or  
financial DB writer  
role.

**T-PR-OPS-02\ Two replicas race: only G2-G7
P0** current epoch can  
sign/submit; no  
split-brain order  
occurs.

**T-PR-OPS-03\ Restart at each durable G2-G7
P0** boundary: no stale  
intent is executed and  
prior live orders  
remain managed.

**T-PR-OPS-04\ Destroy host and G3-G7
P0** restore on a clean  
machine; entry remains  
blocked until state is  
reconciled and measured
RPO/RTO are reported.

**T-PR-OPS-05\ Inject stale book/disk G2-G7
P0** full/clock skew/unknown
submit: correct  
protective state and  
deduplicated  
incident/recovery event
occur.

**T-PR-OPS-06\ Saturate research G2-G7
P0** CPU/memory: executor  
heartbeat/reconcile SLO
remains within target  
or entries pause  
safely.

**T-PR-OPS-07\ Rollback incompatible G0-G7
P0** schema is refused;  
existing live orders  
remain reconcilable  
across deployment.

**T-PR-OPS-08\ Daily AI/data budget G3-G7
P1** reached: research  
degrades/abstains while
financial monitoring  
continues.
-----------------------------------------------------------------------

## B16.12 Acceptance --- Validation & release gates

---

Test / priority Scenario -\> required result Gate

---

**T-PR-VAL-01\ Mock passes but current G0-G7
P0** read-only contract differs:  
release remains blocked until  
adapter is updated.

**T-PR-VAL-02\ Random G1-G7
P0** partial-fill/reorder/rounding  
sequences never violate  
financial invariants.

**T-PR-VAL-03\ Fault suite achieves zero G2-G7
P0** duplicate economic execution  
and zero unexplained financial  
drift.

**T-PR-VAL-04\ Resting limit touching midpoint G3-G7
P0** alone does not count as fill;  
calibrated error metrics are  
recorded.

**T-PR-VAL-05\ Post-cutoff news/outcomes never G4-G7
P0** enter prior decisions; full  
universe and abstentions are  
logged.

**T-PR-VAL-06\ A forecast with higher win rate G4-G7
P0** but worse proper  
score/calibration is not called
superior.

**T-PR-VAL-07\ Best-of-many variant cannot be G4-G7
P0** promoted without preregistered  
holdout/prospective evidence  
and trial registry.

**T-PR-VAL-08\ All engineering tests pass but G0-G7
P0** net economic gate fails:  
autonomous-LIVE promotion is  
denied.
-------------------------------------------------------------------------------

# B17. Release Evidence, ADRs and Implementation Sequence

## B17.1 Mandatory gate artifacts

---

Artifact Minimum fields/content

---

**release_manifest.json** Fork SHA, lock/dependency hashes,
SDK/runtime/image digests,
schema/migrations, wallet/contract
registry, strategy/model versions,
policy version, gate report refs,
disposition summary.

**test_report.json** requirement/test ID,
commit/image/schema, fixture/API
version, timestamp, input/hash,
expected/actual/status, evidence path,
reviewer/automation provenance.

**experiment_report** Universe + all exclusions, cutoffs,
evidence/model/ensemble/calibrator,
parameters, cost allocation,
benchmark, proper scores, net
economics, CI, event clusters, all
tried variants.

**autonomy_charter** Wallet/signer identity, capital cap,
risk tiers/limits, exact
strategy/release allowlist,
markets/actions, auto-recovery policy,
expiry/revocation and commissioning
proof.

**fork_disposition.csv** Every upstream module/subsystem with
KEEP/ADAPT/REWRITE/REMOVE/QUARANTINE
and evidence that forbidden financial
paths are unreachable.

**restore_report** Backup source, target host, RPO/RTO
measured, lost/gap data, post-restore
reconciliation and readiness result.
--------------------------------------------------------------------------

## B17.2 Required ADRs before corresponding implementation

---

ADR Decision

---

**ADR-01** Fork reduction, dependency
allowlist and production
tool/capability model.

**ADR-02** Official SDK/version, wallet type
support, pUSD/contract/approval
registry and credential lifecycle.

**ADR-03** Canonical domain schemas, event
ledger, idempotency, reservations
and state machines.

**ADR-04** Autonomy Charter, 24/7 runtime
states, auto-recovery/resume and
exceptional hard-block governance.

**ADR-05** Market/Event Graph relation
taxonomy and graph-aware
risk/strategy use.

**ADR-06** Research quarantine, source
registry, forecast
ensemble/calibration and provider
lineage.

**ADR-07** Position sizing/economics,
fee/rebate treatment, risk tiers
and exit/reallocation utility.

**ADR-08** Deployment/security/signer
vault/egress
isolation/backup/rollback.

**ADR-09** PAPER simulator, prospective
evaluation, multiple-testing policy
and autonomous experiment factory.
-----------------------------------------------------------------------

## B17.3 Implementation order

> **1.** Freeze research baseline, fork disposition and production
> dependency graph; pin SDK/runtime and current contract fixtures.
>
> **2.** Define canonical schemas, Autonomy Charter,
> asset/wallet/credential registry and PostgreSQL ledger/migrations.
>
> **3.** Build Money Kernel, reservations, Signer Vault and VenueAdapter
> before any new strategy can reach a financial endpoint.
>
> **4.** Complete
> order/trade/cancel/settlement/reconciliation/fencing/rate/venue-mode
> fault harness and G1/G2 evidence.
>
> **5.** Harden deployment, security quarantine/egress, backup/restore
> and observability; close G3.
>
> **6.** Build market/event graph, source registry, ensemble/calibration
> and strategy sandbox/arbiter.
>
> **7.** Implement evidence_directional_v2 and graph_relative_value_v1
> plus exit/reallocation engine and full PAPER loop.
>
> **8.** Run PAPER and prospective SHADOW; qualify exact versions; then
> micro-LIVE and calibrate execution reality gap.
>
> **9.** Enable G7 24/7 autonomous-LIVE only when both operational and
> economic gates pass. Add experimental strategies separately, not by
> expanding the trust boundary.

# B18. Research Sources and Verification Boundaries

**Version-sensitive rule.** Polymarket changes quickly. Every SDK name,
wallet type, endpoint, fee/rebate schedule, contract address, rate limit
and venue behavior in this blueprint is a research baseline, not an
eternal constant. G0 must re-run official contract checks against the
actual deploy version and host.

---

ID Source Use in this specification

---

**S01** Original PRD v1.0 Polymarket_AI_Trader_PRD_v1.0.docx, baseline 8 Sep 2026. Retained: staged modes/gates, deterministic
risk, unknown-order discipline, ledger, prospective evaluation.

**S02** Original Blueprint v1.0 Polymarket_AI_Trader_Blueprint_v1.0.docx, baseline 8 Sep 2026. Retained: isolated executor, PG financial
ledger, reservation/outbox, reconciliation, recovery/fault testing.

**S03** CloddsBot pinned alsk1992/CloddsBot commit 715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8; package 1.9.0, MIT, large
baseline multi-venue/tool dependency surface.

**S04** CloddsBot execution src/execution/index.ts at pinned commit. Manual/direct signing and broad retry surface motivate
replacement of LIVE hot path.

**S05** CloddsBot tool registry src/agents/tool-registry.ts at pinned commit. 630+ tool design spans trading, shell, SQL, Docker,
messaging and multiple venues; not suitable as LIVE intelligence capability set.

**S06** CloddsBot risk engine src/risk/engine.ts at pinned commit. Useful concepts: kill switch, circuit breaker, exposure, drawdown,
VaR, volatility, Kelly; authoritative PolyRoot integration is redesigned around durable reservations.

**S07** CloddsBot dynamic Kelly src/trading/kelly.ts at pinned commit. Contains confidence/win-streak heuristics; PolyRoot does not use
verbal confidence or win-streak boosts as financial evidence.

**S08** CloddsBot provider src/providers/index.ts at pinned commit. Multi-provider/fallback/cost plumbing is reusable only behind
layer structured-output/capability/lineage controls.

**S09** Polymarket Trading https://docs.polymarket.com/trading/overview --- CLOB orders settle on Polygon in pUSD/outcome tokens;
Overview account setup is one-time, then order workflow repeats.

**S10** Polymarket Quickstart https://docs.polymarket.com/trading/quickstart --- current examples use \@polymarket/client
createSecureClient and pUSD-denominated market orders.

**S11** Polymarket Wallets & https://docs.polymarket.com/trading/wallets-auth --- Deposit Wallet default for account wallets deployed
Authentication on/after 4 May 2026; wallet type 3; L1/L2 credentials, relayer/builder and gasless wallet operations.

**S12** Polymarket CLOB V2 https://docs.polymarket.com/v2-migration --- CLOB V2 live 28 Apr 2026; V1 signed orders/legacy V1 SDK no
Migration longer production target; new contracts/backend/pUSD/fee behavior.

**S13** Official TypeScript SDK https://github.com/Polymarket/ts-sdk --- current \@polymarket/client package observed as 0.9.0 on
research baseline, Node \>=24. Pin exact version/digest at implementation gate.

**S14** Polymarket pUSD https://docs.polymarket.com/concepts/pusd --- pUSD is ERC-20 collateral used for Polymarket trading; 6
decimals on Polygon, USDC-backed.

**S15** Markets & Events https://docs.polymarket.com/concepts/markets-events --- events group related markets; some multi-market
events are mutually exclusive negative-risk groups.

**S16** Negative Risk Markets https://docs.polymarket.com/concepts/negative-risk --- atomic No-to-other-Yes conversion semantics
support native graph constraints.

**S17** Resolution https://docs.polymarket.com/concepts/resolution --- UMA proposal/challenge/dispute lifecycle; dispute
can delay final resolution.

**S18** Real-Time Data https://docs.polymarket.com/market-data/realtime-data --- market/user/RTDS feeds; sports stream is
informational and explicitly not a basis for trading decisions.

**S19** Matching Engine https://docs.polymarket.com/trading/matching-engine --- HTTP 425 during restart; post-only period after
Restarts restart; cancel-only/post-only require distinct order flow.

**S20** Polymarket Error Codes https://docs.polymarket.com/resources/error-codes --- current error taxonomy including 425 and
order/matching failures.

**S21** Polymarket Fees https://docs.polymarket.com/trading/fees --- category-dependent taker fee rates, maker fee 0 in
documented schedule, dynamic market fee metadata.

**S22** Maker Rebates https://docs.polymarket.com/programs/maker-rebates --- daily pUSD rebates based on executed maker
liquidity; program parameters can vary.

**S23** Taker Rebates https://docs.polymarket.com/programs/taker-rebates --- program live 28 May 2026, rolling weighted-volume
tiers and daily pUSD rebates; treat as dynamic policy.

**S24** Rate Limits https://docs.polymarket.com/api-reference/rate-limits --- Cloudflare throttling can delay/queue
requests; separate CLOB order/cancel rate limits.

**S25** Geographic Restrictions https://docs.polymarket.com/api-reference/geoblock --- check access before placing orders;
blocked/close-only states must be obeyed, not bypassed.

**S26** OWASP LLM Prompt https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html ---
Injection Prevention untrusted external content, least privilege and deterministic validation.

**S27** OWASP SSRF Prevention https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
--- URL/IP allow/deny validation, redirect/DNS/private-network defenses.

**S28** PostgreSQL Serializable https://www.postgresql.org/docs/17/transaction-iso.html --- serializable transactions may abort; retry
Transactions DB transaction, never blindly replay external financial side effects.

**S29** PostgreSQL PITR https://www.postgresql.org/docs/17/continuous-archiving.html --- base backup/WAL continuous archiving
supports point-in-time recovery; RPO/RTO require drills.

**S30** Halawi et al., NeurIPS Approaching Human-Level Forecasting with Language Models --- retrieval, forecasting and aggregation can
2024 approach competitive human crowd performance; pipeline matters.

**S31** Prophet Arena, ICLR Live probabilistic multi-horizon benchmark uses market baseline, proper scores/calibration and return
2026 metrics; supports modular/prospective evaluation.

**S32** Beyond Accuracy: Can OpenReview paper emphasizes forecasting accuracy is not the same as realized autonomous trading
LLM Forecasters Profit profitability; historical expected-value estimates are not live fill PnL.
on Prediction Markets?  
2026

**S33** LEAP, arXiv Sep 2026 Emerging preprint: explicit prior + per-evidence likelihood aggregation improves
auditability/calibration versus monolithic prediction in reported experiments. Treat as research input,
not established production truth.

**S34** LLM Forecasting Agents Survey highlights calibration under shift, contamination-resistant live evaluation, explicit
Survey, arXiv Aug 2026 cost/accuracy reporting and hybrid retrieval/statistical designs.

**S35** Calibration-Induced Case study shows expensive LLM features can contribute nothing after calibration; motivates
Degeneracy, arXiv Aug calibration-viability checks and cheap baselines.
2026

**S36** Gneiting & Raftery 2007 Strictly proper scoring rules support honest probabilistic evaluation; Brier/log loss used alongside
calibration.

**S37** Hyndman & Forecasting: Principles and Practice --- rolling-origin/time-series cross-validation preserves temporal
Athanasopoulos order.

**S38** Kapoor & Narayanan 2022 Leakage and reproducibility --- data leakage can materially inflate ML results; temporal/source cutoffs
are mandatory.

**S39** Bailey et al. The Probability of Backtest Overfitting --- searching many variants produces selection bias; register
all trials and protect holdout/prospective evaluation.

**S40** Forecast combination Forecast combinations often improve robustness, but aggregation can disturb calibration; component and
literature aggregate forecasts require separate evaluation/recalibration.
--------------------------------------------------------------------------------------------------------------------------------------------------------
