import type { BigInt } from "@polyroot/types";
export interface BudgetReservation {
  account: string;
  domain: string;
  amount: bigint;
  capacityUsd: bigint;
  consumed: bigint;
  released: bigint;
  policyVersion: string;
}

export interface BudgetConstraint {
  account: string;
  domain: string;
  maxNotionalBase: bigint;
  capacityUsd: bigint;
}

export interface BudgetAccountResult {
  ok: boolean;
  code?: string;
  reason?: string;
  effectiveBudget: bigint;
  effectiveCapacity: bigint;
}
