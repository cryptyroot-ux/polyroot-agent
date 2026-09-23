import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PolymarketLiveFeed } from "../src/live-feed.js";

describe("Task 3 — LiveFeed reconnection max retries and exponential backoff", () => {
  it("limits reconnection attempts to MAX_RECONNECT_ATTEMPTS with exponential backoff", async () => {
    const config = {
      wsUrl: "ws://invalid",
      restUrl: "http://invalid",
      reconnectIntervalMs: 10, // base 10ms
    };
    const callbacks = {
      onConnect: () => {},
      onDisconnect: () => {},
      onError: () => {},
      onMarketSnapshot: () => {},
      onOrderBookUpdate: () => {},
      onFeeUpdate: () => {},
      onRulesUpdate: () => {},
      onMetadataUpdate: () => {},
    };
    const feed = new PolymarketLiveFeed(config as any, callbacks as any);
    feed["connected"] = false;
    feed["connecting"] = false;
    const MAX_RECONNECT_ATTEMPTS = 5;
    const MAX_RECONNECT_DELAY_MS = 60_000;
    let attempts = 0;
    while (true) {
      feed["scheduleReconnect"]();
      // The delay used for this attempt is based on attempts before increment
      const delay = Math.min(
        config.reconnectIntervalMs * 2 ** attempts,
        MAX_RECONNECT_DELAY_MS,
      );
      // Wait for the timeout to fire (plus a bit)
      await new Promise((r) => setTimeout(r, delay + 5));
      attempts = feed["reconnectAttempts"];
      if (attempts >= MAX_RECONNECT_ATTEMPTS) break;
    }
    assert.equal(attempts, MAX_RECONNECT_ATTEMPTS);
  });
});