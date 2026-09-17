/**
 * @polyroot/risk — Policy Store (PM-RISK-04).
 *
 * Simple in-memory implementation for the current active RiskPolicy.
 * The policy is the single source of truth for all risk limits.
 */

import type { RiskPolicy } from "@polyroot/domain";

export interface PolicyStore {
  /** Get the current active policy. */
  get(): Promise<import("@polyroot/domain").RiskPolicy>;
  /** Update the policy (creates new version). */
  update(policy: Partial<import("@polyroot/domain").RiskPolicy>): Promise<import("@polyroot/domain").RiskPolicy>;
}

export interface MemPolicyStoreDeps {
  initial?: Partial<import("@polyroot/domain").RiskPolicy>;
}

/**
 * In-memory implementation for testing and PAPER mode.
 */
export class MemPolicyStore {
  private policy: import("@polyroot/domain").RiskPolicy;
  private versions: Map<string, import("@polyroot/domain").RiskPolicy> = new Map();

  constructor(deps: MemPolicyStoreDeps = {}) {
    const { initial = {} } = deps;
    this.policy = {
      schema_version: "1.1",
      policy_version: `v${Date.now()}`,
      execution_mode: "PAPER",
      capital_usd_cap: 10_000,
      max_order_pct: 0.005,
      max_market_pct: 0.02,
      max_event_group_pct: 0.01,
      max_portfolio_pct: 0.1,
      daily_loss_stop_pct: 0.05,
      drawdown_stop_pct: 0.1,
      max_open_orders: 100,
      min_edge_after_cost: 0.05,
      book_max_age_ms: 60_000,
      metadata_max_age_s: 300,
      forecast_max_age_s: 300,
      clock_skew_max_ms: 5_000,
      max_slippage_abs: 0.02,
      intent_ttl_s: 60,
      risk_permit_ttl_ms: 60_000,
      reconcile_interval_s: 30,
      ...initial,
    };
    this.versions.set(this.policy.policy_version, { ...this.policy });
  }

  async get(): Promise<import("@polyroot/domain").RiskPolicy> {
    return { ...this.policy };
  }

  async update(patch: Partial<import("@polyroot/domain").RiskPolicy>): Promise<import("@polyroot/domain").RiskPolicy> {
    this.policy = {
      ...this.policy,
      ...patch,
      policy_version: `v${Date.now()}`,
    };
    this.versions.set(this.policy.policy_version, { ...this.policy });
    return { ...this.policy };
  }
}

export interface PolicyStore {
  get(): Promise<import("@polyroot/domain").RiskPolicy>;
  update(patch: Partial<import("@polyroot/domain").RiskPolicy>): Promise<import("@polyroot/domain").RiskPolicy>;
}