**POLYROOT**

**Modular Autonomous Prediction-Market\
Intelligence & Trading System**

**Product Requirements Document (PRD)**

**Version 1.1 • Correction & Completion Release • 9 September 2026**

Research baseline: official Polymarket CLOB V2 documentation, current
official TypeScript SDK, pinned CloddsBot fork source, security
guidance, PostgreSQL durability guidance, and live/prospective
forecasting literature.

  -----------------------------------------------------------------------
  **Autonomy contract.** After one-time commissioning, PolyRoot operates
  24/7 with zero human approval per trade. It autonomously discovers
  markets, researches, forecasts, selects qualified strategies, sizes
  positions, enters, cancels/replaces, exits, redeems, reconciles,
  recovers, and resumes inside an immutable hard-cap policy. Human
  governance is reserved for commissioning, capital/signer changes,
  compliance blocks, and exceptional security recovery, not market
  decisions.
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------

*Status: implementation specification. Not a claim of profitability,
production readiness, or legal eligibility in any jurisdiction.*

# P0. Executive Product Decision

**Product definition.** PolyRoot is a single-owner, self-hosted, modular
autonomous prediction-market intelligence and trading system. Its
production target is not a chat assistant that occasionally trades; it
is a continuously running market research, forecasting, strategy, risk
and execution organism whose routine market decisions are
human-out-of-the-loop.

  -----------------------------------------------------------------------
  **Non-negotiable autonomy** Once commissioned, no human click, message,
  confirmation or approval is required for an individual trade or
  ordinary recovery. Human governance defines hard boundaries; machines
  make market decisions inside them.
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------

  -----------------------------------------------------------------------
  Dimension               v1.0 baseline           PolyRoot v1.1 decision
  ----------------------- ----------------------- -----------------------
  **Product identity**    Polymarket AI Trader    PolyRoot modular
                                                  autonomous
                                                  prediction-market
                                                  intelligence & trading
                                                  system

  **Operating model**     Autonomous within owner 24/7 closed loop with
                          mandate                 persistent Autonomy
                                                  Charter; zero per-trade
                                                  approval

  **Intelligence**        One                     Multi-signal
                          evidence_directional    intelligence plane +
                          strategy                market/event graph +
                                                  forecast ensemble

  **Money authority**     Deterministic risk +    Deterministic Money
                          isolated executor       Kernel + isolated
                                                  executor + narrow
                                                  Signer Vault

  **Wallet contract**     Wallet/signature        Current Deposit
                          compatibility checked   Wallet/wallet type 3 +
                                                  legacy support behind
                                                  tested wallet adapter

  **Execution model**     General CLOB adapter    CLOB V2/current unified
                                                  SDK contract, venue
                                                  modes, rate governor,
                                                  maker/taker economics

  **Fork approach**       Fork selected, selected Complete fork
                          paths mapped            disposition +
                                                  dependency amputation
                                                  for LIVE runtime

  **Validation**          53 requirement          96 traceable
                          scenarios               requirements + 96
                                                  primary acceptance
                                                  scenarios +
                                                  fault/property suites
  -----------------------------------------------------------------------

# P1. Product Thesis, Outcomes and Non-Goals

## P1.1 Desired outcomes

> • Operate continuously across market discovery, evidence acquisition,
> probability estimation, strategy selection, portfolio control, order
> lifecycle, exit and settlement without human market decisions.
>
> • Make every economic action reproducible from market snapshot,
> evidence, model/strategy version, policy version, risk decision, order
> state and ledger events.
>
> • Survive transient faults without double-ordering, phantom balance,
> stale-entry or manual babysitting; recover and resume automatically
> when deterministic readiness returns.
>
> • Develop a measurable edge, if one exists, by beating same-time
> market/economic baselines after fees, slippage, rebates, information
> latency and AI/data/infrastructure costs.
>
> • Keep LLM capability outside the financial trust boundary:
> intelligence proposes; the deterministic Money Kernel authorizes; the
> Signer Vault signs only typed permitted actions.

## P1.2 Explicit non-goals for first LIVE release

> • No promise of profit, win rate, guaranteed alpha, "AI accuracy" or
> autonomous capital growth without evidence.
>
> • No autonomous bridge/withdrawal/arbitrary transfer, leverage, naked
> shorting, token launch, unrelated DeFi, or cross-venue LIVE trading.
>
> • No production self-modifying code or self-promotion of an
> unqualified strategy. PolyRoot may autonomously create PAPER/SHADOW
> experiments, not bypass release qualification.
>
> • No geoblock/compliance bypass. Access restrictions are an external
> hard constraint, not an optimization problem.
>
> • No dependence on a human being online for normal trade approval,
> order management, exits, transient recovery or routine resumption.

# P2. Research Baseline and Corrections from v1.0

  -----------------------------------------------------------------------------------------
  Research finding          Why it matters          Product correction
  ------------------------- ----------------------- ---------------------------------------
  CLOB V2 is production     Old signing/SDK         VenueAdapter pins exact official
  reality; current examples assumptions can fail    SDK/runtime and contract-tests current
  use \@polymarket/client.  even when TypeScript    behavior. Business logic never calls
                            compiles.               SDK directly.

  Deposit Wallet is current Pinned Clodds manual    Wallet subsystem separates
  default account wallet;   signer explicitly does  signer/wallet/funder, supports current
  wallet type 3.            not implement           account model, L1/L2 creds and
                            POLY_1271/wallet type 3 relayer/builder lifecycle.
                            path.                   

  pUSD is the trading       Nominal USDC/USDC.e     Asset/approval registry distinguishes
  collateral.               balance is not          assets, allowance, spendable balance
                            automatically spendable and conversion boundary.
                            pUSD.                   

  Matching engine has 425,  A binary READY/DOWN     VenueMode is orthogonal to service
  post-only and cancel-only model can submit stale  health and changes allowed actions.
  modes.                    or invalid orders.      

  Rate limits may           An intent can age while Client-side rate governor, deadlines,
  delay/queue requests.     waiting and become      queue age and revalidation before
                            economically stale.     submit.

  Fees/rebates are          Gross edge can          Economics engine uses live fee
  category/market/program   disappear after         metadata, conservative rebates and
  dependent.                execution economics;    actual realized costs.
                            rebates may change.     

  Events/negative-risk      Correlation and         Native + inferred Market Graph feeds
  groups encode relations.  structural mispricing   both strategy and risk.
                            are both graph          
                            problems.               

  Clodds already has        Rewriting everything    Fork disposition:
  risk/Kelly/tools but      wastes useful concepts; keep/adapt/rewrite/remove/quarantine,
  broad trust surface.      reusing everything      plus production dependency amputation.
                            inherits dangerous      
                            assumptions.            

  Forecast literature is    LLM eloquence is not    Ensembles, proper scoring, calibration,
  mixed and                 evidence of edge.       same-time market benchmark and
  contamination-prone.                              prospective SHADOW are mandatory.
  -----------------------------------------------------------------------------------------

# P3. Autonomy Contract and Operational State Model

## P3.1 Meaning of "autonomous 24/7"

  -----------------------------------------------------------------------
  COMMISSION ONCE\
  Autonomy Charter + wallet + capital ceiling + qualified strategy set\
  \|\
  v\
  24/7 CLOSED LOOP\
  discover -\> research -\> forecast -\> arbitrate -\> size -\>
  authorize\
  -\> execute -\> monitor -\> update -\> exit/redeem -\> reconcile\
  \|\
  v\
  AUTO-RECOVER / AUTO-RESUME when deterministic readiness returns
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------

**Human-free market decision boundary.** The account must be
cryptographically set up and the owner must establish capital/signer
policy once, because the venue requires user authorization. After that,
the Signer Vault signs qualified orders automatically. This is not
per-trade permission. Entries, exits, cancellations and reallocations
are machine decisions.

## P3.2 Orthogonal states

  ------------------------------------------------------------------------
  Axis                    States                  Rule
  ----------------------- ----------------------- ------------------------
  **Operation mode**      PAPER / SHADOW / LIVE   Only LIVE can send
                                                  financial orders. Mode
                                                  is not health.

  **Runtime health**      STOPPED / BOOTSTRAPPING Transient faults can
                          / RECOVERING / ACTIVE / auto-recover; hard
                          DEGRADED /              policy/security/access
                          PROTECTIVE_PAUSE /      blockers do not
                          ACCESS_BLOCKED /        self-bypass.
                          EMERGENCY_HALT          

  **Venue mode**          NORMAL / POST_ONLY /    Controls which order
                          CANCEL_ONLY /           actions are currently
                          RESTARTING /            legal/accepted by the
                          UNAVAILABLE / UNKNOWN   venue.

  **Risk tier**           NORMAL / CAUTIOUS /     Automatically tightens
                          PROTECTIVE              sizing/universe/order
                                                  style without loosening
                                                  hard caps.
  ------------------------------------------------------------------------

