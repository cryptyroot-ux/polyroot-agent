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
export * from "./platform-safety.js";
export { bootstrapAgent, type BootstrapAgentOptions } from "./main.js";
export { parseArgs, startAgent, main } from "./cli.js";
export type { CLIConfig } from "./cli.js";
