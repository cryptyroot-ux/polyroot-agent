/**
 * @polyroot/runtime — Paper trading engine + probabilistic & economic metrics +
 * experiment registry (PR-VAL-04..08, G4/G5).
 *
 * Pure logic only; no financial I/O. All fill/queue/latency models are
 * injectable so the engine stays deterministic and unit-testable.
 */
const defaultRng = Math.random;
/**
 * Deterministic-ish fill simulation: picks the touch price, applies maker/taker
 * fees, and outputs one of FILLED / PARTIAL / CANCELLED.
 */
export function simulateFill(input) {
    const r = input.rng ?? defaultRng;
    const fillPrice = input.taker ? input.ask : input.bid;
    // Cancel path (venue says no match / order lost).
    if (r() < input.cancelProbability) {
        return {
            status: "CANCELLED",
            filledSize: 0,
            fillPrice: 0,
            makerFee: 0,
            takerFee: 0,
            latencyMs: input.latencyMs,
        };
    }
    // Partial fill when the order exceeds touch depth.
    const filled = input.size <= input.depth
        ? input.size
        : Math.floor(input.size * input.partialFraction);
    if (filled <= 0) {
        return {
            status: "CANCELLED",
            filledSize: 0,
            fillPrice: 0,
            makerFee: 0,
            takerFee: 0,
            latencyMs: input.latencyMs,
        };
    }
    const notional = filled * fillPrice;
    const makerFee = input.taker
        ? 0
        : Math.round((notional * input.makerFeeBps) / 1e4);
    const takerFee = input.taker
        ? Math.round((notional * input.takerFeeBps) / 1e4)
        : 0;
    return {
        status: filled < input.size ? "PARTIAL" : "FILLED",
        filledSize: filled,
        fillPrice,
        makerFee,
        takerFee,
        latencyMs: input.latencyMs,
    };
}
export function evaluateShadowCandidate(input) {
    if (input.observedDays < input.criteria.minDays) {
        return {
            passed: false,
            reason: `baseline ${input.observedDays}d < ${input.criteria.minDays}d`,
        };
    }
    if (input.resolvedClusters < input.criteria.minResolvedClusters) {
        return {
            passed: false,
            reason: `resolved clusters ${input.resolvedClusters} < ${input.criteria.minResolvedClusters}`,
        };
    }
    return { passed: true, reason: "SHADOW baseline met" };
}
/** Brier score: mean((p - y)^2), smaller is better. */
export function brierScore(probabilities, outcomes) {
    if (probabilities.length !== outcomes.length)
        throw new Error("length mismatch");
    let s = 0;
    for (let i = 0; i < probabilities.length; i++) {
        const p = probabilities[i];
        const y = outcomes[i];
        if (p !== undefined && y !== undefined)
            s += (p - y) ** 2;
    }
    return s / probabilities.length;
}
/** Log loss with clipping to avoid -Infinity. */
export function logLoss(probabilities, outcomes) {
    if (probabilities.length !== outcomes.length)
        throw new Error("length mismatch");
    const eps = 1e-9;
    let s = 0;
    for (let i = 0; i < probabilities.length; i++) {
        const pRaw = probabilities[i];
        const y = outcomes[i];
        if (pRaw === undefined || y === undefined)
            continue;
        const p = Math.min(1 - eps, Math.max(eps, pRaw));
        s += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    }
    return s / probabilities.length;
}
/** Binned calibration error: E[| avg_fit_observed_freq - avg_predicted |] across B bins. */
export function calibrationError(probabilities, outcomes, bins = 10) {
    if (probabilities.length !== outcomes.length)
        throw new Error("length mismatch");
    let err = 0;
    let usedBins = 0;
    for (let b = 0; b < bins; b++) {
        const lo = b / bins;
        const hi = (b + 1) / bins;
        let sumPred = 0;
        let sumObs = 0;
        let cnt = 0;
        for (let i = 0; i < probabilities.length; i++) {
            const p = probabilities[i];
            const y = outcomes[i];
            if (p !== undefined && y !== undefined && p >= lo && p < hi) {
                sumPred += p;
                sumObs += y;
                cnt++;
            }
        }
        if (cnt > 0) {
            err += Math.abs(sumObs / cnt - sumPred / cnt);
            usedBins++;
        }
    }
    return usedBins === 0 ? 0 : err / usedBins;
}
/** Sharpness: mean distance-from-0.5 of predictions. */
export function sharpness(probabilities) {
    const n = probabilities.length;
    if (n === 0)
        return NaN;
    let s = 0;
    for (let i = 0; i < n; i++) {
        const p = probabilities[i];
        if (p !== undefined)
            s += Math.abs(p - 0.5);
    }
    return s / n;
}
/** Coverage: fraction of binary outcomes inside a prediction band (e.g. |p-y|<=0.25). */
export function coverage(probabilities, outcomes, band = 0.25) {
    if (probabilities.length !== outcomes.length)
        throw new Error("length mismatch");
    const n = probabilities.length;
    if (n === 0)
        return NaN;
    let hits = 0;
    for (let i = 0; i < n; i++) {
        const p = probabilities[i];
        const y = outcomes[i];
        if (p !== undefined && y !== undefined && Math.abs(p - y) <= band)
            hits++;
    }
    return hits / n;
}
/** Abstention rate: fraction of near-0.5 (uncertain) forecasts. */
export function abstentionRate(probabilities, threshold = 0.02) {
    const n = probabilities.length;
    if (n === 0)
        return NaN;
    let a = 0;
    for (const p of probabilities) {
        if (p !== undefined && Math.abs(p - 0.5) < threshold)
            a++;
    }
    return a / n;
}
export function computeProbQuality(input) {
    return {
        brier: brierScore(input.probabilities, input.outcomes),
        logLoss: logLoss(input.probabilities, input.outcomes),
        calibrationError: calibrationError(input.probabilities, input.outcomes),
        sharpness: sharpness(input.probabilities),
        coverage: coverage(input.probabilities, input.outcomes),
        abstentionRate: abstentionRate(input.probabilities),
        n: input.probabilities.length,
    };
}
/**
 * Max drawdown from an equity curve (peak-to-trough), as fraction.
 */
