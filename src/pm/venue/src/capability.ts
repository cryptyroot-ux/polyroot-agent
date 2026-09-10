/**
 * @polyroot/venue — VenueAdapter capability contract (PR-EXE-02, T-PR-EXE-02).
 *
 * The canonical capability set a compliant Polymarket VenueAdapter must expose.
 * `capabilityAllows` is a fail-closed gate: any required capability that is
 * missing OR unsupported refuses the action. A second venue without its own
 * venue_gate is refused for LIVE routing (PR-GOV-02).
 */

/** The capability families a compliant adapter must expose. */
export const VENUE_CAPABILITIES: ReadonlySet<string> = new Set([
  "market_data",
  "order_submit",
  "order_cancel",
  "order_lookup",
  "fills",
  "balances",
  "heartbeat",
  "settlement",
  "venue_mode",
]);

export type CapabilityName = (typeof VENUE_CAPABILITIES extends ReadonlySet<infer T> ? T : never);

export function isRegisteredCapability(name: string): boolean {
  return VENUE_CAPABILITIES.has(name);
}

export interface CapabilityGateInput {
  /** Venue identifiers the request is routing to. */
  venues: string[];
  /** All capability names the action requires for LIVE routing. */
  requires: string[];
  /** Capabilities this adapter instance actually supports. */
  supports: ReadonlyMap<string, boolean>;
  /** Optional commission gate requirement, e.g. venue_gate must exist. */
  requiresVenueGate?: boolean;
}

export type CapabilityGateResult =
  | { ok: true; reason: string }
  | { ok: false; code: string; reason: string };

/**
 * Fail-closed live-routing gate. An unregistered capability or one that is not
 * supported is refused. If `requiresVenueGate` is set and the adapter does not
 * expose a venue_gate capability, routing is refused for that venue.
 */
export function capabilityAllows(action: string, input: CapabilityGateInput): CapabilityGateResult {
  const cap = action.toLowerCase();

  if (!isRegisteredCapability(cap)) {
    return { ok: false, code: "UNREGISTERED_CAPABILITY", reason: `${action} is not a registered venue capability` };
  }

  if (input.requiresVenueGate && !input.supports.get("venue_gate")) {
    return { ok: false, code: "VENUE_GATE_MISSING", reason: `venue ${input.venues.join(",")} lacks an approved venue gate (PR-GOV-02)` };
  }

  for (const req of input.requires) {
    if (!isRegisteredCapability(req)) {
      return { ok: false, code: "UNREGISTERED_CAPABILITY", reason: `required capability ${req} is not registered` };
    }
    if (!input.supports.get(req)) {
      return { ok: false, code: "UNSUPPORTED_CAPABILITY", reason: `capability ${req} is unsupported for ${input.venues.join(",")}` };
    }
  }

  if (!input.supports.get(cap)) {
    return { ok: false, code: "UNSUPPORTED_CAPABILITY", reason: `${action} is unsupported for ${input.venues.join(",")}` };
  }

  return { ok: true, reason: `${action} supported for ${input.venues.join(",")}` };
}

/** True when every registered capability is present and supported (G1 gate). */
export function isFullyCompliant(supports: ReadonlyMap<string, boolean>): boolean {
  for (const cap of VENUE_CAPABILITIES) {
    if (!supports.get(cap)) return false;
  }
  return true;
}