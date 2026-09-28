/**
 * @polyroot/runtime — Beginner-friendly observability engines.
 *
 * Read-only engines (explain, health, insight) never write. `halt` is the
 * single deliberate writer (loss latch + order cancels). `backup` writes
 * only to the operator-chosen output directory.
 */

export { explainLastDecision } from "./explain-engine.js";
export {
  requestHalt,
  type HaltRequest,
  type HaltDeps,
  type HaltResult,
} from "./halt-manager.js";
export {
  collectHealth,
  formatHealth,
  type HealthDeps,
  type HealthProbe,
  type HealthReport,
  type ProbeStatus,
} from "./health-monitor.js";
export {
  topOpportunities,
  marketDeepDive,
  formatInsight,
  type ScoredMarket,
} from "./insight-engine.js";
export {
  createBackup,
  restoreBackup,
  decryptText,
  type BackupDeps,
  type BackupRequest,
  type BackupManifest,
  type RestoreDeps,
  type RestoreRequest,
  type RestoreResult,
} from "./backup-manager.js";
