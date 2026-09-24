import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  proposeAdaptation,
  ParameterState,
  ParameterEnvelope,
  AdaptiveTunerConfig,
} from "../../../src/pm/strategy/src/adaptive-tuner.ts";
import type { RiskPolicy } from "@polyroot/domain";

describe("AdaptiveTuner — max-entries cap", () => {
  const makePolicy = (): RiskPolicy =>
    ({
      policy_version: "1.0.0",
      // minimal RiskPolicy fields needed for bootstrap
      // only fields used: none; we'll create envelope manually
      // Actually RiskPolicy has many fields, but we can cast
    }) as RiskPolicy;

  const baseEnvelope = (): ParameterEnvelope => ({
    envelope_id: "env_test",
    envelope_version: "1.0.0",
    created_at: new Date(),
    allowed_ranges: {
      param_a: { min: 0, max: 10 },
      param_b: { min: 0, max: 10 },
      param_c: { min: 0, max: 10 },
      param_d: { min: 0, max: 10 },
      param_e: { min: 0, max: 10 },
    },
    max_step_pct: 0.1,
    pinned_params: [],
    min_data_points: 1,
  });

  it("should reject when state values exceed maxEntries config", async () => {
    const envelope = baseEnvelope();
    const config: AdaptiveTunerConfig = {
      ...{
        min_history_days: 30,
        max_pending_proposals: 5,
        require_significance: true,
        significance_threshold: 0.05,
        max_entries: 3, // only allow 3 entries
      },
    };
    // state with 4 entries exceeds cap
    const state: ParameterState = {
      state_id: "state_1",
      envelope_id: envelope.envelope_id,
      envelope_version: envelope.envelope_version,
      values: {
        param_a: 5,
        param_b: 3,
        param_c: 7,
        param_d: 2,
      },
      updated_at: new Date(),
      updated_by: "AUTO_TUNER",
    };
    const observed_data = [
      {
        parameter_name: "param_a",
        sample_mean: 6,
        sample_std: 1,
        sample_count: 5,
        p_value: 0.01,
        effect_size: 0.5,
      },
    ];
    const res = await proposeAdaptation(state, envelope, observed_data, config);
    assert.equal(res.ok, false);
    assert.equal(res.code, "TOO_MANY_ENTRIES");
  });

  it("should allow when state values within maxEntries", async () => {
    const envelope = baseEnvelope();
    const config: AdaptiveTunerConfig = {
      ...{
        min_history_days: 30,
        max_pending_proposals: 5,
        require_significance: true,
        significance_threshold: 0.05,
        max_entries: 5,
      },
    };
    const state: ParameterState = {
      state_id: "state_2",
      envelope_id: envelope.envelope_id,
      envelope_version: envelope.envelope_version,
      values: {
        param_a: 5,
        param_b: 3,
        param_c: 7,
      },
      updated_at: new Date(),
      updated_by: "AUTO_TUNER",
    };
    const observed_data = [
      {
        parameter_name: "param_a",
        sample_mean: 6,
        sample_std: 1,
        sample_count: 5,
        p_value: 0.01,
        effect_size: 0.5,
      },
    ];
    const res = await proposeAdaptation(state, envelope, observed_data, config);
    // Should either return a proposal (if passes other gates) or NO_VALID_PROPOSALS
    // Not TOO_MANY_ENTRIES
    if (!res.ok) {
      assert.notEqual(res.code, "TOO_MANY_ENTRIES");
    }
  });
});
