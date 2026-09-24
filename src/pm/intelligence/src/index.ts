/**
 * @polyroot/intelligence — Intelligence plane (PM-INTEL-01..10, PM-AI-01..05).
 * Pure primitives: source registry/syndication, feature frames, catalyst bus
 * (durable outbox + watermark), ensemble, model lineage, research quota,
 * provider portability, untyped-content boundary. No I/O.
 */
import {
  z,
  type CatalystEvent,
  type DataQualityFlags,
  type EvidenceItem,
  type FeatureFrame,
  type Forecast,
  type ForecastComponent,
  type ModelLineage,
  type ResearchQuota,
  type SourceRecord,
} from "@polyroot/domain";

/* ─── Shared interfaces for Intelligence components ─────────────────────
 * Both in-memory and PG implementations satisfy these interfaces.
 * This allows dependency injection and testing with either implementation.
 */

export interface SourceRegistryInterface {
  register(record: SourceRecord): Promise<string>;
  family(url: string): Promise<string | undefined>;
  independentFamilies(urls: string[]): Promise<Set<string>>;
}

export interface CatalystBusInterface {
  enqueue(event: CatalystEvent): Promise<DurableOutboxResult>;
  replay(consumer: string, fromEventId: string): Promise<CatalystEvent[]>;
  advanceWatermark(consumer: string, eventId: string): Promise<void>;
  pendingCount(): number;
}

export interface ResearchBudgetInterface {
  charge(tokens: number, costUsdFrac: number): Promise<void>;
  check(tokensNeeded: number): Promise<{
    ok: boolean;
    remainingTokens?: bigint;
    code?: string;
    reason?: string;
  }>;
  reset(): Promise<void>;
}

/* ─── PM-INTEL-02: source registry + syndication ────────────────────── */

/**
 * Syndication folding (PM-INTEL-02): two URLs that are wire copies of the same
 * originating article collapse to ONE independent evidence family. Family key
 * is derived from the syndication_parent when present, else the URL host+path.
 */
export class SourceRegistry implements SourceRegistryInterface {
  private readonly byUrl = new Map<string, SourceRecord>();
  private readonly familyOf = new Map<string, string>();

  /** Fold a record: assigns a stable family id. Returns the family id. */
  async register(record: SourceRecord): Promise<string> {
    this.byUrl.set(record.url, record);
    const syndParent = record.syndication_parent;
    const key =
      syndParent ??
      record.url
        .replace(/^\w+:\/\//, "")
        .replace(/^www\./, "")
        .split("?")[0] ??
      record.url;
    let family: string | undefined = this.familyOf.get(key);
    if (!family) {
      family = key;
      this.familyOf.set(key, family);
    }
    if (syndParent) {
      this.familyOf.set(record.url, syndParent);
    }
    return family as string;
  }

  async family(url: string): Promise<string | undefined> {
    return this.familyOf.get(url);
  }

  async independentFamilies(urls: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    for (const u of urls) {
      const hit = this.byUrl.get(u);
      const f = hit?.syndication_parent ?? this.familyOf.get(u) ?? u;
      out.add(f);
    }
    return out;
  }
}

/* ─── PM-INTEL-03: evidence weighting ────────────────────────────────── */

const EVIDENCE_HALF_LIFE_MS = 7 * 24 * 3600 * 1000;

export function temporalRecencyWeight(publishedAt: Date, now: Date): number {
  const ageMs = Math.max(0, now.getTime() - publishedAt.getTime());
  return Math.exp((-ageMs * Math.LN2) / EVIDENCE_HALF_LIFE_MS);
}

/**
 * Evidence weight (PM-INTEL-03): primary source + temporal relevance +
 * independence; contradicted or syndicated-late evidence is discounted, and a
 * source rating never equals a truth probability.
 */
export function weightEvidence(input: {
  item: EvidenceItem;
  source: SourceRecord;
  now: Date;
  independentFamilyCount: number;
  contradicted: boolean;
  lateAfterPublished: number;
}): number {
  const {
    item,
    source,
    now,
    independentFamilyCount,
    contradicted,
    lateAfterPublished,
  } = input;
  const primary =
    source.epistemic_class === "PRIMARY"
      ? 1
      : source.epistemic_class === "SECONDARY"
        ? 0.6
        : 0.4;
  const recency = item.published_at
    ? temporalRecencyWeight(item.published_at, now)
    : 0.5;
  const latePenalty =
    lateAfterPublished > 0 ? Math.max(0.5, 1 - lateAfterPublished / 3600) : 1;
  const independence =
    independentFamilyCount >= 1 ? Math.min(1, independentFamilyCount / 2) : 0.2;
  const contradictionPenalty = contradicted ? 0.3 : 1;
  const trust = (item.relevance ?? 0.5) * source.reliability.score;
  return Math.min(
    1,
    primary *
      recency *
      independence *
      contradictionPenalty *
      latePenalty *
      (0.5 + 0.5 * trust),
  );
}

/* ─── PM-INTEL-04: feature frames ────────────────────────────────────── */

/** Feature vector shaping (PM-INTEL-04): missing stays null, never imputed 0. */
export function featureValue(frame: FeatureFrame, key: string): number | null {
  if (frame.feature === key) return frame.value;
  return null;
}

export function frameNullIfMissing(frame: FeatureFrame): number | null {
  return frame.value === null ? null : frame.value;
}

/* ─── PM-INTEL-07/08: catalyst bus ───────────────────────────────────── */

export type DurableOutboxResult =
  | { ok: true; event: CatalystEvent }
  | { ok: false; code: "DUPLICATE_EVENT"; eventId: string };

/**
 * Durable catalyst bus with watermark (PM-INTEL-08): game-over event ids are
 * deduped, consumers advance a watermark, replay never re-executes trades.
 * Callers persist `outbox` / `watermark`; this class is the pure core.
 */
export class CatalystBus {
  private readonly seen = new Map<string, CatalystEvent>();
  private readonly outbox: CatalystEvent[] = [];
  private readonly watermark: Map<string, string> = new Map();

