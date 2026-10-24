import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyAttestedCredit,
  assessFunderCash,
  balancesFromRow,
  planAttestedCredit,
  usdToBase,
  type CashQuery,
} from "@polyroot/risk";

class FakeCash implements CashQuery {
  available: bigint | null = null;
  committed = 0n;
  events: Array<Record<string, unknown>> = [];
  writes = 0;

  async query(
    text: string,
    params?: unknown[],
  ): Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount: number | null;
  }> {
    if (text.includes("SELECT")) {
      if (this.available === null) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            available_base: this.available.toString(),
            committed_base: this.committed.toString(),
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("INSERT INTO balance_entries")) {
      this.writes += 1;
      this.available = BigInt(String(params?.[1] ?? "0"));
      this.committed = 0n;
      return {
        rows: [
          {
            available_base: this.available.toString(),
            committed_base: "0",
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("UPDATE balance_entries")) {
      this.writes += 1;
      this.available = BigInt(String(params?.[2] ?? "0"));
      return {
        rows: [
          {
            available_base: this.available.toString(),
            committed_base: this.committed.toString(),
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes("kernel_events")) {
      this.events.push(
        JSON.parse(String(params?.[1])) as Record<string, unknown>,
      );
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected sql: ${text}`);
  }
}

describe("funder cash guard", () => {
  it("refuses a missing row and a zero row, and accepts positive cash", () => {
    const missing = assessFunderCash(null);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, "FUNDER_CASH_MISSING");
    const zero = assessFunderCash({ availableBase: 0n, committedBase: 0n });
    assert.equal(zero.ok, false);
    if (!zero.ok) assert.equal(zero.code, "FUNDER_CASH_UNFUNDED");
    const funded = assessFunderCash({
      availableBase: 1n,
      committedBase: 0n,
    });
    assert.equal(funded.ok, true);
    assert.equal(balancesFromRow({ available_base: "1.5" }), null);
    assert.equal(usdToBase("50.25"), 50_250_000n);
    assert.equal(usdToBase("-1"), null);
    assert.equal(usdToBase("1e2"), null);
  });

  it("inserts an attested credit once and refuses a decrease", async () => {
    const db = new FakeCash();
    const inserted = await applyAttestedCredit(db, {
      account: "0xFUNDER",
      amountUsd: "50",
      source: "polymarket portfolio 2026-10-24",
    });
    assert.equal(inserted.ok, true);
    if (inserted.ok) {
      assert.equal(inserted.action, "insert");
      assert.equal(inserted.totalBase, 50_000_000n);
    }
    assert.equal(db.events.length, 1);
    assert.equal(
      db.events[0]?.["note"],
      "owner attestation, not a chain balance read",
    );

    const again = await applyAttestedCredit(db, {
      account: "0xFUNDER",
      amountUsd: "50",
      source: "polymarket portfolio 2026-10-24",
    });
    assert.equal(again.ok, true);
    if (again.ok) assert.equal(again.action, "noop");

    const lower = planAttestedCredit({
      amountUsd: "10",
      source: "polymarket portfolio 2026-10-24",
      existing: { availableBase: 50_000_000n, committedBase: 0n },
    });
    assert.equal(lower.ok, false);
    if (!lower.ok) assert.equal(lower.code, "CREDIT_WOULD_DECREASE");

    const invented = planAttestedCredit({
      amountUsd: "0",
      source: "polymarket portfolio 2026-10-24",
      existing: null,
    });
    assert.equal(invented.ok, false);
    const noSource = planAttestedCredit({
      amountUsd: "10",
      source: "ui",
      existing: null,
    });
    assert.equal(noSource.ok, false);
    if (!noSource.ok) assert.equal(noSource.code, "CREDIT_SOURCE_REQUIRED");
  });
});
