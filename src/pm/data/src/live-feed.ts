import WebSocket from "ws";
import type {
  MarketSnapshot,
  MarketFeeSettings,
  OrderBookFrame,
  SettlementRule,
  VenueMode,
} from "./index.js";
import {
  OrderBook,
  FeeGate,
  SettlementRulesRegistry,
  UniverseLog,
} from "./index.js";

/** Minimal ErrorEvent type for WebSocket error handler (Node.js doesn't have DOM types). */
interface ErrorEvent extends Event {
  error?: unknown;
  message: string;
  filename?: string;
  lineno?: number;
  colno?: number;
}

/* ─── Configuration ──────────────────────────────────────────────────────── */

export interface LiveFeedConfig {
  /** Polymarket CLOB WebSocket URL. */
  wsUrl: string;
  /** Polymarket REST API base URL. */
  restUrl: string;
  /** Markets to subscribe to (empty = all active). */
  marketIds?: string[];
  /** WebSocket reconnect interval (ms). */
  reconnectIntervalMs?: number;
  /** REST polling interval for metadata (ms). */
  metadataPollIntervalMs?: number;
  /** Maximum message age before stale (ms). */
  maxMessageAgeMs?: number;
  /** Chain ID for asset parsing. */
  chainId?: number;
}

const DEFAULT_CONFIG: Required<LiveFeedConfig> = {
  wsUrl: "wss://clob.polymarket.com/ws",
  restUrl: "https://clob.polymarket.com",
  marketIds: [],
  reconnectIntervalMs: 5000,
  metadataPollIntervalMs: 60_000,
  maxMessageAgeMs: 30_000,
  chainId: 137,
};

/* ─── Types ──────────────────────────────────────────────────────────────── */

export interface MarketMetadata {
  market_id: string;
  event_id: string;
  question: string;
  condition_id: string;
  collateral: string;
  rules_hash: string;
  neg_risk: boolean;
  fee_rate_bps: number;
  minimum_order_size: number;
  tick_size: number;
  status: string;
  clob_token_ids: string[];
  end_date_iso?: string;
}

export interface LiveFeedCallbacks {
  onMarketSnapshot: (snapshot: MarketSnapshot) => void;
  onOrderBookUpdate: (marketId: string, frame: OrderBookFrame) => void;
  onFeeUpdate: (settings: MarketFeeSettings) => void;
  onRulesUpdate: (rule: SettlementRule) => void;
  onMetadataUpdate: (metadata: MarketMetadata) => void;
  onError: (error: Error, context: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

/* ─── Live Feed Class ────────────────────────────────────────────────────── */

export class PolymarketLiveFeed {
  private readonly config: Required<LiveFeedConfig>;
  private readonly callbacks: LiveFeedCallbacks;

  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private metadataPollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly orderBooks = new Map<string, OrderBook>();
  private readonly feeGate = new FeeGate();
  private readonly rulesRegistry = new SettlementRulesRegistry();
  private readonly universeLog = new UniverseLog();
  private readonly seenMarketIds = new Set<string>();

  private connecting = false;
  private connected = false;

  constructor(config: LiveFeedConfig, callbacks: LiveFeedCallbacks) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.callbacks = callbacks;
  }

  /** Start the live feed (WebSocket + metadata polling). */
  async start(): Promise<void> {
    if (this.connecting || this.connected) return;
    this.connecting = true;

    try {
      await this.connectWebSocket();
      this.startMetadataPolling();
      this.connected = true;
      this.connecting = false;
      this.callbacks.onConnect?.();
    } catch (err) {
      this.connecting = false;
      this.callbacks.onError?.(err as Error, "start");
      throw err;
    }
  }

  /** Stop the live feed. */
  stop(): void {
    this.connected = false;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.metadataPollTimer) {
      clearInterval(this.metadataPollTimer);
      this.metadataPollTimer = null;
    }
    this.callbacks.onDisconnect?.();
  }

  /** Get current market snapshot (from order book + metadata). */
  getSnapshot(marketId: string): MarketSnapshot | undefined {
    const book = this.orderBooks.get(marketId);
    if (!book || !book.ready()) return undefined;

    return {
      schema_version: "1.0.0",
      market_id: marketId,
      event_id: "",
      condition_id: "",
      question: "",
      chain_id: this.config.chainId,
      collateral: "pUSD",
      rules_hash: "",
      fee_maker_bps: 0,
      fee_taker_bps: 0,
      tick_size: 0,
      min_size: 1,
      status: "ACTIVE",
      is_neg_risk: false,
      venue_mode: "NORMAL",
      yes_price: book.bestBid(),
      no_price: book.bestAsk(),
      source_at: new Date(),
      received_at: new Date(),
    };
  }

