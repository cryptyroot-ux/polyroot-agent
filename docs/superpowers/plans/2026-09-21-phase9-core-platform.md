# Phase 9: Core Platform (Data, Intelligence, AI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Phase 9 Core Platform — Market/Event Graph, Source Registry with Persistence, Catalyst Bus with Durable Outbox, Forecast Ensemble & Calibration, Strategy Sandbox & Arbiter, and Strategy Implementations (evidence_directional_v2, market_graph_relative_value_v1, Exit Engine, Experiment Registry).

**Architecture:** 
- **Data Plane**: PostgreSQL-backed Market/Event Graph (native + inferred edges), Catalyst Bus with durable outbox/watermark
- **Intelligence Plane**: Persistent Source Registry, Forecast Ensemble with segmented Calibration, Research Quota with cost tracking
- **Strategy Plane**: Sandboxed strategy runner (process isolation), Arbiter for deduplication/netting, Exit/Reallocation Engine, Experiment Registry

**Tech Stack:** TypeScript, PostgreSQL, worker_threads for strategy sandbox, Zod for validation

## Global Constraints

- All financial amounts in integer base units (bigint); no float arithmetic
- Every persisted/exchanged object carries `schema_version`; unknown fields never expand capabilities
- Strategy sandbox: no network, no filesystem, no shell, no DB access, no LLM access, no secrets
- Catalyst Bus: durable outbox + consumer watermark; replay never re-executes
- Calibration: segmented by model/provider/category/horizon/regime only when sample suffices
- Research quota: tokens/cost/time/source/concurrency; exhaustion degrades research, not financial safety

---

### Task 1: Market/Event Graph — PostgreSQL Schema & Core Types

**Files:**
- Create: `migrations/0015_market_event_graph.sql`
- Create: `src/pm/data/src/graph.ts`
- Create: `tests/pm/contracts/graph.test.ts`

**Interfaces:**
- Consumes: `GraphEdge` from domain, `MarketSnapshot` for native edges
- Produces: `GraphEdgeStore` interface + `PgGraphEdgeStore` implementation, `GraphBuilder` for native/inferred edges

- [ ] **Step 1: Write failing test for native edge creation**

```typescript
// tests/pm/contracts/graph.test.ts
it("creates NATIVE_NEG_RISK edges from Polymarket event grouping", async () => {
  const store = createPgGraphEdgeStore(pgConfig);
  const builder = new GraphBuilder(store);
  
  const markets = [
    { market_id: "mkt_A", event_id: "evt_1", condition_id: "cond_1", question: "Will X happen?", outcome: "YES", is_neg_risk: true },
    { market_id: "mkt_B", event_id: "evt_1", condition_id: "cond_1", question: "Will X not happen?", outcome: "NO", is_neg_risk: true },
  ];
  
  await builder.buildNativeEdges(markets);
  
  const edges = await store.getEdgesByMarket("mkt_A");
  const negRisk = edges.find(e => e.relation_type === "NATIVE_NEG_RISK");
  assert.ok(negRisk);
  assert.equal(negRisk.trust_level, "VERIFIED_PLATFORM");
  assert.equal(negRisk.to_market_id, "mkt_B");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/pm/contracts/graph.test.ts`
Expected: FAIL - table/function not exist

- [ ] **Step 3: Create migration for graph_edges table**

```sql
-- migrations/0015_market_event_graph.sql
CREATE TABLE IF NOT EXISTS graph_edges (
  from_market_id TEXT NOT NULL,
  to_market_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN (
    'NATIVE_NEG_RISK','NATIVE_EVENT_MEMBER','COMPLEMENT','MUTUALLY_EXCLUSIVE',
    'SUBSET','SUPERSET','CONDITIONAL','TEMPORAL_DEPENDENCY',
    'SHARED_RESOLUTION_SOURCE','CORRELATED'
  )),
  trust_level TEXT NOT NULL CHECK (trust_level IN ('VERIFIED_PLATFORM','VERIFIED_RULES','INFERRED')),
  confidence NUMERIC(5,4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  provenance TEXT NOT NULL,
  graph_version TEXT NOT NULL DEFAULT 'v0',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_market_id, to_market_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges (to_market_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_provenance ON graph_edges (provenance);
```