  enqueue(event: CatalystEvent): DurableOutboxResult {
    if (this.seen.has(event.event_id)) {
      return { ok: false, code: "DUPLICATE_EVENT", eventId: event.event_id };
    }
    this.seen.set(event.event_id, event);
    this.outbox.push(event);
    return { ok: true, event };
  }

  replay(consumer: string, fromEventId: string): CatalystEvent[] {
    if (!this.watermark.has(consumer)) {
      // First replay: include fromEventId and everything after.
      const start = this.outbox.findIndex((e) => e.event_id === fromEventId);
      if (start >= 0) {
        const fresh = this.outbox.slice(start);
        if (fresh.length) {
          const last = fresh[fresh.length - 1];
          if (last) this.watermark.set(consumer, last.event_id);
        }
        return fresh;
      }
      return [];
    }
    // Subsequent replays: only events after the watermark.
    const after = this.outbox.findIndex(
      (e) => e.event_id === this.watermark.get(consumer),
    );
    if (after >= 0) return this.outbox.slice(after + 1);
    return [];
  }

  advanceWatermark(consumer: string, eventId: string): void {
    this.watermark.set(consumer, eventId);
  }

  pendingCount(): number {
    return this.outbox.length;
  }
}

/* ─── PM-INTEL-09: forecast ensemble ─────────────────────────────────── */

export type EnsembleOutcome =
  | { ok: true; p_yes: number; version: string; effectiveFamilyCount: number }
  | { ok: false; code: "NO_VALID_COMPONENT"; version: string };

/**
 * Forecast ensemble (PM-INTEL-09): providers sharing the same evidence family
 * are NOT counted as independent; weights are pinned per event-class; a failed
 * model yields abstain or a recorded ensemble version — never silent fallback.
 * Binary p_yes is only one shape; multinomial distributions are supported via
 * `distribution` (normalization checked by the caller) — here we aggregate.
 */
export function ensembleForecast(input: {
  components: Array<{ p_yes: number; familyId: string; weight?: number }>;
  eventClass: string;
  weightBooks: Map<string, Map<string, number>>;
  version: string;
}): EnsembleOutcome {
  const { components, eventClass, weightBooks, version } = input;
  if (components.length === 0)
    return { ok: false, code: "NO_VALID_COMPONENT", version };
  const pinned = weightBooks.get(eventClass);
  let num = 0;
  let den = 0;
  const families = new Set<string>();
  for (const c of components) {
    families.add(c.familyId);
    const w = pinned?.get(c.familyId) ?? c.weight ?? 1 / components.length;
    num += c.p_yes * w;
    den += w;
  }
  if (den <= 0) return { ok: false, code: "NO_VALID_COMPONENT", version };
  return {
    ok: true,
    p_yes: num / den,
    version,
    effectiveFamilyCount: families.size,
  };
}

/* ─── PM-INTEL-10: model lineage ─────────────────────────────────────── */

export function lineageSummary(lineage: ModelLineage): string {
  const fp = lineage.release_fingerprint ?? `UNKNOWN`;
  return `${lineage.provider}@${lineage.resolved_model} (fp:${fp}, src:${lineage.generation_source})`;
}

/** Replay is distinguished from hosted regeneration (PM-INTEL-10). */
export function isSavedResponseReplay(lineage: ModelLineage): boolean {
  return lineage.generation_source === "SAVED_RESPONSE_REPLAY";
}

/* ─── PM-AI-01: forecast gate ────────────────────────────────────────── */

export type ForecastGateResult =
  | { ok: true; forecast: Forecast }
  | { ok: false; code: "INVALID_FORECAST"; problems: string[] };

/**
 * Acceptance gate for structured forecasts (PM-AI-01): distribution
 * normalization, required lineage, valid horizon. Binary p_yes is one shape;
 * a valid multinomial is accepted as-is.
 */
export function gateForecast(f: Forecast): ForecastGateResult {
  const problems: string[] = [];
  const probs = (f as unknown as { distribution?: number[] }).distribution;
  if (probs) {
    const sum = probs.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-6) problems.push("distribution_not_normalized");
  }
  const hasP =
    f.p_raw !== undefined ||
    f.p_calibrated !== undefined ||
    f.p_conservative !== undefined;
  if (!hasP && !probs) problems.push("no_probability_shape");
  if (!f.valid_until) problems.push("missing_valid_until");
  if (!f.valid_until || f.valid_until.getTime() <= f.created_at.getTime())
    problems.push("valid_until_not_after_created");
  if (
    !f.abstain_reason &&
    f.evidence_ids.length === 0 &&
    f.counterevidence_ids.length === 0
  )
    problems.push("no_evidence_trace");
  if (problems.length) return { ok: false, code: "INVALID_FORECAST", problems };
  return { ok: true, forecast: f };
}

