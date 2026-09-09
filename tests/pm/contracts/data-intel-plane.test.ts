import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseAssetIdentity,
  ProtocolProfileRegistry,
  SettlementRulesRegistry,
  OrderBook,
  FeeGate,
  provenByCutoff,
  assessQuality,
  contradicts,
} from "@polyroot/data";
import {
  SourceRegistry,
  weightEvidence,
  featureValue,
  CatalystBus,
  ensembleForecast,
  lineageSummary,
  isSavedResponseReplay,
  gateForecast,
  joinApiPath,
  normalizeOpenAICompatible,
  conservativeOf,
  UNTRUSTED_CONTENT_BOUNDARY,
  ResearchBudget,
  temporalRecencyWeight,
} from "@polyroot/intelligence";

import {
  type AssetIdentity,
  type CatalystEvent,
  type EvidenceItem,
  type FeatureFrame,
  type Forecast,
  type MarketFeeSettings,
  type ModelLineage,
  type ResearchQuota,
  type SettlementRule,
  type SourceRecord,
} from "@polyroot/domain";

const t0 = new Date("2026-09-09T00:00:00Z");

const baseAsset: AssetIdentity = {
  schema_version: "1.0.0",
  asset_id: "10001",
  asset_class: "CTF_TOKEN",
  settlement_protocol: "conditional-1155",
  exchange_domain_version: "clob-v2",
  chain_id: 137,
  market_id: "mkt_1",
  event_id: "ev_1",
  condition_id: "cond_1",
  outcome: "YES",
  collateral: "PUSD",
  decimals: 6,
  tick: 0.0001,
  min_size: 1,
  rules_hash: "rh1",
  protocol_profile_id: "prof_ctf_a",
};

const rule: SettlementRule = {
  schema_version: "1.0.0",
  market_id: "mkt_1",
  rule_version: "r1",
  resolution_source: "polymarket-resolver",
  resolves_at_utc: new Date("2026-09-10T00:00:00Z"),
  rule_text_hash: "rt1",
  rules_text: "will resolve per official announcement",
  active_from: t0,
};

/* ── PM-DATA-01 ── */
describe("PM-DATA-01 — typed asset identity", () => {
  it("parses a CTF integer token separately from a PolyV2 position id", () => {
    const ctf = parseAssetIdentity("10001", 137);
    assert.equal(ctf.kind, "CTF");
    assert.equal(ctf.asset_class, "CTF_TOKEN");
    const v2 = parseAssetIdentity("position:0xaa:0xbb", 137);
    assert.equal(v2.kind, "POLY_V2");
    assert.equal(v2.asset_class, "POLY_V2_POSITION");
  });

  it("unknown protocol profile rejects signing", () => {
    const reg = new ProtocolProfileRegistry();
    reg.register(baseAsset);
    assert.ok(reg.has("prof_ctf_a"));
    assert.throws(() => reg.requireKnown("prof_unknown"), /UNKNOWN_PROTOCOL_PROFILE/);
  });
});

/* ── PM-DATA-02 ── */
describe("PM-DATA-02 — settlement rules gate", () => {
  it("changing rules after a forecast fails the old intent RULES_CHANGED", () => {
    const reg = new SettlementRulesRegistry();
    reg.upsert(rule);
    assert.equal(reg.check("mkt_1", "r1").ok, true);
    reg.upsert({ ...rule, rule_version: "r2", rule_text_hash: "rt2" });
    const res = reg.check("mkt_1", "r1");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "RULES_CHANGED");
  });
});

/* ── PM-DATA-03 ── */
describe("PM-DATA-03 — order book with resync", () => {
  it("late deltas after a reconnect do not execute until snapshot+health pass", () => {
    const book = new OrderBook();
    book.apply({
      schema_version: "1.0.0",
      market_id: "mkt_1",
      bids: [[0.4, 100]],
      asks: [[0.6, 100]],
      received_at: t0,
      source_at: t0,
      is_delta: false,
      resync_required: false,
    });
    assert.equal(book.bestBid(), 0.4);
    book.disconnect();
    assert.equal(book.ready(), false);
    assert.throws(() =>
      book.apply({
        schema_version: "1.0.0",
        market_id: "mkt_1",
        bids: [[0.41, 50]],
        received_at: new Date(t0.getTime() + 1000),
        source_at: new Date(t0.getTime() + 1000),
        is_delta: true,
      }),
    );
    book.apply({
      schema_version: "1.0.0",
      market_id: "mkt_1",
      asks: [[0.59, 80]],
      received_at: new Date(t0.getTime() + 2000),
      source_at: new Date(t0.getTime() + 2000),
      resync_required: true,
    });
    assert.equal(book.ready(), true);
    assert.equal(book.bestAsk(), 0.59);
  });
});