# P4. Product Scope and User Experience

  -----------------------------------------------------------------------
  Area                                v1.1 decision
  ----------------------------------- -----------------------------------
  **Primary operator**                One owner/operator; no multi-tenant
                                      financial authority in first LIVE
                                      release.

  **Environment**                     Self-hosted Linux VPS; responsive
                                      web dashboard for Android/tablet;
                                      remote LLM providers; no local GPU
                                      required.

  **LIVE venue**                      Polymarket CLOB only. Adapter
                                      interface remains venue-agnostic
                                      for future research/PAPER.

  **Market universe**                 Markets with complete
                                      metadata/rules, supported
                                      wallet/collateral/order semantics
                                      and measurable execution. Native
                                      graph relations are preferred.

  **Core strategies**                 evidence_directional_v2 and
                                      market_graph_relative_value_v1.
                                      maker_liquidity_v1 and
                                      smart_money_consensus_v1 begin
                                      experimental/P1.

  **Autonomy**                        No per-trade approval. Owner can
                                      observe, pause/revoke or change
                                      governance, but absence of owner
                                      does not prevent routine operation.

  **Dashboard**                       Overview, autonomy/venue/risk
                                      state, market graph, research,
                                      forecast lineage, orders/positions,
                                      experiments, economics, incidents,
                                      audit and configuration.
  -----------------------------------------------------------------------

## P4.1 Autonomy-first UX rules

> • The dashboard is an observability and governance surface, not a
> required control loop. Closing the browser or losing the owner session
> must not stop qualified trading.
>
> • Every autonomous action exposes machine-readable reason codes,
> forecast/evidence lineage, policy version, risk decision, order state
> and current reconciliation status.
>
> • The top-level UI always shows operation mode, runtime health, venue
> mode, risk tier, active capital ceiling, current exposure, unknown
> obligations and the most severe blocker.
>
> • Pause/revoke controls are durable and idempotent. A UI timeout never
> authorizes a duplicate financial command, and cancel/flatten results
> are reported per order/position rather than as optimistic success.
>
> • Tablet/mobile layouts preserve asset units, freshness timestamps and
> safety state. Missing or stale values are never silently rendered as
> zero or available cash.

## P4.2 Human interaction boundary

**Humans govern the envelope; PolyRoot governs the market decisions
inside it.** The owner may observe at any time and may revoke autonomy,
change capital, change signer or promote a new release/strategy. None of
those actions is required for ordinary entries, exits, cancel/replace,
settlement, transient recovery or routine resumption.

# P5. Product Architecture

  ------------------------------------------------------------------------------------------------
  CONTROL / GOVERNANCE PLANE\
  owner auth \| Autonomy Charter \| release/strategy eligibility \| audit\
  \|\
  v\
  24/7 RUNTIME SUPERVISOR + EVENT BUS\
  \|\
  +\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+\
  v v\
  INTELLIGENCE PLANE MARKET/DATA PLANE\
  source registry market discovery\
  retrieval quarantine orderbook / user stream\
  catalyst monitor Event & Market Graph\
  forecast ensemble + calibration venue/fee/mode metadata\
  \| \|\
  +\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\-\--+\
  v\
  STRATEGY PLANE (sandboxed, qualified versions only)\
  directional \| graph-relative-value \| optional maker / smart-money\
  \| Proposal / TradeIntent\
  v\
  DETERMINISTIC MONEY KERNEL\
  eligibility \| economics \| position sizer \| portfolio/correlation risk\
  hard policy \| atomic reservation \| kill/protective tiers\
  \| ExecutionPermit\
  v\
  EXECUTION PLANE -\> VENUE ADAPTER -\> SIGNER VAULT -\> POLYMARKET CLOB\
  lifecycle \| cancel/replace \| rate governor \| heartbeat \| reconcile\
  \|\
  v\
  POSTGRESQL EVENT LEDGER + EXPERIMENT STORE + OBSERVABILITY + BACKUP
  ------------------------------------------------------------------------------------------------

  ------------------------------------------------------------------------------------------------

  -----------------------------------------------------------------------
  **Core authority invariant** AI may decide WHAT it wants to do; only
  deterministic code decides WHETHER and HOW MUCH is permitted; only the
  narrow signer boundary can authorize the resulting typed venue action.
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------

# P6. Intelligence and Strategy Portfolio

  -------------------------------------------------------------------------------------
  Layer                   Responsibilities                      LIVE authority
  ----------------------- ------------------------------------- -----------------------
  **Market Discovery**    Scan active universe, metadata        None
                          completeness, liquidity,              
                          closing/resolution windows, event     
                          relationships.                        

  **Market Intelligence** Book/depth/spread/velocity, fees,     None
                          activity, order flow, public wallet   
                          activity, reference prices.           

  **Evidence              Primary-source search, source         None
  Intelligence**          registry, counterevidence, catalysts, 
                          timestamps, provenance.               

  **Forecast Ensemble**   Independent probabilistic             None
                          forecasters, market baseline/prior,   
                          aggregation, calibration, abstention. 

  **Strategy Runtime**    Convert validated                     Proposal only
                          forecasts/graph/economics into        
                          desired exposure/TradeIntent.         

  **Money Kernel**        Eligibility, expected economics,      Authorization/veto
                          size, portfolio/correlation caps,     
                          reservations.                         

  **Executor + Signer**   Canonical order construction,         Financial effect
                          submit/cancel/reconcile/settlement.   
  -------------------------------------------------------------------------------------

# P7. Wallet, Venue and Current Polymarket Contract

> • Current integration baseline uses the official unified TypeScript
> client behind an adapter; observed package baseline is
> \@polymarket/client 0.9.0 and Node \>=24, but the exact deploy
> version/digest is frozen only at G0 after contract checks.
>
> • Deposit Wallet / wallet type 3 is the current default modern account
> model; PolyRoot must not rely on the pinned Clodds manual signer path
> that intentionally lacks this support.
>
> • Signer, account/deposit wallet and funder/collateral identity are
> distinct. L1 ownership signature, L2 CLOB API credentials and
> Relayer/Builder credentials have separate scopes/lifecycles.
>
> • pUSD is the trading collateral; USDC/USDC.e conversion is understood
> by the asset registry but funding/withdrawal is separate governance,
> not strategy autonomy.
>
> • Venue capabilities are dynamic: 425 restart, post-only/cancel-only,
> tick/min size, fee schedule, heartbeat and order/trade lifecycle must
> be probed/versioned and fail closed.

# P8. Initial Capital, Risk and Autonomy Policy

  -----------------------------------------------------------------------
  **Design defaults only** The following values are conservative
  engineering starting points, not investment advice and not claims of
  optimality. Capital cap and budget are explicitly configured during
  commissioning. Null never means "entire wallet" or unlimited spend.
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------

  ------------------------------------------------------------------------------------
  Parameter                  Initial value           Meaning
  -------------------------- ----------------------- ---------------------------------
  **execution.mode**         PAPER                   Fresh install; LIVE requires
                                                     gate + active Autonomy Charter.

  **capital.usd_cap**        null                    Owner commissioning value; hard
                                                     ceiling cannot be raised by
                                                     agent.

  **max_order_pct**          0.5%                    All-in worst-case capital debit
                                                     per order.

  **max_market_pct**         2%                      Position + orders +
                                                     reservations + unknown exposure
                                                     per market.

  **max_event_group_pct**    5%                      Native
                                                     event/negative-risk/correlation
                                                     cluster.

  **max_portfolio_pct**      10%                     Aggregate capital at risk; no
                                                     probabilistic offset assumed
                                                     initially.

  **daily_loss_stop_pct**    2%                      Latched; autonomous recovery only
                                                     if Charter explicitly defines
                                                     next-period reduced-risk reset.

  **drawdown_stop_pct**      5%                      Hard protective latch by default;
                                                     higher-risk recovery requires
                                                     prequalified policy.

  **max_open_orders**        10                      Includes unknown/cancel-unknown
                                                     obligations.

  **min_edge_after_cost**    0.03/share              Research threshold, not proven
                                                     alpha; strategy-specific gate may
                                                     override within safer direction.

  **book_max_age_ms**        2000                    Directional default;
                                                     market-making requires stricter
                                                     strategy-specific limits.

  **metadata_max_age_s**     60                      Revalidate fee/tick/status/mode
                                                     before submit.

  **forecast_max_age_s**     900                     Maximum; catalysts/rule/price
                                                     shock can invalidate earlier.

  **clock_skew_max_ms**      1000                    Signing/submit blocks when
                                                     exceeded.

  **max_slippage_abs**       0.01/share              Depth may imply a tighter limit.

  **intent_ttl_s**           30                      Queue/throttle age counts; stale
                                                     intent must be re-evaluated.

  **risk_permit_ttl_ms**     1000                    Policy/quote/lease/balance
                                                     rechecked before sign.

  **reconcile_interval_s**   15                      Healthy target;
                                                     startup/reconnect/unknown
                                                     triggers immediate.

  **financial_retention**    \>=365 days             Policy/order/fill/ledger/gate
                                                     audit.

  **backup RPO/RTO**         15m / 60m target        Measured by off-host restore
                                                     drill, not file existence.
  ------------------------------------------------------------------------------------

