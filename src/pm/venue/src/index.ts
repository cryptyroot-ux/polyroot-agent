/**
 * @polyroot/venue — Polymarket VenueAdapter (PM-EXE-01..08, Blueprint B10 / TABLE 15/17).
 *
 * The VenueAdapter is the **only** boundary that talks to the trading venue.
 * It accepts only typed, canonical `SignedOrder` / cancel id requests — never
 * arbitrary calldata, never a raw SDK payload improvised by the strategy layer.
 *
 * Fail-closed by construction: a `VenueActionGate` decides whether an action is
 * legal in the current venue mode **before** any network call. If the mode is
 * `CANCEL_ONLY`, `READ_ONLY`, `UNAVAILABLE` or `UNKNOWN`, new orders are
 * refused; cancels remain legal except under `READ_ONLY`/`UNAVAILABLE`. This keeps the
 * adapter deterministic and unit-testable without a live network.
 */

import type { AccountMode, VenueCapability } from "@polyroot/domain";

// Canonical adapter contract types live in types.ts (no circular runtime import
// with the concrete adapter below).
export type {
  SubmitOutcome,
  VenueAdapter,
} from "./types.js";

// Venue-mode gate, capability intersection, error taxonomy, throttling,
// recovery (PM-VENUE-01..06)
export * from "./policy.js";
export * from "./capability.js";
export * from "./polymarket-adapter.js";

// Permit store with atomic claim (PR-EXE-02, PR-OPS-02)
export * from "./permit-store.js";

// Durable recovery ledger for in-flight orders and reconciliation (PM-EXE-04/06)
export * from "./recovery-ledger.js";

// Re-export domain types used by the public surface.
export type { AccountMode, VenueCapability };
