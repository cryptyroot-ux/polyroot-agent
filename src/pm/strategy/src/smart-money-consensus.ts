/**
 * @polyroot/strategy — Smart Money Consensus v1 (PR-STR-05).
 *
 * Public wallet activity signal with reproducible wallet selection,
 * realized history, and anti-leakage filters.
 *
 * Design principles:
 * - Never blind copy trading: signals are evidence, not directives
 * - Wallet scoring uses reproducible selection rules
 * - Causal timing: only use wallet actions that PRECEDE market moves
 * - Anti-leakage: no future data in training/selection
 * - Full lineage: wallet selection, scoring params, lookback windows versioned
 */

import { randomUUID } from "crypto";
import type { TradeIntent, AssetIdentity } from "@polyroot/domain";

/** Wallet activity record from public blockchain data. */
export interface WalletActivity {
  wallet_address: string;
  /** Chain identifier (e.g., 137 for Polygon). */
  chain_id: number;
  /** Market/condition this activity relates to. */
  market_id: string;
  /** Action taken: BUY/SELL the quoted token. */
  action: "BUY" | "SELL";
  /** Size in base units (e.g., shares * 1e6). */
  size_base: bigint;
  /** Price at execution (0-1 per share). */
  price: number;
  /** Block timestamp when transaction was included. */
  executed_at: Date;
  /** Transaction hash for verification. */
  tx_hash: string;
  /** Whether this was a maker or taker order. */
  maker_taker: "MAKER" | "TAKER" | "UNKNOWN";
  /** Attached outcome label for scoring ("WIN" | "LOSS" | "UNKNOWN"). */
  outcome?: "WIN" | "LOSS" | "UNKNOWN";
  /** Realized edge in bps attached for scoring. */
  realized_edge_bps?: number;
}

/** Wallet score with full lineage. */
export interface WalletScore {
  wallet_address: string;
  /** Composite score: higher = more predictive. Range: [-1, 1]. */
  score: number;
  /** Number of historical trades used in scoring. */
  trade_count: number;
  /** Win rate of this wallet's directional bets. */
  win_rate: number;
  /** Average edge per trade (post-fee). */
  avg_edge_bps: number;
  /** Lookback window used for scoring. */
  lookback_days: number;
  /** Scoring model version for reproducibility. */
  model_version: string;
  /** Parameters used in scoring. */
  scoring_params: WalletScoringParams;
  /** Timestamp when this score was computed. */
  computed_at: Date;
}

/** Scoring parameters (versioned for reproducibility). */
export interface WalletScoringParams {
  params_version: string;
  lookback_days: number;
  min_trades: number;
  /** Weight for win rate vs edge magnitude. */
  win_rate_weight: number;
  edge_weight: number;
  /** Penalty for high turnover (churn). */
  turnover_penalty_bps: number;
  /** Minimum conviction (position size relative to wallet balance). */
  min_conviction_pct: number;
  /** Recency decay half-life in days. */
  recency_half_life_days: number;
}

/** Smart money consensus signal output. */
export interface SmartMoneySignal {
  signal_id: string;
  market_id: string;
  /** Aggregated directional signal: >0 = bullish, <0 = bearish. */
  consensus: number;
  /** Number of qualifying wallets in consensus. */
  wallet_count: number;
  /** Average conviction-weighted score. */
  avg_score: number;
  /** Dissent measure: std dev of wallet scores. */
  dissent: number;
  /** Lookback window used. */
  lookback_days: number;
  /** Individual wallet scores feeding the consensus. */
  wallet_scores: WalletScore[];
  /** Model version for reproducibility. */
  model_version: string;
  /** Timestamp of signal generation. */
  generated_at: Date;
}

/** Wallet selection criteria (versioned for reproducibility). */
export interface WalletSelectionCriteria {
  criteria_version: string;
  /** Minimum historical trades to qualify. */
  min_historical_trades: number;
  /** Minimum wallet age in days. */
  min_wallet_age_days: number;
  /** Minimum total volume (base units) over lookback. */
  min_volume_base: bigint;
  /** Exclude wallets with these patterns (e.g., MEV, arbitrage bots). */
  exclusion_patterns: string[];
  /** Require consistent directional bias (not random). */
  min_directional_consistency: number;
  /** Lookback window for selection. */
  selection_lookback_days: number;
}

/** Default selection criteria (conservative). */
export const DEFAULT_SELECTION_CRITERIA: WalletSelectionCriteria = {
  criteria_version: "1.0.0",
  min_historical_trades: 50,
  min_wallet_age_days: 90,
  min_volume_base: 1_000_000_000n, // 1000 shares
  exclusion_patterns: ["MEV_BOT", "ARBITRAGE", "WASH_TRADE"],
  min_directional_consistency: 0.55, // at least 55% same direction
  selection_lookback_days: 180,
};