# P9. Functional Requirements --- 96 Traceable Contracts

**Requirement accounting.** 96 requirements: 86 P0 and 10 P1. P0
relevant to a gate must pass before promotion. Each ID maps one-to-one
to a primary acceptance scenario in the Technical Blueprint;
implementation can and should contain multiple tests per requirement.

## P9.1 Governance & autonomy charter

  ----------------------------------------------------------------------------
  ID / priority     Requirement        Contract              Gate
  ----------------- ------------------ --------------------- -----------------
  **PR-GOV-01\      Controlled fork    Pin the CloddsBot     G0-G1
  P0**              baseline           upstream commit,      
                                       exact                 
                                       lockfile/dependency   
                                       hashes, retained MIT  
                                       notices, PolyRoot     
                                       patches, SDK          
                                       versions, migrations  
                                       and schema_version in 
                                       a release manifest.   
                                       Every active upstream 
                                       financial path must   
                                       have an explicit      
                                       disposition.          

  **PR-GOV-02\      Polymarket-first   LIVE v1 is            G0-G7
  P0**              venue scope        Polymarket-only.      
                                       Other prediction      
                                       venues may exist      
                                       behind adapters for   
                                       research/PAPER, but   
                                       receive no signing    
                                       capability until      
                                       their own             
                                       requirements and      
                                       gates are approved.   

  **PR-GOV-03\      Persistent         One-time              G0-G7
  P0**              Autonomy Charter   commissioning creates 
                                       an immutable,         
                                       versioned Autonomy    
                                       Charter binding       
                                       wallet, qualified     
                                       strategies, market    
                                       classes, capital      
                                       ceiling, loss limits, 
                                       allowed actions,      
                                       expiration/review     
                                       policy and software   
                                       release. Routine      
                                       trades do not require 
                                       human approval.       

  **PR-GOV-04\      Zero per-trade     Human confirmation    G1-G7
  P0**              human approval     must never be a       
                                       normal dependency for 
                                       entry,                
                                       cancel/replace,       
                                       reduction, exit,      
                                       redeem, strategy      
                                       routing,              
                                       transient-fault       
                                       recovery or           
                                       resumption. Decisions 
                                       are machine-driven    
                                       within hard policy.   

  **PR-GOV-05\      Hard policy cannot No LLM, strategy,     G1-G3
  P0**              self-weaken        plugin, runtime tuner 
                                       or recovered process  
                                       can increase capital, 
                                       loosen loss/exposure  
                                       limits, extend        
                                       charter lifetime,     
                                       change signer, or     
                                       promote unqualified   
                                       code/strategy to      
                                       LIVE.                 

  **PR-GOV-06\      Access and         Recheck Polymarket    G0-G7
  P0**              compliance state   geographic/access     
                                       state before LIVE     
                                       activation and        
                                       periodically during   
                                       operation. BLOCKED    
                                       and CLOSE_ONLY are    
                                       first-class states.   
                                       PolyRoot must not     
                                       implement             
                                       location-bypass       
                                       behavior.             

  **PR-GOV-07\      Owner governance   Owner actions are     G0-G7
  P0**              is exceptional     limited to            
                                       commissioning,        
                                       capital/signer        
                                       changes,              
                                       strategy/release      
                                       promotion, emergency  
                                       stop/revocation,      
                                       funding/withdrawal    
                                       and                   
                                       compliance/security   
                                       recovery; all are     
                                       authenticated and     
                                       audited.              

  **PR-GOV-08\      Licensing and      Every strategy/data   G0-G3
  P1**              data-right         connector records     
                    registry           software license,     
                                       data usage/retention  
                                       rights and            
                                       redistribution        
                                       constraints before it 
                                       can enter a release   
                                       manifest.             
  ----------------------------------------------------------------------------

## P9.2 24/7 autonomy runtime

  -----------------------------------------------------------------------------
  ID / priority     Requirement       Contract                Gate
  ----------------- ----------------- ----------------------- -----------------
  **PR-AUT-01\      24/7 supervisor   A dedicated supervisor  G2-G7
  P0**                                runs continuously,      
                                      monitors critical       
                                      workers, restarts       
                                      failed non-financial    
                                      workers, and            
                                      coordinates safe        
                                      executor recovery       
                                      without requiring a     
                                      human to keep the       
                                      system alive.           

  **PR-AUT-02\      Closed autonomous The normal loop is      G2-G7
  P0**              loop              discover -\> qualify    
                                      -\> research -\>        
                                      forecast -\> strategy   
                                      arbitration -\> size    
                                      -\> authorize -\>       
                                      execute -\> monitor -\> 
                                      update -\> exit/redeem  
                                      -\> learn. Every step   
                                      can run without         
                                      interactive human       
                                      decisions.              

  **PR-AUT-03\      Autonomous        After transient venue,  G2-G7
  P0**              recovery and      stream, provider,       
                    resume            process or DB faults,   
                                      PolyRoot enters         
                                      RECOVERING/DEGRADED,    
                                      reconciles durable      
                                      state, and              
                                      automatically resumes   
                                      when deterministic      
                                      readiness conditions    
                                      pass.                   

  **PR-AUT-04\      Provider fallback Model/provider errors,  G1-G7
  P0**              without operator  quotas and latency      
                                      trigger bounded         
                                      fallback to             
                                      pre-qualified           
                                      provider/model routes;  
                                      lineage and cost remain 
                                      distinct. Financial     
                                      monitoring never        
                                      depends on LLM          
                                      availability.           

  **PR-AUT-05\      Qualified         PolyRoot may            G3-G7
  P0**              strategy          automatically select,   
                    arbitration       combine, suppress or    
                                      switch among strategies 
                                      whose exact versions    
                                      are already             
                                      LIVE-qualified,         
                                      according to immutable  
                                      routing rules and       
                                      conflict controls.      

  **PR-AUT-06\      Protective risk   Autonomy has NORMAL,    G2-G7
  P0**              tiers             CAUTIOUS and PROTECTIVE 
                                      tiers that              
                                      automatically reduce    
                                      sizing/universe/order   
                                      style after             
                                      uncertainty, drawdown,  
                                      degraded liquidity or   
                                      repeated faults. Hard   
                                      stops remain            
                                      non-bypassable.         

  **PR-AUT-07\      Bounded adaptive  The system may tune     G3-G7
  P0**              parameters        pre-approved strategy   
                                      parameters only inside  
                                      a versioned safe        
                                      envelope. Adaptation    
                                      cannot alter hard risk  
                                      policy, use final       
                                      holdout outcomes, or    
                                      silently rewrite past   
                                      experiments.            

  **PR-AUT-08\      Autonomous        PolyRoot may            G3-G7
  P1**              learning pipeline automatically generate  
                                      hypotheses,             
                                      PAPER/SHADOW            
                                      experiments and         
                                      evaluation reports, but 
                                      new executable code or  
                                      unqualified strategy    
                                      versions cannot         
                                      self-promote to LIVE.   
  -----------------------------------------------------------------------------