/* ─── PM-AI-02: provider portability ─────────────────────────────────── */

/**
 * Base URL canonicalization (PM-AI-02): a base ending in /v1 must not produce
 * /v1/v1. Kept as a pure helper; adapters are thin I/O wrappers tested against
 * a fake transport in the contract tests.
 */
export function joinApiPath(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const p = path.replace(/^\/+/, "");
  if (base.endsWith("/v1") && p.startsWith("v1/"))
    return `${base}/${p.slice(3)}`;
  return `${base}/${p}`;
}

export function normalizeOpenAICompatible(
  baseUrl?: string,
  fallback = "https://api.openai.com/v1",
): string {
  if (!baseUrl || baseUrl.length === 0) return fallback;
  return baseUrl.replace(/\/+$/, "");
}

/* ─── PM-AI-03: probability quality split ────────────────────────────── */

/**
 * Raw / calibrated / conservative split (PM-AI-03). Verbal verbal confidence
 * from an LLM is never a position-sizing measure; the conservative value is
 * driven toward 0.5 (uncertainty) when calibration is missing.
 */
export function conservativeOf(
  raw: number,
  calibrated: number | undefined,
): number {
  const base = calibrated ?? raw;
  if (calibrated === undefined) return 0.5 + (base - 0.5) * 0.5;
  return base;
}

/* ─── PM-AI-04: untrusted content boundary ───────────────────────────── */

export type PrivilegedAction =
  "SIGN" | "SHELL" | "SECRET_READ" | "POLICY_WRITE" | "MANDATE_WRITE";

/**
 * Untrusted content boundary (PM-AI-04): web content is DATA. It can never
 * trigger privileged actions or mutate policy/mandate. LLM synthesis output is
 * always data-bearing; only the explicit pipeline may act.
 */
