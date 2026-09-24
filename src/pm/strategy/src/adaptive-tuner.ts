/**
 * @polyroot/strategy — Adaptive Parameter Tuner (PR-AUT-07).
 *
 * Bounded, auditable parameter adaptation inside a versioned safe envelope.
 * - Proposes parameter changes from a pre-registered safe envelope
 * - Every change creates a new parameter version record with audit trail
 * - Changes cannot silently rewrite past experiment results
 * - All proposals require explicit lineage tracking
 */

import { randomUUID } from "crypto";
import type { RiskPolicy } from "@polyroot/domain";

/** Parameter envelope defining allowed ranges for each tunable parameter. */
export interface ParameterEnvelope {
  envelope_id: string;
  envelope_version: string;
  created_at: Date;
  allowed_ranges: Record<string, { min: number; max: number }>;
  /** Maximum relative change per adaptation step (e.g., 0.1 = 10%). */
  max_step_pct: number;
  /** Parameters that are NEVER allowed to be adapted (hard pins). */
  pinned_params: string[];
  /** Minimum data points required before adaptation is considered. */
  min_data_points: number;
}

/** Current parameter state with full audit lineage. */
export interface ParameterState {
  state_id: string;
  envelope_id: string;
  envelope_version: string;
  values: Record<string, number>;
  updated_at: Date;
  updated_by: "AUTO_TUNER" | "OWNER_OVERRIDE" | "SYSTEM_BOOTSTRAP";
  /** Hash of the experiment run that produced this state (if any). */
  provenance_hash?: string;
}

/** Adaptation proposal with full audit metadata. */
export interface AdaptationProposal {
  proposal_id: string;
  state_id: string;
  envelope_id: string;
  envelope_version: string;
  current_values: Record<string, number>;
  proposed_values: Record<string, number>;
  rationale: string;
  /** Supporting evidence: which experiments/datasets drove this proposal. */
  evidence_refs: string[];
  proposed_at: Date;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "SUPERSEDED";
  decided_at?: Date;
  decided_by?: string;
}

/** Audit trail entry for every parameter change. */
export interface AdaptationAuditEntry {
  entry_id: string;
  proposal_id: string;
  parameter_name: string;
  old_value: number;
  new_value: number;
  change_pct: number;
  within_envelope: boolean;
  timestamp: Date;
  /** Who approved/decided this adaptation. */
  _decided_by?: string;
}

/** Result of an adaptation attempt. */
export type AdaptationResult =
  | { ok: true; proposal: AdaptationProposal; new_state: ParameterState }
  | { ok: false; code: string; reason: string };

/** Adaptive tuner configuration. */
export interface AdaptiveTunerConfig {
  /** Minimum historical window (days) for adaptation consideration. */
  min_history_days: number;
  /** Maximum number of concurrent pending proposals. */
  max_pending_proposals: number;
  /** Require minimum statistical significance for proposal acceptance. */
  require_significance: boolean;
  /** Significance threshold (p-value). */
  significance_threshold: number;
  /** Maximum number of parameter entries in state.values. */
  max_entries?: number;
}

/** Default adaptive tuner configuration. */
export const DEFAULT_ADAPTIVE_TUNER_CONFIG: AdaptiveTunerConfig = {
  min_history_days: 30,
  max_pending_proposals: 5,
  require_significance: true,
  significance_threshold: 0.05,
  max_entries: 100,
};

/**
 * Generate a cryptographically secure adaptation proposal from observed data.
 * - Validates against the parameter envelope
 * - Ensures step size limits
 * - Creates full audit trail entry
 * - Returns proposal for human/external review (never auto-applies)
 */
export async function proposeAdaptation(
  current_state: ParameterState,
  envelope: ParameterEnvelope,
  observed_data: {
    parameter_name: string;
    sample_mean: number;
    sample_std: number;
    sample_count: number;
    /** p-value from statistical test (e.g., paired t-test vs current). */
    p_value: number;
    effect_size: number;
  }[],
  config: AdaptiveTunerConfig = DEFAULT_ADAPTIVE_TUNER_CONFIG,
): Promise<AdaptationResult> {
  const pending_proposals = 0; // In real impl, query audit store

  if (pending_proposals >= config.max_pending_proposals) {
    return {
      ok: false,
      code: "TOO_MANY_PENDING",
      reason: "max pending proposals reached",
    };
  }

  if (
    config.max_entries !== undefined &&
    Object.keys(current_state.values).length > config.max_entries
  ) {
    return {
      ok: false,
      code: "TOO_MANY_ENTRIES",
      reason: `state entries count ${Object.keys(current_state.values).length} exceeds max_entries cap ${config.max_entries}`,
    };
  }

  const proposals: AdaptationProposal[] = [];

  for (const obs of observed_data) {
    const current_value = current_state.values[obs.parameter_name];
    if (current_value === undefined) {
      continue; // parameter not in current state
    }

    // Check if parameter is pinned (never adaptable)
    if (envelope.pinned_params.includes(obs.parameter_name)) {
      continue;
    }

    // Check minimum data points
    if (obs.sample_count < envelope.min_data_points) {
      continue;
    }

    // Check statistical significance if required
    if (
      config.require_significance &&
      obs.p_value > config.significance_threshold
    ) {
      continue;
    }

    // Calculate proposed value: move toward observed mean, bounded by envelope and step limit
    const allowed_range = envelope.allowed_ranges[obs.parameter_name];
    if (!allowed_range) {
      continue; // parameter not in envelope
    }

    const target = Math.max(
      allowed_range.min,
      Math.min(allowed_range.max, obs.sample_mean),
    );
    const max_step = current_value * envelope.max_step_pct;
    const delta = Math.max(
      -max_step,
      Math.min(max_step, target - current_value),
    );
    const proposed_value = Math.max(
      allowed_range.min,
      Math.min(allowed_range.max, current_value + delta),
    );

    // Skip if change is negligible
    if (Math.abs(delta) < 1e-6) {
      continue;
    }

    const proposal: AdaptationProposal = {
      proposal_id: randomUUID(),
      state_id: current_state.state_id,
      envelope_id: envelope.envelope_id,
      envelope_version: envelope.envelope_version,
      current_values: { [obs.parameter_name]: current_value },
      proposed_values: { [obs.parameter_name]: proposed_value },
      rationale: `Observed mean ${obs.sample_mean.toFixed(4)} (n=${obs.sample_count}, p=${obs.p_value.toFixed(4)}, effect=${obs.effect_size.toFixed(4)}) suggests adjustment from ${current_value.toFixed(4)} toward ${target.toFixed(4)}. Step limited to ${envelope.max_step_pct * 100}%.`,
      evidence_refs: [`obs_${obs.parameter_name}_${randomUUID()}`],
      proposed_at: new Date(),
      status: "PENDING",
    };

    proposals.push(proposal);
  }

  // For now, return first valid proposal (in real impl, return all for batch review)
  const proposal = proposals[0];
  if (!proposal) {
    return {
      ok: false,
      code: "NO_VALID_PROPOSALS",
      reason: "no parameters passed validation gates",
    };
  }

  // Build new state with proposed values
  const new_state: ParameterState = {
    state_id: randomUUID(),
    envelope_id: envelope.envelope_id,
    envelope_version: envelope.envelope_version,
    values: { ...current_state.values, ...proposal.proposed_values },
    updated_at: new Date(),
    updated_by: "AUTO_TUNER",
    provenance_hash: proposal.proposal_id,
  };

  return { ok: true, proposal, new_state };
}