## P9.3 Wallet, credentials & signer

  ----------------------------------------------------------------------------------------------
  ID / priority     Requirement            Contract                            Gate
  ----------------- ---------------------- ----------------------------------- -----------------
  **PR-WAL-01\      Current official SDK   Prefer the current official unified G0-G1
  P0**              contract               TypeScript SDK behind a             
                                           VenueAdapter; pin exact             
                                           package/version and Node runtime at 
                                           G0. Contract tests, not package     
                                           names, define compatibility.        

  **PR-WAL-02\      Deposit Wallet and     Support current Deposit Wallet /    G0-G4
  P0**              legacy wallet support  wallet type 3 as the default modern 
                                           account model plus EOA, legacy      
                                           Proxy and Safe only when contract   
                                           tests prove compatibility.          

  **PR-WAL-03\      Signer-wallet-funder   Model signer address,               G0-G4
  P0**              identity               account/deposit wallet,             
                                           funder/collateral owner and wallet  
                                           type as separate verified           
                                           identifiers. Never infer them from  
                                           one address field.                  

  **PR-WAL-04\      Credential lifecycle   Track L1 authentication, CLOB L2    G1-G7
  P0**                                     API credentials and their           
                                           creation/derivation, scope,         
                                           rotation, revocation, health and    
                                           last verification without exposing  
                                           secrets to intelligence or logs.    

  **PR-WAL-05\      Relayer/builder        Relayer or Builder API credentials  G1-G4
  P0**              capability             used for wallet                     
                                           deployment/approvals are isolated   
                                           from ordinary order execution,      
                                           versioned, and never exposed to     
                                           LLMs.                               

  **PR-WAL-06\      Asset and approval     Treat pUSD, USDC/USDC.e and outcome G0-G7
  P0**              registry               tokens as distinct assets; track    
                                           chain, contract, decimals,          
                                           allowance/operator approvals,       
                                           balance freshness and spendability. 

  **PR-WAL-07\      Narrow Signer Vault    Private signing capability lives in G1-G4
  P0**                                     a minimal signer boundary that      
                                           accepts only typed, allowlisted     
                                           Polymarket operations bound to an   
                                           unexpired execution permit, policy  
                                           hash, chain/contract and amount     
                                           limits.                             

  **PR-WAL-08\      Funding and            Normal autonomy does not bridge,    G0-G7
  P1**              break-glass boundary   withdraw, transfer to arbitrary     
                                           destinations or increase funded     
                                           capital.                            
                                           Funding/withdrawal/key-compromise   
                                           evacuation is a separate            
                                           governance/break-glass workflow.    
  ----------------------------------------------------------------------------------------------

## P9.4 Market data & graph

  --------------------------------------------------------------------------------------------------------------------
  ID / priority     Requirement       Contract                                                       Gate
  ----------------- ----------------- -------------------------------------------------------------- -----------------
  **PR-DATA-01\     Canonical market  Persist event_id, market_id, condition_id, question_id when    G1-G7
  P0**              identity          available, token/outcome mapping, chain, collateral, tick,     
                                      min_size, status, negative-risk metadata and official          
                                      identifiers; titles/slugs are lookup aids, not keys.           

  **PR-DATA-02\     Versioned rules   Store resolution source, rules text/hash, deadlines and        G1-G7
  P0**              and               official clarifications with validity intervals. Material      
                    clarifications    changes invalidate affected forecasts/intents before submit.   

  **PR-DATA-03\     Orderbook and     Build market state from official snapshot/stream with          G1-G7
  P0**              user stream       source_at/received_at, reconnect/full resync and no invented   
                    integrity         sequence guarantees. User-order/trade stream is reconciled     
                                      against REST/chain.                                            

  **PR-DATA-04\     Venue capability  Continuously track fee schedule, tick/min size, order types,   G1-G7
  P0**              metadata          delay, orderbook eligibility and venue mode                    
                                      NORMAL/POST_ONLY/CANCEL_ONLY/RESTARTING/UNAVAILABLE/UNKNOWN.   

  **PR-DATA-05\     Native Event &    Build verified graph edges from Polymarket event grouping,     G1-G7
  P0**              Market Graph      negative-risk groups and platform metadata; preserve exact     
                                      native provenance.                                             

  **PR-DATA-06\     Inferred          Infer complementary, subset/superset, conditional, temporal,   G2-G7
  P0**              relationship      shared-resolution and correlation relations with               
                    graph             confidence/provenance. Inferred edges cannot be treated as     
                                      risk-free arbitrage without deterministic validation.          

  **PR-DATA-07\     Full universe     Log every discovered market considered by a strategy, its      G2-G7
  P0**              decision log      eligibility status and rejection reason, not only traded       
                                      markets. This is required to audit selection bias.             

  **PR-DATA-08\     Tiered research   Retain hot raw microstructure short-term, experiment-required  G3-G7
  P1**              retention         snapshots/features for the experiment lifetime, and long-lived 
                                      decision/evidence hashes sufficient for forensic replay        
                                      subject to data rights.                                        
  --------------------------------------------------------------------------------------------------------------------

## P9.5 Intelligence & forecasting

  ------------------------------------------------------------------------------------------
  ID / priority     Requirement       Contract                             Gate
  ----------------- ----------------- ------------------------------------ -----------------
  **PR-INT-01\      Structured        Every forecast is schema-validated   G1-G7
  P0**              probabilistic     with p_raw, p_calibrated,            
                    Forecast          p_conservative/actionable            
                                      distribution, evidence IDs,          
                                      counterevidence, assumptions,        
                                      invalidators, horizon, valid_until,  
                                      lineage and abstain reason.          

  **PR-INT-02\      Market as         Capture contemporaneous executable   G2-G7
  P0**              benchmark and     market probability/price as a        
                    prior signal      benchmark and optional prior         
                                      feature, never as an unquestioned    
                                      truth or future closing-price input. 

  **PR-INT-03\      Evidence          Research explicitly searches         G2-G7
  P0**              retrieval with    primary/authoritative evidence,      
                    counter-search    disconfirming evidence and scheduled 
                                      catalysts; source times and          
                                      retrieval cutoffs are enforced.      

  **PR-INT-04\      Source Registry   Classify source authority/family,    G2-G7
  P0**              and independence  syndication lineage, domain          
                                      expertise, historical                
                                      reliability/corrections when         
                                      measurable, publication latency and  
                                      rights. Multiple copies of one       
                                      article count as one source family.  

  **PR-INT-05\      Forecast ensemble Support multiple independently       G3-G7
  P0**                                versioned forecasters/components and 
                                      deterministic aggregation; preserve  
                                      component predictions and            
                                      contribution weights. No single      
                                      monolithic LLM response is the only  
                                      available forecast path.             

  **PR-INT-06\      Calibration by    Train and evaluate calibration by    G3-G7
  P0**              segment           model/provider, category, horizon    
                                      and relevant regime only on past     
                                      eligible labels; recalibrate         
                                      aggregates as needed. Verbal LLM     
                                      confidence is not a sizing signal.   

  **PR-INT-07\      Temporal          Every feature/evidence item has      G3-G7
  P0**              integrity and     available_at/source_cutoff;          
                    lineage           models/prompts/config/provider       
                                      response fingerprint where available 
                                      are versioned. Prospective           
                                      evaluation is required because       
                                      pretrained LLMs may know historical  
                                      outcomes.                            

  **PR-INT-08\      Budget-aware      Limit                                G2-G7
  P1**              abstention        token/cost/time/source/concurrency   
                                      budgets; budget exhaustion degrades  
                                      research or abstains without         
                                      affecting position monitoring,       
                                      cancellation, heartbeat or           
                                      reconciliation.                      
  ------------------------------------------------------------------------------------------

## P9.6 Strategy platform

  ------------------------------------------------------------------------------------------------------
  ID / priority     Requirement                      Contract                          Gate
  ----------------- -------------------------------- --------------------------------- -----------------
  **PR-STR-01\      Sandboxed strategy contract      Strategies receive sanitized      G2-G7
  P0**                                               immutable inputs and return       
                                                     Proposal/TradeIntent only. They   
                                                     run outside the signer/ledger     
                                                     trust boundary, have versioned    
                                                     manifests and cannot load         
                                                     arbitrary production secrets.     

  **PR-STR-02\      evidence_directional_v2          Initial fundamental strategy      G3-G7
  P0**                                               combines structured evidence,     
                                                     calibrated probability,           
                                                     executable depth and full costs;  
                                                     it trades only qualified binary   
                                                     markets and may abstain.          

  **PR-STR-03\      market_graph_relative_value_v1   Structural strategy compares      G3-G7
  P0**                                               verified related markets/event    
                                                     constraints and trades only when  
                                                     relation provenance, settlement   
                                                     logic and executable economics    
                                                     establish a robust inconsistency. 

  **PR-STR-04\      maker_liquidity_v1               Optional maker strategy may quote G4-G7
  P1**                                               only in markets with validated    
                                                     post-only/expiry/heartbeat        
                                                     behavior and must account for     
                                                     inventory, adverse selection and  
                                                     dynamic rebates.                  

  **PR-STR-05\      smart_money_consensus_v1         Optional public-wallet activity   G4-G7
  P1**                                               signal uses reproducible          
                                                     wallet-selection rules, realized  
                                                     history and anti-leakage filters; 
                                                     it is evidence, not blind copy    
                                                     trading.                          

  **PR-STR-06\      Multi-strategy arbiter           Deduplicate correlated intents,   G3-G7
  P0**                                               net desired exposure, enforce     
                                                     strategy budgets and prevent two  
                                                     strategies from unknowingly       
                                                     buying the same economic risk.    

  **PR-STR-07\      Exit and reallocation engine     Continuously compare HOLD vs      G3-G7
  P0**                                               EXIT/REDUCE vs REALLOCATE EV      
                                                     using current bid/depth,          
                                                     remaining payout, uncertainty,    
                                                     time-to-resolution, fees,         
                                                     liquidity and portfolio           
                                                     opportunity cost.                 

  **PR-STR-08\      Immutable experiment and         Strategy/model/prompt/parameter   G3-G7
  P0**              promotion                        versions and routing rules are    
                                                     immutable per experiment; changes 
                                                     create new IDs. LIVE eligibility  
                                                     is per exact version, not         
                                                     strategy name.                    
  ------------------------------------------------------------------------------------------------------