export function allowedForEvidence(
  e: Pick<EvidenceItem, "untrusted">,
  _action: PrivilegedAction,
): boolean {
  return !e.untrusted;
}

const PRIVILEGED: PrivilegedAction[] = [
  "SIGN",
  "SHELL",
  "SECRET_READ",
  "POLICY_WRITE",
  "MANDATE_WRITE",
];

/** A guard object usable by the control plane to broker every privileged call. */
export const UNTRUSTED_CONTENT_BOUNDARY = {
  canPerform(
    e: Pick<EvidenceItem, "untrusted">,
    action: PrivilegedAction,
  ): boolean {
    return PRIVILEGED.includes(action) ? allowedForEvidence(e, action) : true;
  },
};

export const PRIVILEGED_ACTIONS: PrivilegedAction[] = PRIVILEGED;

/**
 * Runtime enforcement boundary for untrusted content (PM-AI-04).
 * Throws on violations rather than returning boolean, for fail-closed behavior
 * in the LLM tool-call pipeline.
 */
export class UntrustedContentBoundary {
  /**
   * Enforce that untrusted evidence cannot perform privileged actions.
   * Throws if the evidence is untrusted and the action is privileged.
   */
  enforce(
    evidence: Pick<EvidenceItem, "untrusted">,
    action: PrivilegedAction,
  ): void {
    if (evidence.untrusted && PRIVILEGED_ACTIONS.includes(action)) {
      throw new Error(
        `UNTRUSTED_ACTION_BLOCKED: ${action} from untrusted evidence`,
      );
    }
  }

  /**
   * Wrap a tool to inject untrusted content boundary checks.
   * Every tool call checks the boundary before execution.
   */
  wrapTool<T extends (...args: unknown[]) => unknown>(
    tool: T,
    getEvidence: () => Pick<EvidenceItem, "untrusted">,
    action: PrivilegedAction,
  ): T {
    return ((...args: unknown[]) => {
      const evidence = getEvidence();
      this.enforce(evidence, action);
      return tool(...args);
    }) as T;
  }
}

/* ─── PM-AI-05: research quota ───────────────────────────────────────── */

export type QuotaCheck =
  | { ok: true; remainingTokens: bigint }
  | { ok: false; code: "BUDGET_EXHAUSTED"; reason: string };

/**
 * Research budget governor (PM-AI-05). When the quota is exhausted the agent
 * ABSTAINS from new entries — reconciliation and cancel stay alive (those
 * flows do not consume research quota).
 */
export class ResearchBudget {
  private tokensUsed = 0n;
  private costUsedUsd = 0n;
  private readonly microUsd = (usd: number) => BigInt(Math.round(usd * 1e6));

  constructor(private readonly quota: ResearchQuota) {}

  charge(tokens: number, costUsdFrac: number): void {
    this.tokensUsed += BigInt(Math.round(tokens));
    this.costUsedUsd += this.microUsd(costUsdFrac as number);
  }

  check(tokensNeeded: number): QuotaCheck {
    const quotaText = this.quota.max_tokens.toString(10);
    if (
      this.tokensUsed + BigInt(Math.round(tokensNeeded)) >
      BigInt(quotaText)
    ) {
      return {
        ok: false,
        code: "BUDGET_EXHAUSTED",
        reason: "token_quota_exceeded",
      };
    }
    return { ok: true, remainingTokens: BigInt(quotaText) - this.tokensUsed };
  }
}

/* ─── PG-AI-05: PostgreSQL Research Budget ─────────────────────────── */

export class PgResearchBudget {
  constructor(
    private pool: {
      query: (
        text: string,
        params?: unknown[],
      ) => Promise<{ rowCount: number; rows?: unknown[] }>;
    },
    private quota: ResearchQuota,
  ) {}

  async charge(tokens: number, costUsdFrac: number): Promise<void> {
    await this.pool.query(
      `UPDATE research_budget SET tokens_used = tokens_used + $1, cost_used_usd_micro = cost_used_usd_micro + $2`,
      [tokens, Math.round(costUsdFrac * 1e6)],
    );
  }