- [ ] **Step 4: Implement GraphEdgeStore + PgGraphEdgeStore + GraphBuilder**

```typescript
// src/pm/data/src/graph.ts
export interface GraphEdgeStore {
  upsert(edge: GraphEdge): Promise<void>;
  getEdgesByMarket(marketId: string): Promise<GraphEdge[]>;
  getEdgesByType(relationType: GraphEdge['relation_type']): Promise<GraphEdge[]>;
  deleteMarketEdges(marketId: string): Promise<void>;
}

export class PgGraphEdgeStore implements GraphEdgeStore {
  constructor(private pool: Pool) {}
  // ... implement all methods with proper SQL
}

export class GraphBuilder {
  constructor(private store: GraphEdgeStore) {}
  
  async buildNativeEdges(markets: MarketSnapshot[]): Promise<void> {
    // Group by event_id + condition_id for NATIVE_NEG_RISK
    // Group by event_id for NATIVE_EVENT_MEMBER
    // Use negative-risk metadata from Polymarket API
  }
  
  async inferEdges(markets: MarketSnapshot[]): Promise<GraphEdge[]> {
    // COMPLEMENT: sum of outcome probabilities ≈ 1
    // MUTUALLY_EXCLUSIVE: same event, different outcomes
    // CONDITIONAL: temporal dependencies
    // CORRELATED: statistical correlation > threshold
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- tests/pm/contracts/graph.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add migrations/0015_market_event_graph.sql src/pm/data/src/graph.ts tests/pm/contracts/graph.test.ts
git commit -m "feat(data): Market/Event Graph with native edges"
```

---

### Task 2: Source Registry — PostgreSQL Persistence

**Files:**
- Modify: `src/pm/intelligence/src/index.ts` (add PgSourceRegistry)
- Create: `tests/pm/contracts/source-registry-pg.test.ts`

**Interfaces:**
- Consumes: `SourceRecord` from domain
- Produces: `PgSourceRegistry` implementing persistent `SourceRegistry` interface

- [ ] **Step 1: Write failing test for persistent source registry**

```typescript
// tests/pm/contracts/source-registry-pg.test.ts
it("persists sources across restarts", async () => {
  const reg1 = new PgSourceRegistry(pgConfig);
  await reg1.register({ ...sourceRecord, url: "https://new.example.com" });
  
  const reg2 = new PgSourceRegistry(pgConfig); // New instance
  const families = reg2.independentFamilies(["https://new.example.com"]);
  assert.equal(families.size, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/pm/contracts/source-registry-pg.test.ts`
Expected: FAIL

- [ ] **Step 3: Add migration + PgSourceRegistry**

```sql
-- Add to existing migration or new one
CREATE TABLE IF NOT EXISTS source_records (
  source_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url TEXT NOT NULL,
  epistemic_class TEXT NOT NULL CHECK (epistemic_class IN ('PRIMARY','SECONDARY','AGGREGATOR','UNKNOWN')),
  domain TEXT NOT NULL,
  source_class TEXT NOT NULL CHECK (source_class IN ('FUNDAMENTAL','MARKET','PARTICIPANT','STRUCTURAL','ALTERNATIVE','CROSS_MARKET')),
  reliability_score NUMERIC(5,4) NOT NULL CHECK (reliability_score >= 0 AND reliability_score <= 1),
  reliability_sample_count INTEGER NOT NULL DEFAULT 0,
  reliability_window TEXT NOT NULL DEFAULT '90d',
  correction_history JSONB NOT NULL DEFAULT '[]',
  syndication_parent TEXT,
  latency_sec NUMERIC(10,3),
  specialization TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (url)
);
```