export function maxDrawdown(equityCurve) {
    const n = equityCurve.length;
    if (n === 0)
        return 0;
    const first = equityCurve[0] ?? 0;
    let peak = first;
    let maxDd = 0;
    for (let i = 0; i < n; i++) {
        const v = equityCurve[i];
        if (v === undefined)
            continue;
        if (v > peak)
            peak = v;
        const dd = peak > 0 ? (peak - v) / peak : 0;
        if (dd > maxDd)
            maxDd = dd;
    }
    return maxDd;
}
/** Herfindahl index over per-market PnL shares; 1 = fully concentrated. */
export function concentrationIndex(perMarketPnl) {
    const total = perMarketPnl.reduce((a, b) => a + b, 0);
    if (total === 0)
        return 0;
    let h = 0;
    for (const v of perMarketPnl) {
        const share = v / total;
        h += share * share;
    }
    return h;
}
export function computeEconomicMetrics(input) {
    const netPnl = input.grossPnl - input.totalFees;
    return {
        netPnl,
        maxDrawdownPct: maxDrawdown(input.equityCurve),
        fillRatio: input.totalSubmittedQty > 0
            ? input.totalFilledQty / input.totalSubmittedQty
            : 0,
        turnover: input.turnover,
        capacityUtilizationPct: input.capacityUsd > 0
            ? Math.min(100, (input.turnover / input.capacityUsd) * 100)
            : 0,
        concentration: concentrationIndex(input.perMarketPnl),
    };
}
/** Append-only registry. A preregistered spec can never be edited after creation. */
export class ExperimentRegistry {
    specs = [];
    preregister(spec) {
        const entry = {
            ...spec,
            id: crypto.randomUUID(),
            preregisteredAt: Date.now(),
            status: "PREREGISTERED",
        };
        this.specs.push(entry);
        return entry;
    }
    conclude(id, result) {
        const s = this.specs.find((x) => x.id === id);
        if (!s)
            return undefined;
        s.status = "CONCLUDED";
        s.result = result;
        return s;
    }
    withdraw(id) {
        const s = this.specs.find((x) => x.id === id);
        if (!s)
            return undefined;
        s.status = "WITHDRAWN";
        return s;
    }
    get(id) {
        return this.specs.find((s) => s.id === id);
    }
    all() {
        return [...this.specs];
    }
    countByStatus() {
        const out = {
            PREREGISTERED: 0,
            RUNNING: 0,
            CONCLUDED: 0,
            WITHDRAWN: 0,
        };
        for (const s of this.specs)
            out[s.status]++;
        return out;
    }
}
/**
 * Runs one full pass over a set of markets: forecast → size → simulate fill →
 * book PnL. No venue I/O; fills are simulated. Outcomes array is populated
 * with the paper decision treated as a 1 for a BUY (a proxy for calibration
 * checks only — real SHADOW uses resolved market outcomes).
 */