## P9.7 Money kernel & risk

  --------------------------------------------------------------------------------------------
  ID / priority     Requirement       Contract                               Gate
  ----------------- ----------------- -------------------------------------- -----------------
  **PR-RISK-01\     Hierarchical      Enforce all-in cap per order,          G1-G7
  P0**              exposure caps     token/market, native                   
                                      event/negative-risk group, inferred    
                                      correlation cluster, strategy and      
                                      portfolio; include positions, resting  
                                      orders, reservations and               
                                      unknown/pending obligations.           

  **PR-RISK-02\     Graph-aware       Use verified/inferred market relations G2-G7
  P0**              correlation risk  to prevent correlated outcomes from    
                                      masquerading as diversification;       
                                      unknown same-event relations receive   
                                      conservative grouping.                 

  **PR-RISK-03\     Atomic            Risk check, exact asset reservation,   G1-G7
  P0**              reservation and   ledger version, policy hash, quote ID  
                    permit            and short-lived execution permit are   
                                      written atomically. Unknown submission 
                                      retains reserved capacity.             

  **PR-RISK-04\     Robust position   PositionSizer derives a suggested size G3-G7
  P0**              sizing            from calibrated probability/payoff     
                                      uncertainty and may use capped         
                                      fractional Kelly only after empirical  
                                      validation; hard caps and liquidity    
                                      remain final. No win-streak boost or   
                                      verbal confidence sizing.              

  **PR-RISK-05\     Liquidity and     Validate executable VWAP/depth,        G1-G7
  P0**              price safety      spread, tick/min size, slippage and    
                                      quote age; round quantity down. If     
                                      minimum order exceeds safe cap,        
                                      abstain.                               

  **PR-RISK-06\     Autonomous        Daily loss/drawdown breaches latch and G2-G7
  P0**              loss/drawdown     trigger preconfigured protective       
                    protection        behavior. Auto-resume is allowed only  
                                      when the Charter defines deterministic 
                                      cooldown/reconciliation/reduced-risk   
                                      criteria; hard breach remains halted.  

  **PR-RISK-07\     Kill-switch and   PAUSE_ENTRIES, CANCEL_OPEN and         G1-G7
  P0**              reduction         FLATTEN/REDUCE are distinct. SELL uses 
                    semantics         only verified available shares; no     
                                      leverage, naked short or assumed       
                                      native reduce-only behavior.           

  **PR-RISK-08\     Unknown           SUBMISSION_UNKNOWN, CANCEL_UNKNOWN,    G1-G7
  P0**              obligations       delayed/matched pending settlement and 
                    consume risk      external/manual trades consume         
                                      capacity until reconciled; capacity is 
                                      never recreated by uncertainty.        
  --------------------------------------------------------------------------------------------

## P9.8 Execution & venue lifecycle

  ---------------------------------------------------------------------------------------
  ID / priority     Requirement       Contract                          Gate
  ----------------- ----------------- --------------------------------- -----------------
  **PR-EXE-01\      Single money path All financial entry points        G1-G7
  P0**                                produce a durable intent and pass 
                                      through Money Kernel -\> Executor 
                                      -\> Signer Vault. Chat, UI, cron, 
                                      tool, plugin and legacy direct    
                                      signers cannot bypass it.         

  **PR-EXE-02\      VenueAdapter      Official SDK/API behavior is      G0-G7
  P0**              capability        wrapped in a pinned adapter       
                    contract          exposing market data, signing,    
                                      submit, cancel, order lookup,     
                                      trades, balances, heartbeat,      
                                      settlement and venue-mode         
                                      capabilities with fail-closed     
                                      unsupported states.               

  **PR-EXE-03\      Idempotent intent Persist intent_id, dedupe_key,    G1-G7
  P0**              and pre-network   payload hash, permit, canonical   
                    durability        order request and signed/order    
                                      hash where available before       
                                      ambiguous network side effects.   

  **PR-EXE-04\      No blind          Timeout/network loss after a      G1-G7
  P0**              financial retry   request might have been accepted  
                                      becomes SUBMISSION_UNKNOWN;       
                                      lookup/reconciliation precede any 
                                      replacement. Transport retry is   
                                      allowed only when                 
                                      non-acceptance/idempotency is     
                                      proven.                           

  **PR-EXE-05\      Cancel, replace   Cancel result is per order;       G1-G7
  P0**              and late fill     refresh fills/trades before       
                                      replacement. Replacement only     
                                      covers remaining desired safe     
                                      quantity; late fills remain       
                                      economic events.                  

  **PR-EXE-06\      Lifecycle,        Keep raw venue order/trade states G1-G7
  P0**              heartbeat and     plus internal monotonic state;    
                    settlement        heartbeat/user stream health are  
                                      independent.                      
                                      Matched/mined/confirmed/failed,   
                                      dispute/resolution/redeem are     
                                      separate lifecycles.              

  **PR-EXE-07\      Rate governor and Client-side rate budgets,         G1-G7
  P0**              venue modes       deadlines and queue age protect   
                                      cancel/reconcile capacity. Handle 
                                      425 restart, post-only and        
                                      cancel-only modes by changing     
                                      order flow, not replaying stale   
                                      taker requests.                   

  **PR-EXE-08\      Execution         Execution records maker/taker     G4-G7
  P0**              economics and     classification, actual            
                    reality gap       fees/rebates,                     
                                      slippage/latency/fill quality and 
                                      compares PAPER predicted fills    
                                      against micro-LIVE to calibrate   
                                      simulator assumptions.            
  ---------------------------------------------------------------------------------------

## P9.9 Ledger & reconciliation

  ------------------------------------------------------------------------------------
  ID / priority     Requirement       Contract                       Gate
  ----------------- ----------------- ------------------------------ -----------------
  **PR-LED-01\      Append-only       Orders, reservations, fills,   G1-G7
  P0**              double-entry      fees, rebates, transfers       
                    event ledger      observed, settlement and       
                                      corrections produce            
                                      append-only events/postings    
                                      balanced per asset;            
                                      projections are rebuildable.   

  **PR-LED-02\      Exact numeric     Use integer base units for     G1-G7
  P0**              representation    on-chain assets and exact      
                                      decimal for                    
                                      prices/probabilities/derived   
                                      values. Never float uint256    
                                      token IDs or assume every      
                                      asset has the same decimals.   

  **PR-LED-03\      Projection        Wallet/position/order          G1-G7
  P0**              versioning        projections store projected    
                                      event sequence and can be      
                                      discarded/rebuilt; no UI/cache 
                                      becomes authoritative          
                                      financial state.               

  **PR-LED-04\      Continuous        Compare local open orders,     G1-G7
  P0**              reconciliation    trades, pending settlement,    
                                      positions, balances/allowances 
                                      and chain receipts at startup, 
                                      reconnect, unknown state and   
                                      healthy interval. Material     
                                      unexplained drift blocks       
                                      entry.                         

  **PR-LED-05\      External/manual   Manual/external                G2-G7
  P0**              activity          orders/transfers on the same   
                    classification    wallet are never silently      
                                      ignored; classify them as      
                                      EXTERNAL and incorporate their 
                                      economic/risk effects.         

  **PR-LED-06\      Net economic PnL  Separate trading PnL from net  G3-G7
  P0**                                economic PnL after fees,       
                                      slippage, maker/taker rebates, 
                                      LLM/data/infrastructure        
                                      allocations and cash flows.    
                                      Signals without fills have     
                                      zero realized trading PnL.     

  **PR-LED-07\      Corrections and   Venue corrections, failed      G2-G7
  P0**              reorgs            settlement or chain reorgs     
                                      append compensating/correction 
                                      events referencing prior       
                                      state; history is not mutated. 

  **PR-LED-08\      Audit export and  Export redacted                G3-G7
  P1**              retention         decision/ledger/experiment     
                                      data with provenance links;    
                                      financial/policy/gate history  
                                      minimum 365 days and           
                                      experiment artifacts retained  
                                      through reproducibility        
                                      horizon.                       
  ------------------------------------------------------------------------------------