- [ ] **Step 4: Implement PgSourceRegistry**

```typescript
// In intelligence/index.ts or new file
export class PgSourceRegistry {
  constructor(private pool: Pool) {}
  
  async register(record: SourceRecord): Promise<string> {
    const family = await this.resolveFamily(record);
    await this.pool.query(
      `INSERT INTO source_records (...) VALUES (...) ON CONFLICT (url) DO UPDATE SET ...`,
      [record.url, record.epistemic_class, ...]
    );
    return family;
  }
  
  async independentFamilies(urls: string[]): Promise<Set<string>> { ... }
  // ... implement all methods with SQL
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- tests/pm/contracts/source-registry-pg.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add migrations/... src/pm/intelligence/src/index.ts tests/pm/contracts/source-registry-pg.test.ts
git commit -m "feat(intelligence): PostgreSQL-backed Source Registry"
```

---

### Task 3: Catalyst Bus — Durable Outbox + Watermark (PostgreSQL)

**Files:**
- Modify: `src/pm/intelligence/src/index.ts` (add PgCatalystBus)
- Create: `tests/pm/contracts/catalyst-bus-pg.test.ts`

**Interfaces:**
- Consumes: `CatalystEvent` from domain, `PgPool`
- Produces: `PgCatalystBus` with durable outbox + consumer watermark

- [ ] **Step 1: Write failing test for durable outbox**

```typescript
// tests/pm/contracts/catalyst-bus-pg.test.ts
it("persists events across restarts; watermark prevents re-execution", async () => {
  const bus1 = new PgCatalystBus(pgConfig);
  await bus1.enqueue({ ...catalystEvent, event_id: "evt_persist" });
  
  // Simulate restart - new instance
  const bus2 = new PgCatalystBus(pgConfig);
  const replayed = bus2.replay("consumer_1", "evt_persist");
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].event_id, "evt_persist");
  
  // Watermark prevents re-execution
  assert.equal(bus2.replay("consumer_1", "evt_persist").length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/pm/contracts/catalyst-bus-pg.test.ts`
Expected: FAIL

- [ ] **Step 3: Add migration for catalyst tables**

```sql
CREATE TABLE IF NOT EXISTS catalyst_outbox (
  event_id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  event_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalyst_watermarks (
  consumer TEXT PRIMARY KEY,
  last_event_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_catalyst_outbox_dedupe ON catalyst_outbox (dedupe_key);
```

- [ ] **Step 4: Implement PgCatalystBus**

```typescript
export class PgCatalystBus {
  constructor(private pool: Pool) {}
  
  async enqueue(event: CatalystEvent): Promise<DurableOutboxResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Insert with dedupe_key unique constraint
      await client.query(
        `INSERT INTO catalyst_outbox (...) VALUES (...) ON CONFLICT (dedupe_key) DO NOTHING`,
        [event.event_id, event.category, event.subject, event.payload_version, event.event_at, event.received_at, event.dedupe_key, JSON.stringify(event)]
      );
      await client.query("COMMIT");
      return { ok: true, event };
    } catch { await client.query("ROLLBACK"); throw err; }
    finally { client.release(); }
  }
  
  replay(consumer: string, fromEventId: string): CatalystEvent[] { ... }
  advanceWatermark(consumer: string, eventId: string): Promise<void> { ... }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- tests/pm/contracts/catalyst-bus-pg.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add migrations/... src/pm/intelligence/src/index.ts tests/pm/contracts/catalyst-bus-pg.test.ts
git commit -m "feat(intelligence): PostgreSQL-backed Catalyst Bus with durable outbox"
```

---

### Task 4: Forecast Ensemble — Persistent Calibration Service