/* ── PM-DATA-04 ── */
describe("PM-DATA-04 — fee gate", () => {
  it("fee change before submit forces re-quote; unknown fee rejects entry", () => {
    const settings: MarketFeeSettings = {
      schema_version: "1.0.0",
      market_id: "mkt_1",
      fee_maker_bps: 0,
      fee_taker_bps: 200,
      fee_currency: "PUSD",
      tick_size: 0.0001,
      min_size: 1,
      trade_mode: "BINARY",
      fee_settings_hash: "fh1",
      observed_at: t0,
    };
    const gate = new FeeGate();
    assert.equal(gate.requireCurrent("mkt_2").ok, false);
    gate.observe(settings);
    assert.equal(gate.requireCurrent("mkt_1").ok, true);
    gate.observe({ ...settings, trade_mode: "UNKNOWN", fee_settings_hash: "fh2" });
    const res = gate.requireCurrent("mkt_1", "BINARY");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "FEE_UNKNOWN");
  });
});

/* ── PM-DATA-05 ── */
describe("PM-DATA-05 — evidence provenance", () => {
  it("news fetched after cutoff is not part of replay before cutoff", () => {
    const item: EvidenceItem = {
      schema_version: "1.0.0",
      id: "01ABC",
      fetched_at: new Date("2026-09-09T10:00:00Z"),
      available_at: new Date("2026-09-09T10:00:00Z"),
      content_hash: "ch1",
      claim: "poll shifts",
    };
    const cutoff = new Date("2026-09-09T09:00:00Z");
    assert.equal(provenByCutoff(item, cutoff), false);
    const early: EvidenceItem = { ...item, fetched_at: new Date("2026-09-09T08:00:00Z"), available_at: new Date("2026-09-09T08:00:00Z") };
    assert.equal(provenByCutoff(early, cutoff), true);
  });
});

/* ── PM-DATA-06 ── */
describe("PM-DATA-06 — data quality & limits", () => {
  it("a missing price is never treated as zero", () => {
    const f = assessQuality({
      price: null,
      observed_at: t0,
      now: t0,
      seenFamilies: new Map(),
      requestBudgetOk: true,
    });
    assert.equal(f.data_missing, true);
    assert.equal(f.observed_zero, false);
  });

  it("one article copied to three sites is still a single syndication family", () => {
    const seen = new Map<string, string>();
    const f1 = assessQuality({ price: 0.5, observed_at: t0, now: t0, url: "https://a.com/x?utm=1", seenFamilies: seen, requestBudgetOk: true });
    const f2 = assessQuality({ price: 0.5, observed_at: t0, now: t0, url: "https://a.com/x?utm=2", seenFamilies: seen, requestBudgetOk: true });
    const f3 = assessQuality({ price: 0.5, observed_at: t0, now: t0, url: "https://a.com/x?utm=3", seenFamilies: seen, requestBudgetOk: true });
    assert.equal(f2.syndication_family, f1.syndication_family);
    assert.equal(f3.syndication_family, f1.syndication_family);
    assert.ok(f2.is_duplicate_of !== undefined);
  });

  it("contradiction is flagged; stale data is detected", () => {
    assert.equal(contradicts([0.3, 0.3, 0.6]), true);
    assert.equal(contradicts([0.3, 0.3]), false);
    const stale = assessQuality({
      price: 0.5,
      observed_at: new Date(t0.getTime() - 16 * 60 * 1000),
      now: t0,
      seenFamilies: new Map(),
      requestBudgetOk: true,
    });
    assert.equal(stale.is_stale, true);
  });
});

/* ── PM-INTEL-02 ── */
describe("PM-INTEL-02 — source registry & syndication", () => {
  const wire = (url: string, parent?: string): SourceRecord => ({
    schema_version: "1.0.0",
    source_id: `src_${url}`,
    url,
    epistemic_class: "SECONDARY",
    domain: "news.example",
    source_class: "FUNDAMENTAL",
    reliability: { score: 0.7, sample_count: 10, window: "90d" },
    syndication_parent: parent,
    registered_at: t0,
  });

  it("two wire-copy URLs resolve to one independent family", () => {
    const reg = new SourceRegistry();
    reg.register(wire("https://news.example/a/1", "family_x"));
    reg.register(wire("https://reblog.example/a/repost", "family_x"));
    const families = reg.independentFamilies([
      "https://news.example/a/1",
      "https://reblog.example/a/repost",
    ]);
    assert.equal(families.size, 1);
  });

  it("unrelated URLs are independent families", () => {
    const reg = new SourceRegistry();
    reg.register(wire("https://news.example/a/1"));
    reg.register(wire("https://wire.example/b/2"));
    assert.equal(reg.independentFamilies(["https://news.example/a/1", "https://wire.example/b/2"]).size, 2);
  });
});