## P9.10 Security boundaries

  ---------------------------------------------------------------------------------------------
  ID / priority     Requirement       Contract                                Gate
  ----------------- ----------------- --------------------------------------- -----------------
  **PR-SEC-01\      Untrusted         Web/news/social/document content is     G2-G7
  P0**              external content  data only; it cannot become system      
                                      instruction, invoke signer, alter       
                                      policy, run shell or access secrets.    
                                      Structured extraction boundaries are    
                                      mandatory.                              

  **PR-SEC-02\      Research          High-risk retrieval/parsing runs in a   G2-G7
  P0**              quarantine        low-privilege research boundary.        
                    boundary          Privileged forecasting/strategy         
                                      receives normalized evidence objects,   
                                      never raw executable content or trading 
                                      secrets.                                

  **PR-SEC-03\      SSRF and egress   Validate schemes/domains/IPs, block     G2-G7
  P0**              protection        localhost/private/link-local/metadata   
                                      ranges, revalidate redirects/DNS, cap   
                                      size/decompression/time and route       
                                      research traffic through controlled     
                                      egress.                                 

  **PR-SEC-04\      Secret isolation  Trading, L2, relayer/builder and        G1-G7
  P0**              and redaction     provider secrets live only in required  
                                      service scopes;                         
                                      logs/prompts/exports/backups are        
                                      redacted and secret-canary tested.      

  **PR-SEC-05\      Plugin/process    Strategy and connector plugins are      G2-G7
  P0**              sandbox           isolated from host shell, Docker        
                                      socket, raw DB, process env and signer; 
                                      capabilities are explicit and           
                                      least-privilege.                        

  **PR-SEC-06\      Dependency        LIVE runtime excludes unrelated         G0-G7
  P0**              amputation and    CloddsBot                               
                    supply chain      exchanges/DeFi/messaging/tools and      
                                      unnecessary install scripts; exact      
                                      dependencies, SBOM, provenance and      
                                      vulnerability/secret scans are release  
                                      inputs.                                 

  **PR-SEC-07\      Authenticated     Dashboard uses TLS, strong owner auth,  G2-G7
  P0**              product API       secure sessions, CSRF protection and    
                                      reauthentication for governance;        
                                      internal routes/DB/executor are not     
                                      internet-exposed.                       

  **PR-SEC-08\      Adversarial       Maintain prompt-injection, SSRF,        G2-G7
  P1**              verification      dependency, malformed-market, replay    
                                      and privilege-escalation red-team       
                                      fixtures in CI/gate reports.            
  ---------------------------------------------------------------------------------------------

## P9.11 Operations & reliability

  --------------------------------------------------------------------------------------------------------------------------------------
  ID / priority     Requirement       Contract                                                                         Gate
  ----------------- ----------------- -------------------------------------------------------------------------------- -----------------
  **PR-OPS-01\      Separated         Run reverse proxy, gateway/control, data/research, intelligence, strategy, money G2-G7
  P0**              deployment roles  kernel/executor, signer vault, PostgreSQL and backup/monitoring with private     
                                      networks and least-privilege roles.                                              

  **PR-OPS-02\      Continuous        24/7 supervisor, heartbeats and durable lease/fencing ensure at most one active  G2-G7
  P0**              watchdog and      executor authority per wallet; stale process loses capability before a successor 
                    leases            submits.                                                                         

  **PR-OPS-03\      Recovering        Every startup is RECOVERING until                                                G2-G7
  P0**              startup           release/clock/charter/credentials/ledger/orders/trades/balances/unknowns/venue   
                                      mode reconcile; old intents are not replayed blindly.                            

  **PR-OPS-04\      Off-host backup   Encrypted PostgreSQL base backup/WAL or equivalent off-host recovery,            G3-G7
  P0**              and PITR          config/manifest backup and tested restore meet declared RPO/RTO; restored        
                                      trading remains RECOVERING until venue reconciliation.                           

  **PR-OPS-05\      Observability and Metrics/alerts cover data age, venue mode, stream/heartbeat, queue/permit age,   G2-G7
  P0**              autonomous        unknowns, reconciliation, exposure, loss tiers, LLM cost, rate budgets, clock,   
                    incident response disk, backup/restore and strategy health.                                        

  **PR-OPS-06\      Resource and      Enforce CPU/memory/disk limits so research cannot starve execution; synchronize  G2-G7
  P0**              clock health      clock and block signing when skew/health exceeds policy. Capacity is benchmarked 
                                      on target VPS.                                                                   

  **PR-OPS-07\      Immutable release Build reproducible immutable image/manifest, test migration/rollback             G0-G7
  P0**              and rollback      compatibility, deploy PAPER canary first and never self-update the LIVE          
                                      binary/code.                                                                     

  **PR-OPS-08\      Cost and budget   Meter model, data, network/storage and infrastructure cost by                    G3-G7
  P1**              governance        experiment/strategy; autonomous budget routing may degrade research but cannot   
                                      silently spend unlimited budget.                                                 
  --------------------------------------------------------------------------------------------------------------------------------------

## P9.12 Validation & release gates

  ------------------------------------------------------------------------------------
  ID / priority     Requirement        Contract                      Gate
  ----------------- ------------------ ----------------------------- -----------------
  **PR-VAL-01\      Official contract  CI/gates combine              G0-G7
  P0**              checks             deterministic fixtures with   
                                       read-only/current official    
                                       API/SDK contract checks for   
                                       wallet, market metadata,      
                                       fees, modes, heartbeat,       
                                       order/trade schemas and error 
                                       taxonomy.                     

  **PR-VAL-02\      Property and       Property tests cover          G1-G7
  P0**              invariant tests    no-negative free balances,    
                                       exposure caps under           
                                       concurrency, exact replay,    
                                       reservation transitions,      
                                       idempotency, rounding and     
                                       monotonic lifecycle.          

  **PR-VAL-03\      Fault-injection    Inject timeout-before/after   G2-G7
  P0**              harness            accept,                       
                                       dropped/duplicate/reordered   
                                       events, cancel race, provider 
                                       outage, disk/DB failure,      
                                       clock skew, lease takeover,   
                                       425/post-only/cancel-only,    
                                       malformed responses and       
                                       restart at every durable      
                                       boundary.                     

  **PR-VAL-04\      Paper simulator    Paper engine models           G3-G7
  P0**              calibration        bid/ask/depth, fees/rebates,  
                                       latency, queue assumptions,   
                                       partial fills/cancel race and 
                                       reports uncertainty.          
                                       Micro-LIVE is used to         
                                       calibrate the execution       
                                       reality gap.                  

  **PR-VAL-05\      Prospective SHADOW Freeze exact versions and run G4-G7
  P0**              evaluation         time-forward SHADOW on        
                                       live-available evidence/data; 
                                       historical pretraining        
                                       contamination cannot          
                                       substitute for prospective    
                                       evidence.                     

  **PR-VAL-06\      Probabilistic      Report Brier, log loss,       G4-G7
  P0**              quality metrics    calibration/reliability,      
                                       sharpness/coverage,           
                                       abstention and same-timestamp 
                                       market baseline by            
                                       model/category/horizon;       
                                       ensemble components are       
                                       separately scored.            

  **PR-VAL-07\      Economic and       Report net PnL/edge after all G4-G7
  P0**              multiple-testing   costs, drawdown, fill ratio,  
                    discipline         turnover, capacity,           
                                       concentration and clustered   
                                       uncertainty. Register all     
                                       experiments/variants; no      
                                       cherry-picking or repeated    
                                       peeking to stop on luck.      

  **PR-VAL-08\      Staged autonomous  Gates progress from           G0-G7
  P0**              promotion          contract/fault/security to    
                                       PAPER, SHADOW, micro-LIVE and 
                                       24/7 autonomous-LIVE.         
                                       Engineering correctness       
                                       cannot replace economic       
                                       evidence; cap increases       
                                       remain governance changes,    
                                       not per-trade approvals.      
  ------------------------------------------------------------------------------------