export function runPaperLoop(deps, markets, feeInput) {
    const decisions = [];
    const probabilities = [];
    const outcomes = [];
    const perMarketPnl = [];
    const equityCurve = [1000];
    const fills = [];
    let totalFees = 0;
    let grossPnl = 0;
    let turnover = 0;
    let totalSubmittedQty = 0;
    let totalFilledQty = 0;
    for (const m of markets) {
        const p = deps.forecast(m);
        if (p === null || p <= 0.02 || p >= 0.98 || Math.abs(p - 0.5) < 0.02) {
            decisions.push({
                action: "NO_TRADE",
                market_id: m.market_id,
                reason: "forecast uncertain",
            });
            continue;
        }
        const size = deps.sizeIntent(m, p);
        totalSubmittedQty += size;
        const fill = simulateFill({ ...feeInput, size, bid: m.bid, ask: m.ask });
        totalFilledQty += fill.filledSize;
        const pnl = fill.status === "CANCELLED"
            ? 0
            : (p - 0.5) * fill.filledSize - (fill.makerFee + fill.takerFee);
        probabilities.push(p);
        outcomes.push(p > 0.5 ? 1 : 0);
        perMarketPnl.push(pnl);
        grossPnl += pnl + (fill.makerFee + fill.takerFee);
        turnover += fill.filledSize * fill.fillPrice;
        totalFees += fill.makerFee + fill.takerFee;
        fills.push(fill);
        decisions.push({
            action: p > 0.5 ? "BUY" : "SELL",
            market_id: m.market_id,
            p,
            size,
            fill,
            pnl,
        });
        const last = equityCurve[equityCurve.length - 1] ?? 1000;
        equityCurve.push(last + pnl);
    }
    const economic = computeEconomicMetrics({
        equityCurve,
        initialEquity: equityCurve[0] ?? 1000,
        totalFees,
        grossPnl,
        turnover,
        capacityUsd: 10_000,
        perMarketPnl,
        totalSubmittedQty,
        totalFilledQty,
    });
    const probQuality = computeProbQuality({
        probabilities,
        outcomes,
    });
    return { decisions, probabilities, outcomes, economic, probQuality };
}
/**
 * The full autonomous loop but routes each tradable decision through the REAL
 * pipeline (orchestrate). The financial gate decides entry admission per
 * market; only ALLOW reaches the money path. This fixes the prior gap where
 * PAPER simulated fills without touching MoneyKernel/Executor/Signer.
 */
export async function runPaperLoopWithOrchestrator(params) {
    const decisions = [];
    const perMarketPnl = [];
    const equityCurve = [1000];
    let totalFees = 0;
    let grossPnl = 0;
    let turnover = 0;
    let totalSubmittedQty = 0;
    let totalFilledQty = 0;
    for (const m of params.markets) {
        const p = params.forecast(m);
        if (p === null || p <= 0.02 || p >= 0.98 || Math.abs(p - 0.5) < 0.02)
            continue;
        const gate = params.computeGate(m);
        params.onEntry(m);
        if (gate !== "ALLOW")
            continue; // entry or financially blocked -> no new order
        const size = params.sizeIntent(m, p);
        totalSubmittedQty += size;
        try {
            await params.orchestrate({ ...m, p, size });
        }
        catch {
            // Orchestrate failure: skip simulation and do not record a decision.
            continue;
        }
        // Simulated fill for accounting (still no financial I/O):
        const fill = simulateFill({
            ...params.feeInput,
            size,
            bid: m.bid,
            ask: m.ask,
        });
        totalFilledQty += fill.filledSize;
        const pnl = fill.status === "CANCELLED"
            ? 0
            : (p - 0.5) * fill.filledSize - (fill.makerFee + fill.takerFee);
        decisions.push({
            market_id: m.market_id,
            action: p > 0.5 ? "BUY" : "SELL",
            p,
            size,
            fill,
            pnl,
        });
        perMarketPnl.push(pnl);
        grossPnl += pnl + (fill.makerFee + fill.takerFee);
        turnover += fill.filledSize * fill.fillPrice;
        totalFees += fill.makerFee + fill.takerFee;
        const last = equityCurve[equityCurve.length - 1] ?? 1000;
        equityCurve.push(last + pnl);
    }
    const economic = computeEconomicMetrics({
        equityCurve,
        initialEquity: equityCurve[0] ?? 1000,
        totalFees,
        grossPnl,
        turnover,
        capacityUsd: 10_000,
        perMarketPnl,
        totalSubmittedQty,
        totalFilledQty,
    });
    return { decisions, economic };
}
//# sourceMappingURL=paper-engine.js.map