  async check(tokensNeeded: number): Promise<QuotaCheck> {
    const result = await this.pool.query(
      `SELECT tokens_used, cost_used_usd_micro FROM research_budget LIMIT 1`,
    );
    const row =
      result.rows &&
      (result.rows[0] as
        | { tokens_used: string | number; cost_used_usd_micro: string | number }
        | undefined);
    const tokensUsed = row ? BigInt(row.tokens_used) : 0n;

    const quotaTokens = BigInt(this.quota.max_tokens.toString(10));
    if (tokensUsed + BigInt(Math.round(tokensNeeded)) > quotaTokens) {
      return {
        ok: false,
        code: "BUDGET_EXHAUSTED",
        reason: "token_quota_exceeded",
      };
    }
    return { ok: true, remainingTokens: quotaTokens - tokensUsed };
  }

  async reset(): Promise<void> {
    await this.pool.query(
      `UPDATE research_budget SET tokens_used = 0, cost_used_usd_micro = 0, last_reset = now()`,
    );
  }
}

/* ─── PM-INTEL-02: PostgreSQL Source Registry ─────────────────────────── */

type SourceRecordRow = {
  url: string;
  syndication_parent: string | null;
};

export class PgSourceRegistry {
  constructor(
    private pool: {
      query: (
        text: string,
        params?: unknown[],
      ) => Promise<{ rows: SourceRecordRow[] }>;
    },
  ) {}