# P10. Quality, Economic Evidence and Promotion Metrics

  -----------------------------------------------------------------------
  Dimension                           Required evidence
  ----------------------------------- -----------------------------------
  **Order integrity**                 Zero duplicate economic execution
                                      in the fault suite; zero unresolved
                                      unexplained financial drift;
                                      unknown/cancel failure always
                                      visible.

  **Autonomy reliability**            24/7 supervisor recovers transient
                                      failures; no ordinary market
                                      decision depends on an operator
                                      session; auto-resume only after
                                      deterministic readiness.

  **Forecast quality**                Brier, log loss,
                                      calibration/reliability,
                                      sharpness/coverage and abstention
                                      by category/horizon/model; compare
                                      same-timestamp market baseline.

  **Economic quality**                Net edge/PnL after actual fees,
                                      rebates, slippage, LLM/data/infra
                                      cost; drawdown, turnover, fill
                                      ratio, capacity, capital
                                      utilization and clustered
                                      confidence intervals.

  **Selection integrity**             Full universe eligibility/rejection
                                      log plus registry of every
                                      experiment/parameter/model variant,
                                      including failures and abandoned
                                      runs.

  **Execution reality**               Paper-vs-micro-LIVE
                                      fill/slippage/latency calibration
                                      and error bars; marketable/resting
                                      behavior evaluated separately.

  **Security**                        No critical/high exploitable path
                                      in active trust boundary;
                                      signer/secret/egress/plugin
                                      isolation and restore drills pass.

  **Reliability targets**             Initial design: authorization pause
                                      \<=1s; local risk p95 \<250ms; main
                                      dashboard p95 \<2s under declared
                                      load; service readiness target
                                      99.5%/30d. Measure before claiming.
  -----------------------------------------------------------------------

# P11. Release Gates and Autonomous-LIVE Roadmap

  ---------------------------------------------------------------------------------------------------------------
  Gate                                Evidence / decision
  ----------------------------------- ---------------------------------------------------------------------------
  **G0 --- Research & Source Freeze** Pin fork disposition, SDK/runtime, current API contracts, wallet type,
                                      asset/contract registry, access state, license/data rights, capital/budget
                                      governance. No real orders.

  **G1 --- Domain & Contract**        Canonical schemas, wallet/credential adapter, Money Kernel, signer
                                      boundary, ledger and VenueAdapter contract/property tests pass.

  **G2 --- Fault & Money Safety**     Idempotency/unknown/cancel/partial-fill/reconcile/fencing/rate/venue-mode
                                      fault suite passes with zero duplicate economic execution.

  **G3 --- Security & Recovery**      Prompt injection, SSRF, plugin isolation, dependency amputation, secret
                                      canary, backup/restore, clock/resource and rollback drills pass.

  **G4 --- PAPER**                    Paper engine and full autonomous loop run continuously; simulator
                                      uncertainty and full-universe logging are validated; no financial I/O.

  **G5 --- Prospective SHADOW**       Exact versions frozen; minimum administrative baseline \>=30 days and
                                      \>=100 resolved independent event clusters where feasible, plus
                                      preregistered stopping/CI rules. This minimum is not by itself statistical
                                      proof.

  **G6 --- micro-LIVE**               Small explicit capital cap; verify real
                                      wallet/signing/fill/settlement/rebate/recovery behavior and calibrate
                                      execution reality gap. No per-trade human approval.

  **G7 --- autonomous-LIVE 24/7**     Sustained clean micro-LIVE operations, no unresolved criticals/financial
                                      drift, prospective net-economic edge remains positive under preregistered
                                      uncertainty/sensitivity criteria, and recovery drills demonstrate
                                      unattended operation.
  ---------------------------------------------------------------------------------------------------------------

  -----------------------------------------------------------------------
  **Promotion rule** Engineering safety is necessary but cannot
  manufacture alpha. If economic evidence is inconclusive or negative,
  PolyRoot remains fully autonomous in PAPER/SHADOW or micro-LIVE at its
  current qualified cap rather than being promoted by optimism.
  -----------------------------------------------------------------------

  -----------------------------------------------------------------------

# P12. Delivery Plan and Definition of Done

  ----------------------------------------------------------------------------------
  Stage                       Deliverable                    Planning estimate\*
  --------------------------- ------------------------------ -----------------------
  **1 --- Fork reduction &    Complete fork disposition,     2--3 engineer-weeks
  contracts**                 dependency amputation, release 
                              manifest, SDK/wallet/asset     
                              probes, canonical schemas.     

  **2 --- Money path**        PG ledger, policy/charter,     5--7 engineer-weeks
                              reservations, Money Kernel,    
                              Signer Vault, VenueAdapter,    
                              lifecycle/reconcile/fencing.   

  **3 ---                     Market/Event Graph, source     4--6 engineer-weeks
  Data/graph/intelligence**   registry, retrieval            
                              quarantine, event bus,         
                              ensemble/calibration, cost     
                              lineage.                       

  **4 --- Strategy/product**  Directional v2, graph relative 3--5 engineer-weeks
                              value, strategy                
                              sandbox/arbiter, exit engine,  
                              dashboard.                     

  **5 --- Verification/ops**  Fault harness, security,       3--5 engineer-weeks
                              backup/restore, observability, 
                              deployment/rollback, paper     
                              calibration.                   

  **6 --- Prospective         SHADOW calendar, micro-LIVE,   \>=30 calendar days +
  qualification**             execution reality calibration  evidence-dependent
                              and economic gate.             
  ----------------------------------------------------------------------------------

**\***Planning estimate for one experienced engineer with review
support, not a delivery promise. API mismatch, security findings and
required prospective sample size can extend the calendar.

## P12.1 Definition of Done --- documents

> • PRD and Blueprint use the same 96 IDs, priorities, owners/gates and
> primary test IDs.
>
> • Every current Polymarket-specific claim is referenced and is
> explicitly revalidated at G0 before LIVE.
>
> • Every retained Clodds subsystem has a disposition; no direct legacy
> financial path is merely assumed disabled.
>
> • Autonomy semantics are unambiguous: zero per-trade human approval,
> auto recovery/resume for ordinary faults, hard governance for boundary
> changes.

## P12.2 Definition of Done --- implementation

> • Actual code, migration, manifests, contract/fault/security reports,
> restore drill, PAPER/SHADOW reports and release evidence exist for the
> applicable gate.
>
> • No critical requirement is considered satisfied merely because the
> service is green or a mock test passes.
>
> • Profitability/edge claims are made only from prospective
> net-economic evidence with uncertainty and documented exclusions.

# P13. Principal Risks and Design Responses

  -----------------------------------------------------------------------
  Risk                                Response
  ----------------------------------- -----------------------------------
  **No durable alpha / market already Market baseline, multi-signal
  efficient**                         research, ensembles, graph
                                      opportunities, full cost
                                      accounting, prospective gate;
                                      abstain/stop strategy when edge
                                      disappears.

  **LLM hallucination / source bias** Source registry, counter-search,
                                      structured evidence, independent
                                      components, calibration and market
                                      benchmark.

  **Prompt injection / SSRF**         Research quarantine, least
                                      privilege, deterministic output
                                      schemas, controlled egress, no
                                      signer/shell/secret in
                                      intelligence.

  **Duplicate/unknown order**         Pre-network durability,
                                      idempotency, reserved capacity,
                                      lookup/reconciliation, no blind
                                      retry.

  **Wallet/SDK/platform change**      Pinned adapter + read-only current
                                      contract tests + fail-closed
                                      capability probe.

  **24/7 process failure**            Supervisor, fencing, RECOVERING
                                      startup,
                                      auto-reconcile/auto-resume, fault
                                      harness.

  **Venue restricted mode/rate        VenueMode + rate governor +
  queue**                             deadline/TTL/revalidate + protected
                                      cancel capacity.

  **Backtest overfitting/leakage**    Full experiment registry, temporal
                                      cutoff, prospective SHADOW, proper
                                      scores and clustered uncertainty.

  **Secret compromise**               Narrow signer, secret
                                      isolation/canary, autonomous halt;
                                      key evacuation/rotation is
                                      break-glass governance.

  **Compliance/access change**        Periodic official access checks,
                                      CLOSE_ONLY/BLOCKED state, no bypass
                                      automation.
  -----------------------------------------------------------------------

# P14. Research Sources and Evidence Classification