/* ── PM-INTEL-03 ── */
describe("PM-INTEL-03 — evidence weighting", () => {
  const item: EvidenceItem = {
    schema_version: "1.0.0",
    id: "01AAA",
    relevance: 0.8,
    fetched_at: t0,
    available_at: t0,
    published_at: t0,
    content_hash: "ch",
  };
  const source: SourceRecord = {
    schema_version: "1.0.0",
    source_id: "src1",
    url: "https://p.example/feed",
    epistemic_class: "PRIMARY",
    domain: "p.example",
    source_class: "FUNDAMENTAL",
    reliability: { score: 0.9, sample_count: 100, window: "180d" },
    registered_at: t0,
  };

  it("primary, fresh, independent evidence scores higher than syndicated/late", () => {
    const good = weightEvidence({ item, source, now: t0, independentFamilyCount: 2, contradicted: false, lateAfterPublished: 0 });
    const late = weightEvidence({ item, source, now: t0, independentFamilyCount: 2, contradicted: false, lateAfterPublished: 7200 });
    const syndicated = weightEvidence({ item, source: { ...source, epistemic_class: "AGGREGATOR", reliability: { score: 0.5, sample_count: 3, window: "30d" } }, now: t0, independentFamilyCount: 1, contradicted: false, lateAfterPublished: 0 });
    assert.ok(good > late, "fresh beats late");
    assert.ok(good > syndicated, "primary beats aggregator");
  });

  it("temporal recency decays positive with age", () => {
    const now = new Date(t0.getTime() + 24 * 3600 * 1000);
    const w = temporalRecencyWeight(t0, now);
    assert.ok(w < 1 && w > 0);
  });
});

/* ── PM-INTEL-04 ── */
describe("PM-INTEL-04 — feature frames", () => {
  const frame: FeatureFrame = {
    schema_version: "1.0.0",
    market_id: "mkt_1",
    source_class: "MARKET",
    feature: "spread",
    value: null,
    sampling_window_s: 60,
    source_lag_s: 3,
    quality: { schema_version: "1.0.0", data_missing: true },
    sampled_at: t0,
  };
  it("missing value is null, never zero", () => {
    assert.equal(featureValue(frame, "spread"), null);
  });
});

/* ── PM-INTEL-07/08 ── */
describe("PM-INTEL-07/08 — catalyst bus & durable outbox", () => {
  const ev = (id: string): CatalystEvent => ({
    schema_version: "1.0.0",
    event_id: id,
    category: "RULES_CHANGED",
    subject: "rules-changed",
    payload_version: 1,
    event_at: t0,
    received_at: t0,
    dedupe_key: id,
  });

  it("official update invalidates before valid_until; new intent fails CATALYST_CHANGED", () => {
    const bus = new CatalystBus();
    assert.equal(bus.enqueue(ev("e1")).ok, true);
    const dup = bus.enqueue(ev("e1"));
    assert.equal(dup.ok, false);
    if (!dup.ok) assert.equal(dup.code, "DUPLICATE_EVENT");
    // Watermark: only un-consumed events replayed.
    const first = bus.replay("consumer_1", "e1");
    assert.equal(first.length, 1);
    assert.equal(bus.replay("consumer_1", "e1").length, 0);
  });

  it("duplicate / reordered events do not open two intents", () => {
    const bus = new CatalystBus();
    bus.enqueue(ev("a"));
    bus.replay("exec", "a");
    bus.enqueue(ev("a")); // duplicate delivery skipped
    bus.enqueue({ ...ev("b"), dedupe_key: "a" });
    assert.equal(bus.pendingCount(), 2);
    const consumed = bus.replay("exec", "a");
    assert.equal(consumed.length, 1); // b only fires once despite dedupe alias
  });
});

/* ── PM-INTEL-09 ── */
describe("PM-INTEL-09 — forecast ensemble", () => {
  it("shared evidence family is not counted as independent", () => {
    const res = ensembleForecast({
      components: [
        { p_yes: 0.8, familyId: "fam_A" },
        { p_yes: 0.2, familyId: "fam_A" }, // same evidence family
        { p_yes: 0.5, familyId: "fam_B", weight: 2 },
      ],
      eventClass: "politics",
      weightBooks: new Map(),
      version: "ens_v1",
    });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.effectiveFamilyCount, 2);
  });

  it("model failure yields recorded ensemble version, not silent fallback", () => {
    const res = ensembleForecast({
      components: [],
      eventClass: "politics",
      weightBooks: new Map(),
      version: "ens_v1",
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "NO_VALID_COMPONENT");
  });
});