  /** Get current fee settings for a market. */
  getFeeSettings(marketId: string) {
    return this.feeGate.requireCurrent(marketId);
  }

  /** Get current settlement rules for a market. */
  getSettlementRule(marketId: string, pinnedVersion: string) {
    return this.rulesRegistry.check(marketId, pinnedVersion);
  }

  /** Get all known market IDs. */
  getKnownMarkets(): string[] {
    return Array.from(this.seenMarketIds);
  }

  /** Check if feed is connected. */
  isConnected(): boolean {
    return this.connected;
  }

  /* ─── Private Methods ─────────────────────────────────────────────────── */

  private async connectWebSocket(): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      this.ws = new WebSocket(this.config.wsUrl);

      this.ws.onopen = () => {
        this.connected = true;
        this.callbacks.onConnect?.();

        if (this.config.marketIds.length > 0) {
          for (const marketId of this.config.marketIds) {
            this.subscribeToMarket(marketId);
          }
        } else {
          this.ws?.send(JSON.stringify({ type: "subscribe", channel: "book" }));
        }
      };

      this.ws.onmessage = (event: WebSocket.MessageEvent) => {
        try {
          const data = JSON.parse(event.data.toString());
          this.handleMessage(data);
        } catch (err) {
          this.callbacks.onError?.(err as Error, "ws_message");
        }
      };

      this.ws.onerror = ((err: unknown) => {
        this.callbacks.onError?.(err as Error, "ws_error");
      }) as (event: import("ws").ErrorEvent) => void;

      this.ws.onclose = () => {
        this.connected = false;
        this.callbacks.onDisconnect?.();
        this.scheduleReconnect();
      };

      const timeout = setTimeout(() => {
        if (!this.connected) {
          this.ws?.close();
          rejectPromise(new Error("WebSocket connection timeout"));
        }
      }, 10_000);

