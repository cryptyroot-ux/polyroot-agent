import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runLivePreflight,
  type LivePreflightDeps,
} from "@polyroot/runtime";

function greenDeps(over: Partial<LivePreflightDeps> = {}): LivePreflightDeps {
  return {
    queryDb: async (text: string) => {
      if (text.includes("SELECT 1")) return { rows: [{}] };
      if (text.includes("information_schema")) {
        return {
          rows: [
            "execution_permits",
            "reservations",
            "recovery_ledger",
            "seen_orders",
            "live_guard_state",
            "balance_entries",
          ].map((table_name) => ({ table_name })),
        };
      }
      if (text.includes("live_guard_state")) return { rows: [] };
      return { rows: [] };
    },
    readBounds: async () => ({ capUsd: 1000, lossCapPusd: 50 }),
    readUniverse: async () => ["12345"],
    verifyWallet: async () => ({ ok: true, detail: "3 distinct addresses" }),
    venueCredsPresent: async () => true,
    fetchBook: async () => ({ bid: 0.45, ask: 0.55 }),
    metricsKeyPresent: async () => true,
    ...over,
  };
}

function failedCheckNames(
  result: Awaited<ReturnType<typeof runLivePreflight>>,
): string[] {
  return result.checks.filter((c) => !c.ok).map((c) => c.name);
}

describe("doctor --live preflight", () => {
  it("passes when every infrastructure dependency is proven", async () => {
    const result = await runLivePreflight(greenDeps());
    assert.equal(result.ok, true);
    assert.equal(
      result.checks.every((c) => c.ok),
      true,
    );
  });

  it("refuses when the database is unreachable", async () => {
    const result = await runLivePreflight(
      greenDeps({
        queryDb: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.ok(failedCheckNames(result).includes("db-connect"));
  });

  it("refuses when a required table is missing", async () => {
    const result = await runLivePreflight(
      greenDeps({
        queryDb: async (text: string) => {
          if (text.includes("SELECT 1")) return { rows: [{}] };
          return { rows: [{ table_name: "execution_permits" }] };
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.ok(failedCheckNames(result).includes("db-schema"));
  });

  it("refuses when the owner loss cap is missing", async () => {
    const result = await runLivePreflight(
      greenDeps({ readBounds: async () => ({ capUsd: 1000 }) }),
    );
    assert.equal(result.ok, false);
    assert.ok(failedCheckNames(result).includes("bounds"));
  });

  it("refuses when the market universe is empty", async () => {
    const result = await runLivePreflight(
      greenDeps({ readUniverse: async () => [] }),
    );
    assert.equal(result.ok, false);
    assert.ok(failedCheckNames(result).includes("universe"));
  });

  it("refuses when wallet addresses collide", async () => {
    const result = await runLivePreflight(
      greenDeps({
        verifyWallet: async () => ({ ok: false, detail: "collision" }),
      }),
    );
    assert.equal(result.ok, false);
    assert.ok(failedCheckNames(result).includes("wallet"));
  });

  it("refuses when venue credentials are absent", async () => {
    const result = await runLivePreflight(
      greenDeps({ venueCredsPresent: async () => false }),
    );
    assert.equal(result.ok, false);
    assert.ok(failedCheckNames(result).includes("venue-creds"));
  });

  it("refuses when the venue book is unreadable", async () => {
    const result = await runLivePreflight(
      greenDeps({ fetchBook: async () => null }),
    );
    assert.equal(result.ok, false);
    assert.ok(failedCheckNames(result).includes("venue-read"));
  });

  it("refuses when the metrics owner key is missing", async () => {
    const result = await runLivePreflight(
      greenDeps({ metricsKeyPresent: async () => false }),
    );
    assert.equal(result.ok, false);
    assert.ok(failedCheckNames(result).includes("metrics-key"));
  });

  it("blocks (not misconfig) when the loss latch is engaged", async () => {
    const result = await runLivePreflight(
      greenDeps({
        queryDb: async (text: string) => {
          if (text.includes("SELECT 1")) return { rows: [{}] };
          if (text.includes("information_schema")) {
            return {
              rows: [
                "execution_permits",
                "reservations",
                "recovery_ledger",
                "seen_orders",
                "live_guard_state",
                "balance_entries",
              ].map((table_name) => ({ table_name })),
            };
          }
          return {
            rows: [{ halted: true, realized_loss_pusd: "75" }],
          };
        },
      }),
    );
    assert.equal(result.ok, false);
    const latch = result.checks.find((c) => c.name === "loss-latch");
    assert.ok(latch && !latch.ok);
    assert.match(latch.detail, /guard reset/);
  });
});