  async register(record: SourceRecord): Promise<string> {
    const syndParent = record.syndication_parent;
    const key =
      syndParent ??
      record.url
        .replace(/^\w+:\/\//, "")
        .replace(/^www\./, "")
        .split("?")[0] ??
      record.url;

    let family = key;
    if (syndParent) {
      family = syndParent;
    }

    await this.pool.query(
      `INSERT INTO source_records (
        source_id, url, epistemic_class, domain, source_class,
        reliability_score, reliability_sample_count, reliability_window,
        correction_history, syndication_parent, latency_sec, specialization, registered_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
      ON CONFLICT (url) DO UPDATE SET
        epistemic_class = EXCLUDED.epistemic_class,
        domain = EXCLUDED.domain,
        source_class = EXCLUDED.source_class,
        reliability_score = EXCLUDED.reliability_score,
        reliability_sample_count = EXCLUDED.reliability_sample_count,
        reliability_window = EXCLUDED.reliability_window,
        correction_history = EXCLUDED.correction_history,
        syndication_parent = EXCLUDED.syndication_parent,
        latency_sec = EXCLUDED.latency_sec,
        specialization = EXCLUDED.specialization`,
      [
        record.source_id,
        record.url,
        record.epistemic_class,
        record.domain,
        record.source_class,
        record.reliability.score,
        record.reliability.sample_count,
        record.reliability.window,
        JSON.stringify(record.correction_history ?? []),
        record.syndication_parent ?? null,
        record.latency_sec ?? null,
        record.specialization ?? null,
        record.registered_at,
      ],
    );

    return family;
  }

  async family(url: string): Promise<string | undefined> {
    const res = await this.pool.query(
      `SELECT url, syndication_parent FROM source_records WHERE url = $1`,
      [url],
    );
    if (res.rows.length === 0) return undefined;
    const row = res.rows[0];
    if (!row) return undefined;
    if (row.syndication_parent) return row.syndication_parent;
    const u = row.url;
    return (
      u
        .replace(/^\w+:\/\//, "")
        .replace(/^www\./, "")
        .split("?")[0] ?? u
    );
  }

  async independentFamilies(urls: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (urls.length === 0) return out;
    const res = await this.pool.query(
      `SELECT url, syndication_parent FROM source_records WHERE url = ANY($1::text[])`,
      [urls],
    );
    const map = new Map<string, SourceRecordRow>();
    for (const r of res.rows) {
      map.set(r.url, r);
    }
    for (const u of urls) {
      const hit = map.get(u);
      if (hit && hit.syndication_parent) {
        out.add(hit.syndication_parent);
      } else {
        const key =
          u
            .replace(/^\w+:\/\//, "")
            .replace(/^www\./, "")
            .split("?")[0] ?? u;
        out.add(hit ? key : u);
      }
    }
    return out;
  }
}

/* ─── PM-INTEL-08: catalyst bus (durable outbox + watermark) ──────────── */

/**
 * Durable catalyst bus with watermark (PM-INTEL-08): PostgreSQL-backed
 * implementation that persists events and watermarks for replay across restarts.
 */
/** Shape of a catalyst_outbox row as returned by pg (snake_case columns). */
interface CatalystOutboxRow {
  event_id: string;
  category: CatalystEvent["category"];
  subject: string;
  payload_version: number;
  event_at: Date | string;
  received_at: Date | string;
  dedupe_key: string;
  payload: unknown;
}

export class PgCatalystBus {
  constructor(
    private pool: {
      query: (
        text: string,
        params?: unknown[],
      ) => Promise<{ rowCount: number; rows?: unknown[] }>;
    },
  ) {}

  async enqueue(event: CatalystEvent): Promise<DurableOutboxResult> {
    const insertResult = await this.pool.query(
      `INSERT INTO catalyst_outbox (
        event_id, category, subject, payload_version, event_at, received_at, dedupe_key, payload
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING event_id`,
      [
        event.event_id,
        event.category,
        event.subject,
        event.payload_version,
        event.event_at,
        event.received_at,
        event.dedupe_key,
        JSON.stringify(event.payload),
      ],
    );

    if (insertResult.rowCount && insertResult.rowCount > 0) {
      return { ok: true, event };
    } else {
      return { ok: false, code: "DUPLICATE_EVENT", eventId: event.event_id };
    }
  }

  async replay(
    consumer: string,
    fromEventId: string,
  ): Promise<CatalystEvent[]> {
    const watermarkResult = await this.pool.query(
      `SELECT last_event_id FROM catalyst_watermarks WHERE consumer = $1`,
      [consumer],
    );

    let lastEventId: string | null = null;
    if (
      watermarkResult.rowCount &&
      watermarkResult.rowCount > 0 &&
      watermarkResult.rows
    ) {
      const row = watermarkResult.rows[0] as
        { last_event_id: string } | undefined;
      if (row) lastEventId = row.last_event_id;
    }

    if (!lastEventId) {
      const result = await this.pool.query(
        `SELECT event_id, category, subject, payload_version, event_at, received_at, dedupe_key, payload 
         FROM catalyst_outbox 
         WHERE event_id >= $1 
         ORDER BY event_id`,
        [fromEventId],
      );

      if (!result.rows) return [];

      const rows = result.rows as CatalystOutboxRow[];
      return rows.map((row) => ({
        event_id: row.event_id,
        category: row.category,
        subject: row.subject,
        payload_version: row.payload_version,
        event_at: new Date(row.event_at),
        received_at: new Date(row.received_at),
        dedupe_key: row.dedupe_key,
        payload: row.payload,
      })) as CatalystEvent[];
    } else {
      const result = await this.pool.query(
        `SELECT event_id, category, subject, payload_version, event_at, received_at, dedupe_key, payload 
         FROM catalyst_outbox 
         WHERE event_id > $1 
         ORDER BY event_id`,
        [lastEventId],
      );

      if (!result.rows) return [];

      const rows = result.rows as CatalystOutboxRow[];
      return rows.map((row) => ({
        event_id: row.event_id,
        category: row.category,
        subject: row.subject,
        payload_version: row.payload_version,
        event_at: new Date(row.event_at),
        received_at: new Date(row.received_at),
        dedupe_key: row.dedupe_key,
        payload: row.payload,
      })) as CatalystEvent[];
    }
  }

  async advanceWatermark(consumer: string, eventId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO catalyst_watermarks (consumer, last_event_id, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (consumer) 
       DO UPDATE SET last_event_id = EXCLUDED.last_event_id, updated_at = EXCLUDED.updated_at`,
      [consumer, eventId],
    );
  }

  pendingCount(): number {
    // For PG implementation, we don't track in-memory outbox count
    // This is a stub - in production you might query the DB
    return 0;
  }
}

export * from "./catalyst-gate.js";
export * from "./forecast-provider.js";

/* ─── minor re-exports ───────────────────────────────────────────────── */

export type {
  DataQualityFlags,
  FeatureFrame,
  Forecast,
  ForecastComponent,
  SourceRecord,
  z,
};