      const cleanup = () => clearTimeout(timeout);
      resolvePromise = () => { cleanup(); resolvePromise = () => {}; };
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.connected && !this.connecting) {
        this.connectWebSocket().catch((err) =>
          this.callbacks.onError?.(err, "reconnect"),
        );
      }
    }, this.config.reconnectIntervalMs);
  }

  private subscribeToMarket(marketId: string): void {
    this.ws?.send(
      JSON.stringify({
        type: "subscribe",
        channel: "book",
        market_id: marketId,
      }),
    );
  }

  private startMetadataPolling(): void {
    this.pollMetadata();

    this.metadataPollTimer = setInterval(() => {
      this.pollMetadata().catch((err) =>
        this.callbacks.onError?.(err, "metadata_poll"),
      );
    }, this.config.metadataPollIntervalMs);
  }

  private async pollMetadata(): Promise<void> {
    try {
      const response = await fetch(`${this.config.restUrl}/markets`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = (await response.json()) as { data?: Record<string, unknown>[] } | Record<string, unknown>[];
      const markets = Array.isArray(data) ? data : (data.data ?? []);

      for (const market of markets) {
        this.processMarketMetadata(market);
      }
    } catch (err) {
      this.callbacks.onError?.(err as Error, "poll_metadata");
    }
  }

  private processMarketMetadata(market: Record<string, unknown>): void {
    const marketId = (market["condition_id"] ?? market["market_id"] ?? market["id"]) as string;
    if (!marketId) return;

    this.seenMarketIds.add(marketId);

    const endDateIso = market["end_date_iso"] as string | undefined;
    const metadata: MarketMetadata = {
      market_id: marketId,
      event_id: (market["event_id"] as string) ?? "",
      question: (market["question"] as string) ?? marketId,
      condition_id: (market["condition_id"] as string) ?? marketId,
      collateral: (market["collateral"] as string) ?? "pUSD",
      rules_hash: (market["rules_hash"] as string) ?? "",
      neg_risk: (market["neg_risk"] as boolean) ?? false,
      fee_rate_bps: (market["fee_rate_bps"] as number) ?? 0,
      minimum_order_size: (market["minimum_order_size"] as number) ?? 1,
      tick_size: (market["tick_size"] as number) ?? 0,
      status: (market["status"] as string) ?? "ACTIVE",
      clob_token_ids: (market["clob_token_ids"] as string[]) ?? [],
    };
    if (endDateIso !== undefined) {
      metadata.end_date_iso = endDateIso;
    }

    const feeSettings: MarketFeeSettings = {
      market_id: marketId,
      schema_version: "1.0.0",
      fee_maker_bps: 0,
      fee_taker_bps: metadata.fee_rate_bps,
      fee_currency: "pUSD",
      tick_size: metadata.tick_size,
      min_size: metadata.minimum_order_size,
      trade_mode: this.mapMarketTypeToTradeMode(metadata.neg_risk),
      fee_settings_hash: "",
      observed_at: new Date(),
    };
    this.feeGate.observe(feeSettings);
    this.callbacks.onFeeUpdate?.(feeSettings);

    const rule: SettlementRule = {
      schema_version: "1.0.0",
      market_id: marketId,
      rule_version: metadata.rules_hash ?? "1.0.0",
      resolution_source: "POLYMARKET",
      resolves_at_utc: metadata.end_date_iso ? new Date(metadata.end_date_iso) : new Date(),
      rule_text_hash: metadata.rules_hash ?? "",
      rules_text: (metadata.question as string) ?? "",
      active_from: new Date(),
    };
    this.rulesRegistry.upsert(rule);
    this.callbacks.onRulesUpdate?.(rule);

    const book = this.orderBooks.get(marketId);
    if (book) {
      // Book metadata updated
    }

    this.callbacks.onMetadataUpdate?.(metadata);
  }

  private mapStatusToMode(status: string): VenueMode {
    switch (status.toUpperCase()) {
      case "ACTIVE":
        return "NORMAL";
      case "POST_ONLY":
        return "POST_ONLY";
      case "CANCEL_ONLY":
        return "CANCEL_ONLY";
      case "PAUSED":
        return "READ_ONLY";
      default:
        return "UNKNOWN";
    }
  }

  private mapMarketTypeToTradeMode(negRisk: boolean): "BINARY" | "MULTI_OUTCOME" | "NEG_RISK" | "UNKNOWN" {
    if (negRisk) return "NEG_RISK";
    // Default to BINARY for standard markets
    return "BINARY";
  }

  private handleMessage(data: unknown): void {
    const obj = data as Record<string, unknown>;
    const type = (obj["type"] ?? obj["channel"] ?? "") as string;

    switch (type) {
      case "book":
      case "orderbook":
      case "book_update":
        this.handleBookUpdate(obj);
        break;
      case "trade":
      case "fill":
        this.handleTrade(obj);
        break;
      case "market":
      case "market_update":
        this.handleMarketUpdate(obj);
        break;
      default:
        break;
    }
  }

  private handleBookUpdate(data: Record<string, unknown>): void {
    const marketId = (data["market_id"] ?? data["market_id"] ?? data["asset_id"]) as string;
    if (!marketId) return;

    let book = this.orderBooks.get(marketId);
    if (!book) {
      book = new OrderBook();
      this.orderBooks.set(marketId, book);
    }

    const isDeltaVal = data["is_delta"];
    const isDelta = typeof isDeltaVal === "boolean" && isDeltaVal;
    const hasBids = Array.isArray(data["bids"]) && data["bids"].length > 0;
    const hasAsks = Array.isArray(data["asks"]) && data["asks"].length > 0;
    const isSnapshot = !isDelta && (hasBids || hasAsks);

    const frame: OrderBookFrame = {
      market_id: marketId,
      schema_version: "1.0.0",
      source_at: new Date(),
      received_at: new Date(),
      is_delta: isDelta,
      resync_required: isSnapshot,
      bids: (data["bids"] as [number, number][]) ?? [],
      asks: (data["asks"] as [number, number][]) ?? [],
    };

    try {
      book.apply(frame);
      this.callbacks.onOrderBookUpdate?.(marketId, frame);

      if (isSnapshot || (book.bestBid() !== undefined && book.bestAsk() !== undefined)) {
        const snapshot = this.getSnapshot(marketId);
        if (snapshot) {
          this.callbacks.onMarketSnapshot?.(snapshot);
        }
      }
    } catch (err) {
      this.callbacks.onError?.(err as Error, "book_apply");
    }
  }

  private handleTrade(_data: Record<string, unknown>): void {
    // Trade messages - can be used for fill tracking
  }

  private handleMarketUpdate(data: Record<string, unknown>): void {
    this.processMarketMetadata(data);
  }
}

/* ─── Factory ────────────────────────────────────────────────────────────── */

export function createLiveFeed(
  config: Partial<LiveFeedConfig>,
  callbacks: LiveFeedCallbacks,
): PolymarketLiveFeed {
  return new PolymarketLiveFeed(config as LiveFeedConfig, callbacks);
}

/* ─── Exports ────────────────────────────────────────────────────────────── */

export * from "./index.js";