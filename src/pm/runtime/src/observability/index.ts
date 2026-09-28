/**
 * @polyroot/runtime — Beginner-friendly observability engines.
 *
 * Read-only engines (explain, health, insight) never write. `halt` is the
 * single deliberate writer (loss latch + order cancels). `backup` writes
 * only to the operator-chosen output directory.
 */

export { explainLastDecision } from "./explain-engine.js";