**Evidence rule.** Official platform documentation and pinned source
code are treated as primary implementation evidence. Academic
peer-reviewed work informs evaluation methodology. 2026 preprints are
labeled emerging evidence and may inspire experiments but do not
establish production truth or guaranteed alpha.

  --------------------------------------------------------------------------------------------------------------------------------------------------------
  ID                      Source                  Use in this specification
  ----------------------- ----------------------- --------------------------------------------------------------------------------------------------------
  **S01**                 Original PRD v1.0       Polymarket_AI_Trader_PRD_v1.0.docx, baseline 8 Sep 2026. Retained: staged modes/gates, deterministic
                                                  risk, unknown-order discipline, ledger, prospective evaluation.

  **S02**                 Original Blueprint v1.0 Polymarket_AI_Trader_Blueprint_v1.0.docx, baseline 8 Sep 2026. Retained: isolated executor, PG financial
                                                  ledger, reservation/outbox, reconciliation, recovery/fault testing.

  **S03**                 CloddsBot pinned        alsk1992/CloddsBot commit 715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8; package 1.9.0, MIT, large
                          baseline                multi-venue/tool dependency surface.

  **S04**                 CloddsBot execution     src/execution/index.ts at pinned commit. Manual/direct signing and broad retry surface motivate
                                                  replacement of LIVE hot path.

  **S05**                 CloddsBot tool registry src/agents/tool-registry.ts at pinned commit. 630+ tool design spans trading, shell, SQL, Docker,
                                                  messaging and multiple venues; not suitable as LIVE intelligence capability set.

  **S06**                 CloddsBot risk engine   src/risk/engine.ts at pinned commit. Useful concepts: kill switch, circuit breaker, exposure, drawdown,
                                                  VaR, volatility, Kelly; authoritative PolyRoot integration is redesigned around durable reservations.

  **S07**                 CloddsBot dynamic Kelly src/trading/kelly.ts at pinned commit. Contains confidence/win-streak heuristics; PolyRoot does not use
                                                  verbal confidence or win-streak boosts as financial evidence.

  **S08**                 CloddsBot provider      src/providers/index.ts at pinned commit. Multi-provider/fallback/cost plumbing is reusable only behind
                          layer                   structured-output/capability/lineage controls.

  **S09**                 Polymarket Trading      https://docs.polymarket.com/trading/overview --- CLOB orders settle on Polygon in pUSD/outcome tokens;
                          Overview                account setup is one-time, then order workflow repeats.

  **S10**                 Polymarket Quickstart   https://docs.polymarket.com/trading/quickstart --- current examples use \@polymarket/client
                                                  createSecureClient and pUSD-denominated market orders.

  **S11**                 Polymarket Wallets &    https://docs.polymarket.com/trading/wallets-auth --- Deposit Wallet default for account wallets deployed
                          Authentication          on/after 4 May 2026; wallet type 3; L1/L2 credentials, relayer/builder and gasless wallet operations.

  **S12**                 Polymarket CLOB V2      https://docs.polymarket.com/v2-migration --- CLOB V2 live 28 Apr 2026; V1 signed orders/legacy V1 SDK no
                          Migration               longer production target; new contracts/backend/pUSD/fee behavior.

  **S13**                 Official TypeScript SDK https://github.com/Polymarket/ts-sdk --- current \@polymarket/client package observed as 0.9.0 on
                                                  research baseline, Node \>=24. Pin exact version/digest at implementation gate.

  **S14**                 Polymarket pUSD         https://docs.polymarket.com/concepts/pusd --- pUSD is ERC-20 collateral used for Polymarket trading; 6
                                                  decimals on Polygon, USDC-backed.

  **S15**                 Markets & Events        https://docs.polymarket.com/concepts/markets-events --- events group related markets; some multi-market
                                                  events are mutually exclusive negative-risk groups.

  **S16**                 Negative Risk Markets   https://docs.polymarket.com/concepts/negative-risk --- atomic No-to-other-Yes conversion semantics
                                                  support native graph constraints.

  **S17**                 Resolution              https://docs.polymarket.com/concepts/resolution --- UMA proposal/challenge/dispute lifecycle; dispute
                                                  can delay final resolution.

  **S18**                 Real-Time Data          https://docs.polymarket.com/market-data/realtime-data --- market/user/RTDS feeds; sports stream is
                                                  informational and explicitly not a basis for trading decisions.

  **S19**                 Matching Engine         https://docs.polymarket.com/trading/matching-engine --- HTTP 425 during restart; post-only period after
                          Restarts                restart; cancel-only/post-only require distinct order flow.

  **S20**                 Polymarket Error Codes  https://docs.polymarket.com/resources/error-codes --- current error taxonomy including 425 and
                                                  order/matching failures.

  **S21**                 Polymarket Fees         https://docs.polymarket.com/trading/fees --- category-dependent taker fee rates, maker fee 0 in
                                                  documented schedule, dynamic market fee metadata.

  **S22**                 Maker Rebates           https://docs.polymarket.com/programs/maker-rebates --- daily pUSD rebates based on executed maker
                                                  liquidity; program parameters can vary.

  **S23**                 Taker Rebates           https://docs.polymarket.com/programs/taker-rebates --- program live 28 May 2026, rolling weighted-volume
                                                  tiers and daily pUSD rebates; treat as dynamic policy.

  **S24**                 Rate Limits             https://docs.polymarket.com/api-reference/rate-limits --- Cloudflare throttling can delay/queue
                                                  requests; separate CLOB order/cancel rate limits.

  **S25**                 Geographic Restrictions https://docs.polymarket.com/api-reference/geoblock --- check access before placing orders;
                                                  blocked/close-only states must be obeyed, not bypassed.

  **S26**                 OWASP LLM Prompt        https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html ---
                          Injection Prevention    untrusted external content, least privilege and deterministic validation.

  **S27**                 OWASP SSRF Prevention   https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
                                                  --- URL/IP allow/deny validation, redirect/DNS/private-network defenses.

  **S28**                 PostgreSQL Serializable https://www.postgresql.org/docs/17/transaction-iso.html --- serializable transactions may abort; retry
                          Transactions            DB transaction, never blindly replay external financial side effects.

  **S29**                 PostgreSQL PITR         https://www.postgresql.org/docs/17/continuous-archiving.html --- base backup/WAL continuous archiving
                                                  supports point-in-time recovery; RPO/RTO require drills.

  **S30**                 Halawi et al., NeurIPS  Approaching Human-Level Forecasting with Language Models --- retrieval, forecasting and aggregation can
                          2024                    approach competitive human crowd performance; pipeline matters.

  **S31**                 Prophet Arena, ICLR     Live probabilistic multi-horizon benchmark uses market baseline, proper scores/calibration and return
                          2026                    metrics; supports modular/prospective evaluation.

  **S32**                 Beyond Accuracy: Can    OpenReview paper emphasizes forecasting accuracy is not the same as realized autonomous trading
                          LLM Forecasters Profit  profitability; historical expected-value estimates are not live fill PnL.
                          on Prediction Markets?  
                          2026                    

  **S33**                 LEAP, arXiv Sep 2026    Emerging preprint: explicit prior + per-evidence likelihood aggregation improves
                                                  auditability/calibration versus monolithic prediction in reported experiments. Treat as research input,
                                                  not established production truth.

  **S34**                 LLM Forecasting Agents  Survey highlights calibration under shift, contamination-resistant live evaluation, explicit
                          Survey, arXiv Aug 2026  cost/accuracy reporting and hybrid retrieval/statistical designs.

  **S35**                 Calibration-Induced     Case study shows expensive LLM features can contribute nothing after calibration; motivates
                          Degeneracy, arXiv Aug   calibration-viability checks and cheap baselines.
                          2026                    

  **S36**                 Gneiting & Raftery 2007 Strictly proper scoring rules support honest probabilistic evaluation; Brier/log loss used alongside
                                                  calibration.

  **S37**                 Hyndman &               Forecasting: Principles and Practice --- rolling-origin/time-series cross-validation preserves temporal
                          Athanasopoulos          order.

  **S38**                 Kapoor & Narayanan 2022 Leakage and reproducibility --- data leakage can materially inflate ML results; temporal/source cutoffs
                                                  are mandatory.

  **S39**                 Bailey et al.           The Probability of Backtest Overfitting --- searching many variants produces selection bias; register
                                                  all trials and protect holdout/prospective evaluation.

  **S40**                 Forecast combination    Forecast combinations often improve robustness, but aggregation can disturb calibration; component and
                          literature              aggregate forecasts require separate evaluation/recalibration.
  --------------------------------------------------------------------------------------------------------------------------------------------------------