**Files:**
- Create: `src/pm/intelligence/src/calibration.ts`
- Create: `src/pm/intelligence/src/ensemble-pg.ts`
- Create: `tests/pm/contracts/ensemble-calibration.test.ts`

**Interfaces:**
- Consumes: `Forecast`, `ForecastComponent`, calibration labels
- Produces: `CalibrationService`, `PgEnsembleStore`

- [ ] **Step 1: Write failing test for calibration**

```typescript
// tests/pm/contracts/ensemble-calibration.test.ts
it("calibrates by model/category/horizon; recalibrates aggregates", async () => {
  const cal = new PgCalibrationService(pgConfig);
  
  // Train with historical data
  await cal.train({
    model: "gpt-4",
    category: "politics",
    horizon_sec: 3600,
    predictions: [0.8, 0.7, 0.6],
    outcomes: [1, 1, 0], // binary outcomes
  });
  
  // Calibrate new forecast
  const calibrated = await cal.calibrate({ p_raw: 0.85, model: "gpt-4", category: "politics", horizon_sec: 3600 });
  assert.ok(calibrated.p_calibrated < calibrated.p_raw); // calibration pulls toward true frequency
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/pm/contracts/ensemble-calibration.test.ts`
Expected: FAIL

- [ ] **Step 3: Add migration for calibration tables**

```sql
CREATE TABLE IF NOT EXISTS calibration_models (
  model_provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  category TEXT NOT NULL,
  horizon_sec INTEGER NOT NULL,
  regime TEXT,
  isotonic_map JSONB NOT NULL, -- or spline coefficients
  sample_count INTEGER NOT NULL,
  last_trained TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (model_provider, model_name, category, horizon_sec, regime)
);

CREATE TABLE IF NOT EXISTS ensemble_versions (
  version TEXT PRIMARY KEY,
  event_class TEXT NOT NULL,
  weight_book JSONB NOT NULL, -- familyId -> weight
  components JSONB NOT NULL,  -- list of {p_yes, familyId, weight}
  p_yes NUMERIC(5,4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 4: Implement CalibrationService + PgEnsembleStore**

```typescript
export class PgCalibrationService {
  constructor(private pool: Pool) {}
  
  async train(input: { model: string; category: string; horizon_sec: number; predictions: number[]; outcomes: number[] }): Promise<void> {
    // Fit isotonic regression or Platt scaling per segment
    // Store calibration map
  }
  
  async calibrate(input: { p_raw: number; model: string; category: string; horizon_sec: number }): Promise<{ p_calibrated: number }> {
    // Look up calibration map, apply
  }
}

export class PgEnsembleStore {
  constructor(private pool: Pool) {}
  
