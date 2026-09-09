/**
 * @polyroot/venue — Polymarket venue adapter (wraps @polymarket/client)
 *
 * Exports:
 * - VenueAdapter: unified interface for read/write
 * - ClobAdapter: wraps ClobClient
 * - NegRiskAdapter: wraps NegRiskClient
 */

export { VenueAdapter } from "./adapters/venue";
export { ClobAdapter } from "./adapters/clob";
export { NegRiskAdapter } from "./adapters/negrisk";
