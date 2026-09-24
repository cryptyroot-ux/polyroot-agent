/**
 * @polyroot/security — Decode budget guard (FT-19, PM-SEC-05).
 *
 * A huge compressed response or archive expansion ("content bomb") must abort
 * inside the isolated parser — before allocation — with a typed refusal, not
 * an OOM crash of the host. Three independent budgets:
 *
 *   compressed   — bytes received off the wire
 *   decompressed — bytes after decoding/inflation, before parsing
 *   ratio        — decompressed / compressed (zip-bomb signature)
 *
 * Pure function (no I/O): the caller measures, this contract decides.
 */

export interface DecodeBudgetInput {
  compressedBytes: number;
  decompressedBytes: number;
  maxCompressedBytes?: number;
  maxDecompressedBytes?: number;
  /** Maximum decompressed/compressed expansion ratio. */
  maxExpansionRatio?: number;
}

export type DecodeBudgetCode =
  | "CONTENT_BOMB_COMPRESSED"
  | "CONTENT_BOMB_DECOMPRESSED"
  | "CONTENT_BOMB_RATIO";

export type DecodeBudgetResult =
  { ok: true } | { ok: false; code: DecodeBudgetCode; reason: string };

export const DEFAULT_DECODE_BUDGET = {
  maxCompressedBytes: 5_000_000,
  maxDecompressedBytes: 25_000_000,
  maxExpansionRatio: 10,
} as const;

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

export function checkDecodeBudget(
  input: DecodeBudgetInput,
): DecodeBudgetResult {
  const maxCompressed =
    input.maxCompressedBytes ?? DEFAULT_DECODE_BUDGET.maxCompressedBytes;
  const maxDecompressed =
    input.maxDecompressedBytes ?? DEFAULT_DECODE_BUDGET.maxDecompressedBytes;
  const maxRatio =
    input.maxExpansionRatio ?? DEFAULT_DECODE_BUDGET.maxExpansionRatio;

  if (
    !isFiniteNonNegative(input.compressedBytes) ||
    !isFiniteNonNegative(input.decompressedBytes) ||
    !(maxCompressed > 0) ||
    !(maxDecompressed > 0) ||
    !(maxRatio > 0)
  ) {
    return {
      ok: false,
      code: "CONTENT_BOMB_DECOMPRESSED",
      reason: "invalid measurement: budgets require finite non-negative sizes",
    };
  }

  if (input.compressedBytes > maxCompressed) {
    return {
      ok: false,
      code: "CONTENT_BOMB_COMPRESSED",
      reason: `compressed ${input.compressedBytes}B exceeds budget ${maxCompressed}B`,
    };
  }
  if (input.decompressedBytes > maxDecompressed) {
    return {
      ok: false,
      code: "CONTENT_BOMB_DECOMPRESSED",
      reason: `decompressed ${input.decompressedBytes}B exceeds budget ${maxDecompressed}B`,
    };
  }
  // Ratio is only meaningful when something was actually received; a
  // zero-byte body expands to nothing and must not divide by zero.
  if (input.compressedBytes > 0) {
    const ratio = input.decompressedBytes / input.compressedBytes;
    if (ratio > maxRatio) {
      return {
        ok: false,
        code: "CONTENT_BOMB_RATIO",
        reason: `expansion ratio ${ratio.toFixed(1)}x exceeds budget ${maxRatio}x`,
      };
    }
  }
  return { ok: true };
}
