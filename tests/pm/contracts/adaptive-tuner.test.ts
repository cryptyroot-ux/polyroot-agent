/**
 * @polyroot/strategy — Adaptive Parameter Tuner Tests (PR-AUT-07).
 *
 * Verifies bounded adaptation inside a safe envelope, statistical gating,
 * pinning of hard parameters, and full audit trail.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  proposeAdaptation,
  applyAdaptation,
  bootstrapParameterState,
  createStandardEnvelope,
  DEFAULT_ADAPTIVE_TUNER_CONFIG,
  type ParameterState,
  type ParameterEnvelope,
} from "@polyroot/strategy";
import { DEFAULT_RISK_POLICY, type RiskPolicy } from "@polyroot/domain";

const config = {
  ...DEFAULT_ADAPTIVE_TUNER_CONFIG,
  require_significance: true,
  significance_threshold: 0.05,
};

function makeEnvelope(
  over: Partial<ParameterEnvelope> = {},
): ParameterEnvelope {
  return {
    envelope_id: "env_test",
    envelope_version: "1.0.0",
    created_at: new Date("2026-01-01T00:00:00Z"),
    allowed_ranges: {
      max_order_pct: { min: 0.001, max: 0.01 },
      max_market_pct: { min: 0.005, max: 0.05 },
      min_edge_after_cost: { min: 0.005, max: 0.05 },
    },
    max_step_pct: 0.1,
    pinned_params: ["capital_usd_cap", "max_open_orders"],
    min_data_points: 10,
    ...over,
  };
}

function makeState(over: Partial<ParameterState> = {}): ParameterState {
  return {
    state_id: "state_test",
    envelope_id: "env_test",
    envelope_version: "1.0.0",
    values: {
      max_order_pct: 0.005,
      max_market_pct: 0.02,
      min_edge_after_cost: 0.03,
    },
    updated_at: new Date("2026-01-01T00:00:00Z"),
    updated_by: "SYSTEM_BOOTSTRAP",
    ...over,
  };
}

describe("PR-AUT-07 — Adaptive parameter tuner (bounded, audited, non-self-weakening)", () => {
  it("bootstrap creates a state from the envelope with pinned params protected", () => {
    const policy: RiskPolicy = {
      ...DEFAULT_RISK_POLICY,
      capital_usd_cap: 10_000,
    };
    const env = makeEnvelope();
    const state = bootstrapParameterState(policy, env);

    // All envelope params present
    for (const p of Object.keys(env.allowed_ranges)) {
      assert.ok(state.values[p] !== undefined, `param ${p} missing`);
    }
    // Values within envelope bounds
    for (const [p, range] of Object.entries(env.allowed_ranges)) {
      const v = state.values[p]!;
      assert.ok(
        v >= range.min && v <= range.max,
        `param ${p}=${v} out of [${range.min}, ${range.max}]`,
      );
    }
  });

  it("accepts a statistically significant in-envelope proposal", async () => {
    const env = makeEnvelope();
    const state = makeState();
    const res = await proposeAdaptation(
      state,
      env,
      [
        {
          parameter_name: "max_order_pct",
          sample_mean: 0.0046, // below current 0.005 → tighten
          sample_std: 0.001,
          sample_count: 50,
          p_value: 0.01, // significant
          effect_size: 0.1,
        },
      ],
      config,
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.proposal.status, "PENDING");
      assert.ok(
        res.proposal.proposed_values.max_order_pct! < 0.005,
        "should tighten",
      );
      // Within step limit: |delta| <= 10% * current
      const delta = Math.abs(
        res.proposal.proposed_values.max_order_pct! - 0.005,
      );
      assert.ok(
        delta <= 0.005 * env.max_step_pct,
        `delta ${delta} exceeds step limit`,
      );
      // New state reflects proposal
      assert.equal(
        res.new_state.values.max_order_pct,
        res.proposal.proposed_values.max_order_pct,
      );
    }
  });

  it("rejects statistically insignificant proposals (non-significant p-value)", async () => {
    const env = makeEnvelope();
    const state = makeState();
    const res = await proposeAdaptation(
      state,
      env,
      [
        {
          parameter_name: "max_order_pct",
          sample_mean: 0.0046,
          sample_std: 0.001,
          sample_count: 50,
          p_value: 0.4, // not significant
          effect_size: 0.1,
        },
      ],
      config,
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "NO_VALID_PROPOSALS");
  });

  it("never adapts pinned hard parameters (capital cap, max open orders)", async () => {
    const env = makeEnvelope({
      pinned_params: ["capital_usd_cap", "max_open_orders"],
      allowed_ranges: {
        ...makeEnvelope().allowed_ranges,
        capital_usd_cap: { min: 1000, max: 100000 },
        max_open_orders: { min: 1, max: 20 },
      },
    });
    const state = makeState({
      values: {
        ...makeState().values,
        capital_usd_cap: 10000,
        max_open_orders: 10,
      },
    });

    const res = await proposeAdaptation(
      state,
      env,
      [
        {
          parameter_name: "capital_usd_cap",
          sample_mean: 50000,
          sample_std: 1000,
          sample_count: 100,
          p_value: 0.001,
          effect_size: 1,
        },
        {
          parameter_name: "max_open_orders",
          sample_mean: 3,
          sample_std: 1,
          sample_count: 100,
          p_value: 0.001,
          effect_size: 1,
        },
        {
          parameter_name: "min_edge_after_cost",
          sample_mean: 0.031,
          sample_std: 0.001,
          sample_count: 100,
          p_value: 0.02,
          effect_size: 0.5,
        },
      ],
      config,
    );
    // Must not propose changes to pinned params
    assert.equal(res.ok, true);
    if (res.ok) {
      const proposedKeys = Object.keys(res.proposal.proposed_values);
      assert.ok(
        !proposedKeys.includes("capital_usd_cap"),
        "capital_usd_cap must be pinned",
      );
      assert.ok(
        !proposedKeys.includes("max_open_orders"),
        "max_open_orders must be pinned",
      );
    }
  });

  it("rejects proposals that exceed the step limit", async () => {
    const env = makeEnvelope({ max_step_pct: 0.05 }); // tiny step
    const state = makeState();
    const res = await proposeAdaptation(
      state,
      env,
      [
        {
          parameter_name: "max_order_pct",
          sample_mean: 0.002, // way below current 0.005
          sample_std: 0.001,
          sample_count: 100,
          p_value: 0.001,
          effect_size: 1,
        },
      ],
      config,
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      // Clamped to step limit: 5% of 0.005 = 0.00025
      const expected = 0.005 - 0.005 * 0.05;
      assert.ok(
        Math.abs(res.proposal.proposed_values.max_order_pct! - expected) < 1e-6,
      );
    }
  });

  it("rejects proposals with insufficient data points", async () => {
    const env = makeEnvelope({ min_data_points: 100 });
    const state = makeState();
    const res = await proposeAdaptation(
      state,
      env,
      [
        {
          parameter_name: "max_order_pct",
          sample_mean: 0.004,
          sample_std: 0.001,
          sample_count: 5,
          p_value: 0.01,
          effect_size: 0.2,
        },
      ],
      config,
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "NO_VALID_PROPOSALS");
  });

  it("applyAdaptation records full audit trail with old/new values", async () => {
    const proposal = {
      proposal_id: "prop_1",
      state_id: "state_test",
      envelope_id: "env_test",
      envelope_version: "1.0.0",
      current_values: { max_order_pct: 0.005 },
      proposed_values: { max_order_pct: 0.0045 },
      rationale: "test",
      evidence_refs: ["e1"],
      proposed_at: new Date("2026-01-01T00:01:00Z"),
      status: "ACCEPTED" as const,
    };
    const state = makeState();
    const { new_state, audit_entries } = applyAdaptation(
      proposal,
      state,
      "owner_1",
    );

    assert.equal(new_state.values.max_order_pct, 0.0045);
    assert.ok(audit_entries.length === 1);
    assert.equal(audit_entries[0].parameter_name, "max_order_pct");
    assert.equal(audit_entries[0].old_value, 0.005);
    assert.equal(audit_entries[0].new_value, 0.0045);
    assert.equal(audit_entries[0].within_envelope, true);
    assert.ok(audit_entries[0].timestamp instanceof Date);
  });

  it("cannot apply a non-accepted proposal", () => {
    const proposal = {
      proposal_id: "prop_2",
      state_id: "state_test",
      envelope_id: "env_test",
      envelope_version: "1.0.0",
      current_values: { max_order_pct: 0.005 },
      proposed_values: { max_order_pct: 0.0045 },
      rationale: "test",
      evidence_refs: [],
      proposed_at: new Date(),
      status: "PENDING" as const,
    };
    const state = makeState();
    assert.throws(
      () => applyAdaptation(proposal, state, "owner_1"),
      /non-accepted/,
    );
  });

  it("hard policy cannot self-weaken: proposal outside envelope is impossible", async () => {
    // Even a "significant" signal cannot push a param outside its envelope range.
    const env = makeEnvelope({
      allowed_ranges: { max_order_pct: { min: 0.005, max: 0.01 } }, // floor = current
      max_step_pct: 0.5,
    });
    const state = makeState({
      values: { ...makeState().values, max_order_pct: 0.005 },
    });
    const res = await proposeAdaptation(
      state,
      env,
      [
        {
          parameter_name: "max_order_pct",
          sample_mean: 0.001,
          sample_std: 0.001,
          sample_count: 100,
          p_value: 0.001,
          effect_size: 1,
        },
      ],
      config,
    );
    if (res.ok) {
      // Cannot go below floor 0.005
      assert.ok(res.proposal.proposed_values.max_order_pct! >= 0.005);
    }
  });
});
