/**
 * @polyroot/strategy — StrategyRegistry implementation for managing qualified strategies.
 */
import type { StrategyProposal, TradeIntent } from "@polyroot/domain";

export interface StrategyDefinition {
  name: string;
  version: string;
  qualifiedForMode: ("PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE")[];
  run: (input: any) => Promise<StrategyProposal | StrategyProposal[] | null>;
}

export class StrategyRegistry {
  private readonly strategies = new Map<string, StrategyDefinition>();

  register(def: StrategyDefinition): void {
    const key = `${def.name}@${def.version}`;
    this.strategies.set(key, def);
  }

  get(name: string, version: string): StrategyDefinition | undefined {
    return this.strategies.get(`${name}@${version}`);
  }

  listQualified(mode: "PAPER" | "SHADOW" | "MICRO_LIVE" | "LIVE"): StrategyDefinition[] {
    const result: StrategyDefinition[] = [];
    for (const def of this.strategies.values()) {
      if (def.qualifiedForMode.includes(mode)) {
        result.push(def);
      }
    }
    return result;
  }
}