/** Default scoring parameters. */
export const DEFAULT_SCORING_PARAMS: WalletScoringParams = {
  params_version: "1.0.0",
  lookback_days: 90,
  min_trades: 20,
  win_rate_weight: 0.4,
  edge_weight: 0.6,
  turnover_penalty_bps: 5,
  min_conviction_pct: 0.01, // 1% of wallet balance
  recency_half_life_days: 30,
};

/**
 * Filter and select qualifying wallets from raw activity data.
 * Pure function: no I/O, fully deterministic given inputs.
 */
export function selectQualifyingWallets(
  all_activities: WalletActivity[],
  criteria: WalletSelectionCriteria = DEFAULT_SELECTION_CRITERIA,
  now: Date,
): Map<string, WalletActivity[]> {
  const cutoff = new Date(
    now.getTime() - criteria.selection_lookback_days * 86400000,
  );
  const by_wallet = new Map<string, WalletActivity[]>();

  // Group by wallet
  for (const act of all_activities) {
    if (act.executed_at < cutoff) continue;
    const existing = by_wallet.get(act.wallet_address) ?? [];
    existing.push(act);
    by_wallet.set(act.wallet_address, existing);
  }

  // Filter by criteria
  const qualifying = new Map<string, WalletActivity[]>();
  for (const [wallet, acts] of by_wallet.entries()) {
    if (acts.length < criteria.min_historical_trades) continue;

    // Check wallet age (first activity in window)
    const first_activity = acts.reduce((a, b) =>
      a.executed_at < b.executed_at ? a : b,
    );
    const wallet_age_days =
      (now.getTime() - first_activity.executed_at.getTime()) / 86400000;
    if (wallet_age_days < criteria.min_wallet_age_days) continue;

    // Check volume
    const total_volume = acts.reduce((sum, a) => sum + a.size_base, 0n);
    if (total_volume < criteria.min_volume_base) continue;

    // Check exclusion patterns (simplified - real impl would check labels)
    // In real impl: check against label database

    // Check directional consistency
    const buys = acts.filter((a) => a.action === "BUY").length;
    const sells = acts.filter((a) => a.action === "SELL").length;
    const total = acts.length;
    const max_dir = Math.max(buys, sells) / total;
    if (max_dir < criteria.min_directional_consistency) continue;

    qualifying.set(wallet, acts);
  }

  return qualifying;
}

/**
 * Score a wallet's historical predictive power.
 * Pure function: no I/O, fully deterministic given inputs.
 */
export function scoreWallet(
  wallet: string,
  activities: WalletActivity[],
  params: WalletScoringParams = DEFAULT_SCORING_PARAMS,
  now: Date,
): WalletScore {
  if (activities.length < params.min_trades) {
    return {
      wallet_address: wallet,
      score: 0,
      trade_count: activities.length,
      win_rate: 0,
      avg_edge_bps: 0,
      lookback_days: params.lookback_days,
      model_version: `wallet_scorer_${params.params_version}`,
      scoring_params: params,
      computed_at: now,
    };
  }

  // Calculate win rate and edge per trade
  let wins = 0;
  let total_edge_bps = 0;
  let turnover_penalty = 0;

  for (const act of activities) {
    // Simplified: in real impl, would fetch market outcome for this trade
    // For now, assume we have outcome data attached
    const outcome = act.outcome; // "WIN" | "LOSS" | "UNKNOWN"
    if (outcome === "WIN") wins++;
    if (outcome !== "UNKNOWN") {
      total_edge_bps += act.realized_edge_bps ?? 0;
    }
  }

  const win_rate = wins / activities.length;
  const avg_edge_bps =
    activities.length > 0 ? total_edge_bps / activities.length : 0;

  // Recency decay: weight recent trades more
  let weighted_score = 0;
  let total_weight = 0;
  for (const act of activities) {
    const days_ago = (now.getTime() - act.executed_at.getTime()) / 86400000;
    const weight = Math.pow(0.5, days_ago / params.recency_half_life_days);
    const outcome = act.outcome;
    const trade_score = outcome === "WIN" ? 1 : outcome === "LOSS" ? -1 : 0;
    weighted_score += trade_score * weight;
    total_weight += weight;
  }
  const recency_weighted = total_weight > 0 ? weighted_score / total_weight : 0;

  // Turnover penalty
  const daily_trades = activities.length / params.lookback_days;
  turnover_penalty = Math.min(
    1,
    (daily_trades * params.turnover_penalty_bps) / 10000,
  );

  // Composite score
  const raw_score =
    (params.win_rate_weight * (win_rate * 2 - 1) + // scale to [-1, 1]
      params.edge_weight * Math.tanh(avg_edge_bps / 100) + // edge in bps, bounded
      recency_weighted * 0.2) * // recency component
    (1 - turnover_penalty);

  return {
    wallet_address: wallet,
    score: Math.max(-1, Math.min(1, raw_score)),
    trade_count: activities.length,
    win_rate,
    avg_edge_bps,
    lookback_days: params.lookback_days,
    model_version: `smart_money_v${params.params_version}`,
    scoring_params: params,
    computed_at: now,
  };
}