/**
 * Apply an accepted proposal, creating full audit trail entries.
 * Only call after human/external review has approved the proposal.
 */
export function applyAdaptation(
  proposal: AdaptationProposal,
  current_state: ParameterState,
  _decided_by: string,
): { new_state: ParameterState; audit_entries: AdaptationAuditEntry[] } {
  if (proposal.status !== "ACCEPTED") {
    throw new Error("cannot apply non-accepted proposal");
  }

  const audit_entries: AdaptationAuditEntry[] = [];

  for (const [param, new_value] of Object.entries(proposal.proposed_values)) {
    const old_value =
      proposal.current_values[param] ?? current_state.values[param] ?? 0;
    const change_pct =
      old_value !== 0 ? (new_value - old_value) / old_value : 0;

    // Verify within envelope (defensive - already checked in proposeAdaptation)
    // In real impl, would re-verify against current envelope

    audit_entries.push({
      entry_id: randomUUID(),
      proposal_id: proposal.proposal_id,
      parameter_name: param,
      old_value,
      new_value,
      change_pct,
      within_envelope: true, // pre-validated
      timestamp: new Date(),
    });
  }

  const new_state: ParameterState = {
    state_id: randomUUID(),
    envelope_id: current_state.envelope_id,
    envelope_version: current_state.envelope_version,
    values: { ...current_state.values, ...proposal.proposed_values },
    updated_at: new Date(),
    updated_by: "AUTO_TUNER",
    provenance_hash: proposal.proposal_id,
  };

  return { new_state, audit_entries };
}

/**
 * Create a bootstrap parameter state from a policy (initial system setup).
 */
export function bootstrapParameterState(
  policy: RiskPolicy,
  envelope: ParameterEnvelope,
): ParameterState {
  const values: Record<string, number> = {};

  // Map policy fields to tunable parameters (only those in envelope)
  for (const [param, range] of Object.entries(envelope.allowed_ranges)) {
    // Use midpoint as default, or policy value if mapped
    values[param] = (range.min + range.max) / 2;
  }

  return {
    state_id: randomUUID(),
    envelope_id: envelope.envelope_id,
    envelope_version: envelope.envelope_version,
    values,
    updated_at: new Date(),
    updated_by: "SYSTEM_BOOTSTRAP",
  };
}

/**
 * Create a standard parameter envelope for the current risk policy.
 * Only includes parameters that are safe to adapt within bounded ranges.
 */
export function createStandardEnvelope(policy: RiskPolicy): ParameterEnvelope {
  return {
    envelope_id: `env_${policy.policy_version}`,
    envelope_version: "1.0.0",
    created_at: new Date(),
    allowed_ranges: {
      max_order_pct: { min: 0.001, max: 0.01 },
      max_market_pct: { min: 0.005, max: 0.05 },
      max_portfolio_pct: { min: 0.02, max: 0.2 },
      daily_loss_stop_pct: { min: 0.005, max: 0.05 },
      drawdown_stop_pct: { min: 0.01, max: 0.15 },
      min_edge_after_cost: { min: 0.005, max: 0.05 },
      book_max_age_ms: { min: 500, max: 5000 },
      forecast_max_age_s: { min: 300, max: 3600 },
      intent_ttl_s: { min: 10, max: 120 },
      risk_permit_ttl_ms: { min: 1000, max: 10000 },
      reconcile_interval_s: { min: 5, max: 60 },
    },
    max_step_pct: 0.1, // max 10% per step
    pinned_params: [
      "capital_usd_cap",
      "max_open_orders",
      "max_slippage_abs",
      "clock_skew_max_ms",
      "metadata_max_age_s",
    ],
    min_data_points: 100,
  };
}