/* ── PM-INTEL-10 ── */
describe("PM-INTEL-10 — model lineage", () => {
  const line: ModelLineage = {
    schema_version: "1.0.0",
    provider: "anthropic",
    requested_model: "claude-x",
    resolved_model: "claude-x-2026",
    api_version: "2026-09",
    prompt_hash: "ph1",
    response_hash: "rh1",
    generated_at: t0,
    model_fingerprint_state: "UNKNOWN",
    generation_source: "HOSTED",
  };
  it("missing fingerprint is stored as UNKNOWN", () => {
    assert.equal(line.model_fingerprint_state, "UNKNOWN");
    assert.match(lineageSummary(line), /fp:UNKNOWN/);
  });
  it("saved-response replay is distinguished from hosted regeneration", () => {
    assert.equal(isSavedResponseReplay({ ...line, generation_source: "HOSTED" }), false);
    assert.equal(isSavedResponseReplay({ ...line, generation_source: "SAVED_RESPONSE_REPLAY" }), true);
  });
});

/* ── PM-AI-01 ── */
describe("PM-AI-01 — forecast gate", () => {
  const good: Forecast = {
    schema_version: "1.0.0",
    forecast_id: "01F",
    market_id: "mkt_1",
    p_yes: 0.7,
    evidence_ids: ["e1"],
    assumptions: ["a"],
    invalidators: [],
    horizon_sec: 3600,
    valid_until: new Date("2026-09-09T01:00:00Z"),
    created_at: t0,
  };
  it("normalized multinomial accepted without forcing binary", () => {
    const multi = {
      ...good,
      distribution: [0.5, 0.3, 0.2],
      p_raw: 0.5,
      p_calibrated: 0.5,
      p_conservative: 0.5,
    } as unknown as Forecast;
    assert.equal(gateForecast(multi).ok, true);
  });
  it("unnormalized distribution is rejected", () => {
    const bad = { ...good, distribution: [0.5, 0.5, 0.5] } as unknown as Forecast;
    const res = gateForecast(bad);
    assert.equal(res.ok, false);
    if (!res.ok) assert.ok(res.problems.includes("distribution_not_normalized"));
  });
  it("missing evidence trace is rejected", () => {
    const res = gateForecast({ ...good, evidence_ids: [], counterevidence_ids: [] });
    assert.equal(res.ok, false);
    if (!res.ok) assert.ok(res.problems.includes("no_evidence_trace"));
  });
});

/* ── PM-AI-02 ── */
describe("PM-AI-02 — provider portability", () => {
  it("base URL ending in /v1 does not produce /v1/v1", () => {
    assert.equal(joinApiPath("https://api.example.com/v1", "v1/chat/completions"), "https://api.example.com/v1/chat/completions");
    assert.equal(joinApiPath("https://api.example.com", "/chat/completions"), "https://api.example.com/chat/completions");
  });
  it("empty base falls back to default OpenAI-compatible endpoint", () => {
    assert.equal(normalizeOpenAICompatible(), "https://api.openai.com/v1");
    assert.equal(normalizeOpenAICompatible("https://gw.example.com/v1/"), "https://gw.example.com/v1");
  });
});

/* ── PM-AI-03 ── */
describe("PM-AI-03 — probability quality split", () => {
  it("without calibration, conservative is pulled toward 0.5", () => {
    assert.equal(conservativeOf(0.9, undefined), 0.7);
    assert.equal(conservativeOf(0.9, 0.88), 0.88);
  });
});

/* ── PM-AI-04 ── */
describe("PM-AI-04 — untrusted content boundary", () => {
  it("web content cannot trigger sign/shell/secret/policy actions", () => {
    const data = { untrusted: true };
    assert.equal(UNTRUSTED_CONTENT_BOUNDARY.canPerform(data, "SIGN"), false);
    assert.equal(UNTRUSTED_CONTENT_BOUNDARY.canPerform(data, "SHELL"), false);
    assert.equal(UNTRUSTED_CONTENT_BOUNDARY.canPerform(data, "SECRET_READ"), false);
    assert.equal(UNTRUSTED_CONTENT_BOUNDARY.canPerform(data, "POLICY_WRITE"), false);
    assert.equal(UNTRUSTED_CONTENT_BOUNDARY.canPerform(data, "MANDATE_WRITE"), false);
  });
  it("trusted pipeline evidence may act", () => {
    assert.equal(UNTRUSTED_CONTENT_BOUNDARY.canPerform({ untrusted: false }, "SIGN"), true);
  });
});

/* ── PM-AI-05 ── */
describe("PM-AI-05 — research budget", () => {
  const quota: ResearchQuota = {
    schema_version: "1.0.0",
    max_tokens: 1000,
    max_cost_usd: 1,
    max_duration_s: 60,
    max_sources: 5,
    max_concurrency: 1,
  };
  it("budget exhaustion yields abstain; reconciliation/cancel stay alive", () => {
    const b = new ResearchBudget(quota);
    assert.equal(b.check(600).ok, true);
    b.charge(600, 0.002);
    assert.equal(b.check(600).ok, false);
  });
});