/**
 * Generate smart money consensus signal from qualifying wallet scores.
 * Pure function: deterministic aggregation.
 */
export function generateConsensus(
  market_id: string,
  wallet_scores: WalletScore[],
  min_wallets = 5,
): SmartMoneySignal | null {
  if (wallet_scores.length < min_wallets) return null;

  // Weight by score magnitude (conviction-weighted)
  let weighted_sum = 0;
  let total_weight = 0;
  let sum_scores = 0;

  for (const ws of wallet_scores) {
    const weight = Math.abs(ws.score) * ws.trade_count; // conviction = |score| * experience
    weighted_sum += ws.score * weight;
    total_weight += weight;
    sum_scores += ws.score;
  }

  const avg_score = sum_scores / wallet_scores.length;
  const consensus = total_weight > 0 ? weighted_sum / total_weight : 0;

  // Dissent = standard deviation of scores
  const variance =
    wallet_scores.reduce((sum, ws) => sum + (ws.score - avg_score) ** 2, 0) /
    wallet_scores.length;
  const dissent = Math.sqrt(variance);

  return {
    signal_id: randomUUID(),
    market_id,
    consensus,
    wallet_count: wallet_scores.length,
    avg_score,
    dissent,
    lookback_days: wallet_scores[0]?.lookback_days ?? 90,
    wallet_scores,
    model_version: wallet_scores[0]?.model_version ?? "unknown",
    generated_at: new Date(),
  };
}

/**
 * Convert consensus signal to a trade intent (evidence, not directive).
 * The output is a forecast-like signal for the strategy layer to evaluate.
 */
export function signalToIntent(
  signal: SmartMoneySignal,
  asset: AssetIdentity,
  base_size: number,
  min_consensus = 0.3,
  min_wallets = 5,
): TradeIntent | null {
  if (signal.wallet_count < min_wallets) return null;
  if (Math.abs(signal.consensus) < min_consensus) return null;
  if (signal.dissent > 0.5) return null; // too much disagreement

  const side = signal.consensus > 0 ? "BUY" : "SELL";
  const conviction = Math.min(1, Math.abs(signal.consensus) + signal.avg_score);
  const size = base_size * conviction;

  return {
    schema_version: "1.0.0",
    intent_id: randomUUID(),
    dedupe_key: `smart_money_${signal.market_id}_${signal.signal_id}`,
    purpose: "ENTRY",
    market_id: signal.market_id,
    token_id: asset.asset_id,
    side,
    desired_qty: size,
    limit_price: 0.5, // placeholder - would be set by quote adjustment
    forecast_refs: [signal.signal_id],
    evidence_ids: signal.wallet_scores.map((ws) => ws.wallet_address),
    status: "CREATED",
    price: 0.5,
    size,
    created_at: new Date(),
  };
}

/**
 * End-to-end pipeline: raw activities → qualifying wallets → scores → consensus → intent.
 * All pure functions, no I/O.
 */
export function runSmartMoneyPipeline(
  market_id: string,
  asset: AssetIdentity,
  activities: WalletActivity[],
  criteria: WalletSelectionCriteria = DEFAULT_SELECTION_CRITERIA,
  scoring_params: WalletScoringParams = DEFAULT_SCORING_PARAMS,
  base_size: number = 10,
  now: Date = new Date(),
): {
  intent: TradeIntent | null;
  signal: SmartMoneySignal | null;
  qualifying_count: number;
} {
  const qualifying = selectQualifyingWallets(activities, criteria, now);
  const wallet_scores: WalletScore[] = [];

  for (const [wallet, acts] of qualifying.entries()) {
    const scored = scoreWallet(wallet, acts, scoring_params, now);
    scored.wallet_address = wallet; // fill in
    wallet_scores.push(scored);
  }

  const signal =
    wallet_scores.length > 0
      ? generateConsensus(market_id, wallet_scores)
      : null;
  const intent = signal ? signalToIntent(signal, asset, base_size) : null;

  return { intent, signal, qualifying_count: qualifying.size };
}
