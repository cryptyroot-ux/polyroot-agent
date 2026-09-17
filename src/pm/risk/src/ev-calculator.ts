/**
 * @polyroot/risk — EV Calculator (PM-RISK-02, TABLE 11).
 *
 * Computes the exact expected value of a trade after all known costs.
 * This is the single source of truth for whether a trade has positive EV.
 *
 * Formula (per PM-RISK-02, TABLE 11):
 *   EV = p * (1 - price) - (1 - p) * price - fees
 *
 * where:
 *   p = calibrated probability of outcome
 *   price = market price (0..1 in base units: 1e6 = $1)
 *   fees = taker fee in base units
 *
 * All arithmetic is exact integer math (base units, 1e6 per $1).
 */
export class EVCalculator {
  /**
   * Compute EV in base units (1e6 = $1).
   *
   * @param probabilityYes - calibrated probability of YES (0..1, base units 1e6 = 1.0)
   * @param price - market price for the side (0..1, base units)
   * @param side - "YES" or "NO"
   * @param _feeBps - taker fee in basis points (1 bp = 0.01%)
   * @returns EV in base units (negative means unfavorable)
   */
  static calculate(
    probabilityYes: bigint,
    price: bigint,
    side: "YES" | "NO",
    feeBps: number,
  ): bigint {
    const fee = (price * BigInt(feeBps)) / 10_000n;

    if (side === "YES") {
      const pWin = probabilityYes;
      const pLose = 1_000_000n - probabilityYes;
      const winPayoff = 1_000_000n - price;
      const losePayoff = price;
      return (pWin * winPayoff - pLose * losePayoff) / 1_000_000n - fee;
    } else {
      const pLose = probabilityYes;
      const pWin = 1_000_000n - probabilityYes;
      const winPayoff = 1_000_000n - price;
      const losePayoff = price;
      return (pWin * winPayoff - pLose * losePayoff) / 1_000_000n - fee;
    }
  }

  static isPositive(
    probabilityYes: bigint,
    price: bigint,
    side: "YES" | "NO",
    feeBps: number,
  ): boolean {
    return this.calculate(probabilityYes, price, side, feeBps) > 0n;
  }
}

export interface EVCalculatorInput {
  probabilityYes: bigint;
  price: bigint;
  side: "YES" | "NO";
  feeBps: number;
}

export function evaluateEdge(input: EVCalculatorInput): bigint {
  return EVCalculator.calculate(
    input.probabilityYes,
    input.price,
    input.side,
    input.feeBps,
  );
}