  async saveEnsemble(version: string, eventClass: string, components: ForecastComponent[], weightBook: Map<string, number>, p_yes: number): Promise<void> { ... }
  async getEnsemble(version: string): Promise<EnsembleOutcome | null> { ... }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- tests/pm/contracts/ensemble-calibration.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add migrations/... src/pm/intelligence/src/calibration.ts src/pm/intelligence/src/ensemble-pg.ts tests/pm/contracts/ensemble-calibration.test.ts
git commit -m "feat(intelligence): Forecast Ensemble with Persistent Calibration"
```

---

### Task 5: Research Quota — PostgreSQL Cost Tracking

**Files:**
- Modify: `src/pm/intelligence/src/index.ts` (add PgResearchBudget)
- Create: `tests/pm/contracts/research-budget-pg.test.ts`

**Interfaces:**
- Consumes: `ResearchQuota`, API call metadata
- Produces: `PgResearchBudget` with persistent cost/token tracking

- [ ] **Step 1: Write failing test for persistent budget**

```typescript
// tests/pm/contracts/research-budget-pg.test.ts
it("tracks cost across restarts; exhaustion blocks new research", async () => {
  const budget1 = new PgResearchBudget(pgConfig, quota);
  budget1.charge(500, 0.001);
  
  const budget2 = new PgResearchBudget(pgConfig, quota); // New instance
  const check = budget2.check(600);
  assert.equal(check.ok, false); // 500+600 > 1000 quota
  assert.equal(check.code, "BUDGET_EXHAUSTED");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/pm/contracts/research-budget-pg.test.ts`
Expected: FAIL

- [ ] **Step 3: Add migration for research_budget table**

```sql
CREATE TABLE IF NOT EXISTS research_budget (
  quota_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tokens_used BIGINT NOT NULL DEFAULT 0,
  cost_used_usd_micro BIGINT NOT NULL DEFAULT 0,
  last_reset TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 4: Implement PgResearchBudget**

```typescript
export class PgResearchBudget {
  constructor(private pool: Pool, private quota: ResearchQuota) {}
  
  async charge(tokens: number, costUsdFrac: number): Promise<void> {
    await this.pool.query(
      `UPDATE research_budget SET tokens_used = tokens_used + $1, cost_used_usd_micro = cost_used_usd_micro + $2`,
      [tokens, Math.round(costUsdFrac * 1e6)]
    );
  }
  
  async check(tokensNeeded: number): Promise<QuotaCheck> {
    const result = await this.pool.query(`SELECT tokens_used, cost_used_usd_micro FROM research_budget LIMIT 1`);
    const used = result.rows[0] || { tokens_used: 0, cost_used_usd_micro: 0 };
    // ... implement quota check
  }
  
  async reset(): Promise<void> {
    await this.pool.query(`UPDATE research_budget SET tokens_used = 0, cost_used_usd_micro = 0, last_reset = now()`);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- tests/pm/contracts/research-budget-pg.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add migrations/... src/pm/intelligence/src/index.ts tests/pm/contracts/research-budget-pg.test.ts
git commit -m "feat(intelligence): PostgreSQL-backed Research Budget with cost tracking"
```

---

### Task 5: Strategy Sandbox — Process Isolation (worker_threads)

**Files:**
- Create: `src/pm/strategy/src/sandbox.ts`
- Create: `src/pm/strategy/src/sandbox-rpc.ts`
- Create: `tests/pm/contracts/strategy-sandbox.test.ts`

**Interfaces:**
- Consumes: Strategy function (serialized), validated inputs (Forecast, MarketSnapshot, GraphEdge[])
- Produces: `StrategySandbox` + `StrategySandboxClient` (RPC over worker_threads)

- [ ] **Step 1: Write failing test for sandbox isolation**

```typescript
// tests/pm/contracts/strategy-sandbox.test.ts
it("strategy runs in isolated worker; no network/DB/shell access", async () => {
  const { client, worker } = await spawnStrategyWorker({
    strategyCode: `export function run(input) { return { intent: { side: "BUY", size: 10 } }; }`,
  });
  
  const result = await client.run({ forecast: { p_conservative: 0.6 }, market: { market_id: "mkt_1" } });
  assert.ok(result.intent.side === "BUY");
  
  // Verify isolation
  const globals = await client.evalInWorker("globalThis");
  assert.ok(!globals.fetch);
  assert.ok(!globals.require);
  assert.ok(!globals.process);
  
  await worker.terminate();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/pm/contracts/strategy-sandbox.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement Strategy Sandbox**

```typescript
// src/pm/strategy/src/sandbox-worker.ts
import { parentPort } from "worker_threads";

parentPort?.on("message", async (msg: { id: number; code: string; input: any }) => {
  try {
    // Create isolated context - no access to parent globals
    const strategyFn = new Function("input", msg.code) as (input: any) => any;
    const result = await strategyFn(msg.input);
    parentPort?.postMessage({ id: msg.id, result });
  } catch (err) {
    parentPort?.postMessage({ id: msg.id, error: err.message });
  }
});
```

```typescript
// src/pm/strategy/src/sandbox-rpc.ts
import { Worker } from "worker_threads";
import { resolve } from "path";

export interface StrategySandboxClient {
  run(input: any): Promise<any>;
  evalInWorker(code: string): Promise<any>;
  terminate(): Promise<void>;
}

export async function spawnStrategyWorker(opts: { strategyCode: string }): Promise<{ client: StrategySandboxClient; worker: Worker }> {
  const worker = new Worker(resolve(__dirname, "./sandbox-worker.js"), {
    workerData: { strategyCode: opts.strategyCode },
  });
  // ... RPC implementation with message IDs
  return { client, worker };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/pm/contracts/strategy-sandbox.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pm/strategy/src/sandbox.ts src/pm/strategy/src/sandbox-rpc.ts tests/pm/contracts/strategy-sandbox.test.ts
git commit -m "feat(strategy): Process-isolated Strategy Sandbox via worker_threads"
```

---

### Task 6: Strategy Arbiter — Deduplication + Netting

**Files:**
- Create: `src/pm/strategy/src/arbiter.ts`
- Create: `tests/pm/contracts/strategy-arbiter.test.ts`

**Interfaces:**
- Consumes: Array of `StrategyProposal` from multiple strategies
- Produces: Bounded `TradeIntent[]` after deduplication/netting

- [ ] **Step 1: Write failing test for arbiter**

```typescript
// tests/pm/contracts/strategy-arbiter.test.ts
it("deduplicates correlated intents via Market Graph", async () => {
  const arbiter = new StrategyArbiter({ graphStore, policy });
  
  const proposals = [
    { strategy: "evidence_directional_v2", market_id: "mkt_A", side: "BUY", desired_qty: 100 },
    { strategy: "market_graph_relative_value_v1", market_id: "mkt_B", side: "SELL", desired_qty: 50 }, // NEG_RISK with mkt_A
  ];
  
  const intents = await arbiter.arbitrate(proposals);
  // Should net exposure: BUY 100 on mkt_A + SELL 50 on mkt_B (neg_risk pair) = net BUY 50
  assert.equal(intents.length, 1);
  assert.equal(intents[0].side, "BUY");
  assert.equal(intents[0].desired_qty, 50);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/pm/contracts/strategy-arbiter.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement StrategyArbiter**

```typescript
export class StrategyArbiter {
  constructor(private graphStore: GraphEdgeStore, private policy: RiskPolicy) {}
  
  async arbitrate(proposals: StrategyProposal[]): Promise<TradeIntent[]> {
    // 1. Filter expired/stale/invalid
    // 2. Normalize to economic exposure
    // 3. Deduplicate via Market Graph:
    //    - NEG_RISK: net opposite sides
    //    - COMPLEMENT: sum exposures
    //    - CORRELATED: apply correlation discount
    // 4. Apply strategy budgets
    // 5. Emit bounded TradeIntent[]
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/pm/contracts/strategy-arbiter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pm/strategy/src/arbiter.ts tests/pm/contracts/strategy-arbiter.test.ts
git commit -m "feat(strategy): Strategy Arbiter with Market Graph deduplication"
```

---

### Task 7: Strategy Implementations — evidence_directional_v2 + market_graph_relative_value_v1

**Files:**
- Create: `src/pm/strategy/src/evidence-directional-v2.ts`
- Create: `src/pm/strategy/src/market-graph-relative-value-v1.ts`
- Create: `tests/pm/contracts/strategies-core.test.ts`

**Interfaces:**
- Consumes: `Forecast`, `MarketSnapshot`, `GraphEdge[]`, `MarketFeeSettings`, economic params
- Produces: `StrategyProposal` / `TradeIntent`

- [ ] **Step 1: Write failing test for evidence_directional_v2**

```typescript
// tests/pm/contracts/strategies-core.test.ts
it("evidence_directional_v2 produces NO_TRADE when conservative edge < minEdge", async () => {
  const strategy = new EvidenceDirectionalV2({ minEdgeAfterCost: 0.03 });
  
  const result = await strategy.run({
    forecast: { p_conservative: 0.52, p_calibrated: 0.55, evidence_ids: ["e1"] },
    book: { yes_price: 0.48, no_price: 0.52 },
    fees: { taker_bps: 200 },
  });
  
  assert.equal(result.no_trade_code, "MIN_EDGE_UNMET");
});
```

- [ ] **Step 2: Implement evidence_directional_v2**

```typescript
export class EvidenceDirectionalV2 {
  constructor(private config: { minEdgeAfterCost: number }) {}
  
  async run(input: { forecast: Forecast; book: { yes_price: number; no_price: number }; fees: { taker_bps: number } }): Promise<StrategyProposal | null> {
    // 1. Validate forecast has required fields
    // 2. Compute edge vs book after conservative probability + fees
    // 3. If edge < minEdgeAfterCost: return NO_TRADE
    // 4. Size via PositionSizer (injected)
    // 5. Return StrategyProposal with dedupe_key
  }
}
```

- [ ] **Step 3: Implement market_graph_relative_value_v1**

```typescript
export class MarketGraphRelativeValueV1 {
  constructor(private graphStore: GraphEdgeStore, private config: { minEdgeAfterCost: number }) {}
  
  async run(input: { graphEdges: GraphEdge[]; snapshots: Map<string, MarketSnapshot>; fees: FeeSettings }): Promise<StrategyProposal[] | null> {
    // 1. Find NEG_RISK pairs with verified edges
    // 2. Check settlement logic compatibility (atomic No-to-other-Yes)
    // 2. Compute executable quotes on both legs
    // 3. Verify structural inconsistency > edge threshold
    // 4. Return paired TradeIntent[] with atomic execution requirement
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/pm/contracts/strategies-core.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pm/strategy/src/evidence-directional-v2.ts src/pm/strategy/src/market-graph-relative-value-v1.ts tests/pm/contracts/strategies-core.test.ts
git commit -m "feat(strategy): evidence_directional_v2 and market_graph_relative_value_v1"
```

---

### Task 8: Exit/Reallocation Engine + Immutable Experiment Registry

**Files:**
- Create: `src/pm/strategy/src/exit-engine.ts`
- Create: `src/pm/strategy/src/experiment-registry.ts`
- Create: `tests/pm/contracts/exit-experiment.test.ts`

**Interfaces:**
- Consumes: Current positions, live book/quotes, calibrated forecasts, time-to-resolution
- Produces: `EXIT`/`REDUCE`/`REALLOCATE` intents, immutable experiment records

- [ ] **Step 1: Write failing test for exit engine**

```typescript
// tests/pm/contracts/exit-experiment.test.ts
it("exits position when hold EV < 0 considering bid/depth/time-to-resolution", async () => {
  const engine = new ExitEngine({ minHoldEV: 0 });
  
  const result = await engine.evaluate({
    position: { market_id: "mkt_1", side: "YES", size: 100, avg_price: 0.6 },
    book: { yes_price: 0.45, no_price: 0.55 },
    forecast: { p_conservative: 0.42 },
    time_to_resolution_sec: 3600,
    fees: { taker_bps: 200 },
  });
  
  assert.ok(result.intent);
  assert.equal(result.intent.purpose, "EXIT");
  assert.equal(result.intent.side, "SELL");
});
```

- [ ] **Step 2: Implement ExitEngine + ExperimentRegistry**

```typescript
export class ExitEngine {
  constructor(private config: { minHoldEV: number }) {}
  
  async evaluate(input: { position: Position; book: Book; forecast: Forecast; time_to_resolution_sec: number; fees: FeeSettings }): Promise<{ intent: TradeIntent | null }> {
    // HOLD EV = (p * (1 - price) - (1-p) * price) * size - fees - adverse selection
    // If hold EV < 0: emit EXIT/REDUCE intent
  }
}

export class ExperimentRegistry {
  constructor(private pool: Pool) {}
  
  async register(spec: { strategy: string; version: string; params: object; envelope: ParameterEnvelope }): Promise<string> {
    // Insert immutable experiment record with spec hash
  }
  
  async promote(experimentId: string, gateResults: GateReport): Promise<void> {
    // Update status to LIVE_QUALIFIED only if all gates pass
  }
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npm run test -- tests/pm/contracts/exit-experiment.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/pm/strategy/src/exit-engine.ts src/pm/strategy/src/experiment-registry.ts tests/pm/contracts/exit-experiment.test.ts
git commit -m "feat(strategy): Exit/Reallocation Engine + Immutable Experiment Registry"
```

---

### Task 9: Untrusted Content Boundary — Runtime Enforcement

**Files:**
- Modify: `src/pm/intelligence/src/index.ts` (enhance UNTRUSTED_CONTENT_BOUNDARY)
- Create: `tests/pm/contracts/untrusted-boundary-runtime.test.ts`

**Interfaces:**
- Consumes: `EvidenceItem` with `untrusted: true`
- Produces: Runtime guard that throws/blocks privileged actions

- [ ] **Step 1: Write failing test for runtime enforcement**

```typescript
// tests/pm/contracts/untrusted-boundary-runtime.test.ts
it("throws when untrusted evidence attempts SIGN", () => {
  const evidence = { untrusted: true, content_hash: "abc" } as EvidenceItem;
  const boundary = new UntrustedContentBoundary();
  
  assert.throws(() => boundary.enforce(evidence, "SIGN"), /untrusted/);
});
```

- [ ] **Step 2: Implement runtime guard**

```typescript
export class UntrustedContentBoundary {
  enforce(evidence: Pick<EvidenceItem, "untrusted">, action: PrivilegedAction): void {
    if (evidence.untrusted && PRIVILEGED_ACTIONS.includes(action)) {
      throw new Error(`UNTRUSTED_ACTION_BLOCKED: ${action} from untrusted evidence`);
    }
  }
  
  // Inject into LLM pipeline: every tool call checks boundary
  wrapTool<Tool>(tool: Tool): Tool { ... }
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npm run test -- tests/pm/contracts/untrusted-boundary-runtime.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/pm/intelligence/src/index.ts tests/pm/contracts/untrusted-boundary-runtime.test.ts
git commit -m "feat(intelligence): Untrusted Content Boundary runtime enforcement"
```

---

### Task 10: Integration Tests + Traceability Verification

**Files:**
- Create: `tests/pm/contracts/phase9-integration.test.ts`

- [ ] **Step 1: Write integration test covering full Data→Intelligence→Strategy flow**

```typescript
// tests/pm/contracts/phase9-integration.test.ts
it("full pipeline: MarketSnapshot → Graph → Forecast → Ensemble → Strategy → Intent", async () => {
  // 1. Ingest market data → build native edges
  // 2. Fetch evidence → source registry → feature frames
  // 3. Generate forecasts → ensemble + calibration
  // 4. evidence_directional_v2 → StrategyProposal
  // 5. Arbiter → TradeIntent
  // 6. Validate intent passes risk gate
  
  const intent = await runFullPipeline(testMarketSnapshot, testEvidence);
  assert.ok(intent);
  assert.equal(intent.status, "CREATED");
});
```

- [ ] **Step 2: Run traceability check**

Run: `npm run traceability`
Expected: 96/96 structural traceability

- [ ] **Step 3: Run full test suite**

Run: `npm run test`
Expected: All 309+ contract tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/pm/contracts/phase9-integration.test.ts
git commit -m "test(phase9): Integration test + traceability verification"
```

---

**Plan complete and saved to `docs/superpowers/plans/2026-09-21-phase9-core-platform.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**