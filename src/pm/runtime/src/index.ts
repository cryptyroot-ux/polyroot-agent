/**
 * @polyroot/runtime — Paper/SHADOW engine, metrics, experiment registry.
 * PR-VAL-04..08, G4-G6. Core logic is pure (no I/O); DB hooks are optional.
 */
export * from "./paper-engine.js";
export * from "./postgres-log.js";
export { MetricsExporter } from "./metrics-exporter.js";
export { MetricsServer, type MetricsServerOptions } from "./metrics-server.js";
export {
  G4AutonomousLoop,
  createG4Loop,
  type G4Mode,
  type G4LoopConfig,
  type G4LoopInput,
  type G4LoopResult,
  type G4LoopMetrics,
  type G4LoopDeps,
} from "./g4-loop.js";
export {
  G4Pipeline,
  createG4Pipeline,
  type G4PipelineMode,
  type G4PipelineConfig,
  type G4PipelineDeps,
  type G4PipelineInput,
  type G4PipelineResult,
  type G4PipelineMetrics,
} from "./g4-pipeline.js";
export * from "./g4-core.js";
export * from "./reality-gap.js";
export * from "./micro-live-guard.js";
export * from "./resolution-sync.js";
export * from "./console-ui.js";
export * from "./instance-guard.js";
export * from "./telegram.js";
export * from "./live-guard-store.js";
export * from "./autonomy-bounds.js";
export * from "./live-preflight.js";
export * from "./setup-guide.js";
export * from "./platform-safety.js";
export {
  ModeWatcher,
  type ModeWatcherOptions,
  type RuntimeMode,
  type QueryablePool,
} from "./mode-watcher.js";
export {
  bootstrapAgent,
  buildWalletIdentity,
  deterministicWalletId,
  recordG4Metrics,
  resolveDisplayQuestion,
  type BootstrapAgentOptions,
} from "./main.js";
export {
  parseArgs,
  printHelp,
  startAgent,
  main,
  assertRuntimeEnv,
  assertMicroLiveReady,
  refreshSupervisorUnit,
  suggestCommand,
  normalizeConsoleLine,
  digitBufferTarget,
  mergeEnvPreserving,
  loadDotEnv,
  runWalletVerify,
  runGuardReset,
  type GuardResetResult,
  type WalletCheck,
  type WalletVerifyResult,
} from "./cli.js";
export type { CLIConfig } from "./cli.js";
export {
  formatOnceTranscript,
  type OnceTranscriptInput,
  type OnceTranscriptResult,
} from "./cli.js";
export { explainLastDecision } from "./observability/index.js";
export {
  requestHalt,
  type HaltRequest,
  type HaltDeps,
  type HaltResult,
} from "./observability/index.js";
export {
  collectHealth,
  formatHealth,
  type HealthDeps,
  type HealthProbe,
  type HealthReport,
  type ProbeStatus,
} from "./observability/index.js";
export {
  topOpportunities,
  marketDeepDive,
  formatInsight,
  type ScoredMarket,
} from "./observability/index.js";
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
} from "./observability/index.js";
export {
  persistStep,
  createStepPersistence,
  flushStepPersistence,
  type StepPersistenceDeps,
  type PersistedStep,
} from "./observability/index.js";
