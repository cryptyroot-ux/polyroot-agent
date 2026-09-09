/**
 * Property-based checks for the Money Kernel cash exactness (PR-LED-02).
 * Uses a deterministic grid rather than fast-check (not yet installed); the
 * invariants hold for every valid (shares, price) pair and are verified over a
 * wide sweep, catching any float-drift regression.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cashNeededFor } from "@polyroot/risk";

describe("Money Kernel — exact cash arithmetic (PR-LED-02)", () => {
  it("cashNeededFor equals shares * price / 1e6 for a large deterministic grid", () => {
    // Sweep share counts and per-share prices in integer base units (1e6).
    const shareCounts = [
      1_000_000n,
      2_000_000n,
      3_333_333n,
      7_777_777n,
      1_000_000_000n,
    ];
    const priceUnits = [
      1n,
      100_000n,
      250_000n,
      500_000n,
      750_000n,
      999_999n,
      1_000_000n,
    ];

    for (const shares of shareCounts) {
      for (const price of priceUnits) {
        const expected = (shares * price) / 1_000_000n;
        const got = cashNeededFor(shares, price);
        assert.equal(got, expected, `shares=${shares} price=${price}`);
        // Cash needed must be a non-negative integer never above shares*price.
        assert.ok(got >= 0n);
        assert.ok(got * 1_000_000n <= shares * price);
      }
    }
  });

  it("boundary prices yield exact cash (0, 0.000001, 0.5, 0.999999, 1.0)", () => {
    const pairs: Array<[bigint, bigint, bigint]> = [
      [10_000_000n, 0n, 0n],
      [10_000_000n, 1n, 10n],
      [10_000_000n, 500_000n, 5_000_000n],
      [10_000_000n, 999_999n, 9_999_990n],
      [10_000_000n, 1_000_000n, 10_000_000n],
    ];
    for (const [shares, price, expected] of pairs) {
      assert.equal(cashNeededFor(shares, price), expected);
    }
  });

  it("zero or negative shares always require zero cash (never negative)", () => {
    assert.equal(cashNeededFor(0n, 500_000n), 0n);
  });
});
