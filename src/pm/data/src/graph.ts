/**
 * @polyroot/data — Market/Event Graph (PM-DATA-07).
 * Graph edge storage and native/inferred edge construction for market relationships.
 */
import { Pool, type PoolConfig } from "pg";
import type { GraphEdge, MarketSnapshot } from "@polyroot/domain";

/** Interface for graph edge persistence. */
export interface GraphEdgeStore {
  upsert(edge: GraphEdge): Promise<void>;
  getEdgesByMarket(marketId: string): Promise<GraphEdge[]>;
  getEdgesByType(relationType: GraphEdge['relation_type']): Promise<GraphEdge[]>;
  deleteMarketEdges(marketId: string): Promise<void>;
}

/** PostgreSQL implementation using the graph_edges table. */
export class PgGraphEdgeStore implements GraphEdgeStore {
  private readonly pool: Pool;

  constructor(config: PoolConfig | string | Pool) {
    this.pool =
      config instanceof Pool
        ? config
        : new Pool(
            typeof config === "string" ? { connectionString: config } : config,
          );
  }

  async upsert(edge: GraphEdge): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO graph_edges (from_market_id, to_market_id, relation_type, trust_level, confidence, provenance, graph_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (from_market_id, to_market_id, relation_type)
         DO UPDATE SET
           trust_level = EXCLUDED.trust_level,
           confidence = EXCLUDED.confidence,
           provenance = EXCLUDED.provenance,
           graph_version = EXCLUDED.graph_version,
           created_at = now()`,
        [
          edge.from_market_id,
          edge.to_market_id,
          edge.relation_type,
          edge.trust_level,
          edge.confidence ?? null,
          edge.provenance,
          'v0',
        ]
      );
    } finally {
      client.release();
    }
  }

  async getEdgesByMarket(marketId: string): Promise<GraphEdge[]> {
    const result = await this.pool.query(
      `SELECT from_market_id, to_market_id, relation_type, trust_level, confidence, provenance
       FROM graph_edges
       WHERE from_market_id = $1 OR to_market_id = $1`,
      [marketId]
    );
    return result.rows.map(row => ({
      schema_version: '1.0.0',
      from_market_id: row.from_market_id,
      to_market_id: row.to_market_id,
      relation_type: row.relation_type,
      trust_level: row.trust_level,
      confidence: row.confidence !== null ? parseFloat(row.confidence) : undefined,
      provenance: row.provenance,
    }));
  }

  async getEdgesByType(relationType: GraphEdge['relation_type']): Promise<GraphEdge[]> {
    const result = await this.pool.query(
      `SELECT from_market_id, to_market_id, relation_type, trust_level, confidence, provenance
       FROM graph_edges
       WHERE relation_type = $1`,
      [relationType]
    );
    return result.rows.map(row => ({
      schema_version: '1.0.0',
      from_market_id: row.from_market_id,
      to_market_id: row.to_market_id,
      relation_type: row.relation_type,
      trust_level: row.trust_level,
      confidence: row.confidence !== null ? parseFloat(row.confidence) : undefined,
      provenance: row.provenance,
    }));
  }

  async deleteMarketEdges(marketId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM graph_edges WHERE from_market_id = $1 OR to_market_id = $1`,
      [marketId]
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Factory function for creating PgGraphEdgeStore. */
export function createPgGraphEdgeStore(config: PoolConfig | string | Pool): PgGraphEdgeStore {
  return new PgGraphEdgeStore(config);
}

/** Builder for native and inferred graph edges from market snapshots. */
export class GraphBuilder {
  constructor(private store: GraphEdgeStore) {}

  /**
   * Build native edges from Polymarket market snapshots.
   * - NATIVE_NEG_RISK: markets sharing event_id + condition_id where is_neg_risk=true
   * - NATIVE_EVENT_MEMBER: all markets sharing event_id
   */
  async buildNativeEdges(markets: MarketSnapshot[]): Promise<void> {
    // Group by event_id + condition_id for NATIVE_NEG_RISK
    const negRiskGroups = new Map<string, MarketSnapshot[]>();
    // Group by event_id for NATIVE_EVENT_MEMBER
    const eventGroups = new Map<string, MarketSnapshot[]>();

    for (const market of markets) {
      const negRiskKey = `${market.event_id}:${market.condition_id ?? ''}`;
      if (market.is_neg_risk) {
        const group = negRiskGroups.get(negRiskKey) ?? [];
        group.push(market);
        negRiskGroups.set(negRiskKey, group);
      }

      const eventGroup = eventGroups.get(market.event_id) ?? [];
      eventGroup.push(market);
      eventGroups.set(market.event_id, eventGroup);
    }

    // Create NATIVE_NEG_RISK edges (bidirectional within same condition)
    for (const [, group] of negRiskGroups) {
      if (group.length >= 2) {
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            const m1 = group[i];
            const m2 = group[j];
            if (!m1 || !m2) continue;
            // Create bidirectional edges
            await this.store.upsert({
              schema_version: '1.0.0',
              from_market_id: m1.market_id,
              to_market_id: m2.market_id,
              relation_type: 'NATIVE_NEG_RISK',
              trust_level: 'VERIFIED_PLATFORM',
              provenance: `polymarket:event:${m1.event_id}:condition:${m1.condition_id ?? ''}`,
            });
            await this.store.upsert({
              schema_version: '1.0.0',
              from_market_id: m2.market_id,
              to_market_id: m1.market_id,
              relation_type: 'NATIVE_NEG_RISK',
              trust_level: 'VERIFIED_PLATFORM',
              provenance: `polymarket:event:${m1.event_id}:condition:${m1.condition_id ?? ''}`,
            });
          }
        }
      }
    }

    // Create NATIVE_EVENT_MEMBER edges (all markets in same event)
    for (const [eventId, group] of eventGroups) {
      if (group.length >= 2) {
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            const m1 = group[i];
            const m2 = group[j];
            if (!m1 || !m2) continue;
            // Create bidirectional edges
            await this.store.upsert({
              schema_version: '1.0.0',
              from_market_id: m1.market_id,
              to_market_id: m2.market_id,
              relation_type: 'NATIVE_EVENT_MEMBER',
              trust_level: 'VERIFIED_PLATFORM',
              provenance: `polymarket:event:${eventId}`,
            });
            await this.store.upsert({
              schema_version: '1.0.0',
              from_market_id: m2.market_id,
              to_market_id: m1.market_id,
              relation_type: 'NATIVE_EVENT_MEMBER',
              trust_level: 'VERIFIED_PLATFORM',
              provenance: `polymarket:event:${eventId}`,
            });
          }
        }
      }
    }
  }

  /**
   * Infer edges from market data patterns.
   * Returns inferred edges but does not persist them.
   * Caller decides which to upsert.
   */
  async inferEdges(_markets: MarketSnapshot[]): Promise<GraphEdge[]> {
    const edges: GraphEdge[] = [];

    // COMPLEMENT: sum of outcome probabilities ≈ 1 (YES + NO prices)
    // MUTUALLY_EXCLUSIVE: same event, different outcomes
    // CONDITIONAL: temporal dependencies
    // CORRELATED: statistical correlation > threshold

    // Placeholder for future implementation
    return edges;
  }
}