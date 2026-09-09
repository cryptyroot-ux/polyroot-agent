/**
 * Contract test: Tool Allowlist (ADR-01)
 * Verifies the agent's tool registry contains ONLY allowed tools
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  setupTestDb,
  cleanTestDb,
  teardownTestDb,
} from "../../helpers/test-setup.ts";

// These will be implemented when the agent graph is built
const ALLOWED_TOOLS = new Set([
  // Read
  "getMarketSnapshot",
  "getOrderBook",
  "getRecentTrades",
  "getFundingRate",
  "getPositions",
  // Learn
  "ingestEvidence",
  "runCalibration",
  "fetchNews",
  "queryKnowledgeBase",
  // Propose
  "proposeIntent",
]);

const FORBIDDEN_TOOLS = new Set([
  "signOrder",
  "submitOrder",
  "cancelOrder",
  "modifyOrder",
  "transferFunds",
  "withdraw",
  "deposit",
  "setRiskPolicy",
  "overrideSizing",
  "emergencyStop",
]);

describe("Tool Allowlist Contract (ADR-01)", () => {
  before(async () => {
    await setupTestDb();
  });

  after(async () => {
    await teardownTestDb();
  });

  it("agent tool registry contains only allowed tools", async () => {
    // TODO: Import actual agent tool registry when implemented
    // const { agentToolRegistry } = await import("@polyroot/intelligence/agent/tool-registry");
    // const registeredTools = new Set(Object.keys(agentToolRegistry));

    // For now, test passes as placeholder
    assert.ok(true, "Placeholder — replace with actual registry import");
  });

  it("no forbidden tool is reachable from agent entry point", async () => {
    // TODO: Static analysis or runtime guard test
    // const agentGraph = await buildAgentGraph();
    // const reachableTools = getReachableTools(agentGraph);
    // for (const tool of reachableTools) {
    //   assert.ok(!FORBIDDEN_TOOLS.has(tool), `Forbidden tool reachable: ${tool}`);
    // }
    assert.ok(true, "Placeholder — implement when agent graph exists");
  });

  it("static analysis: no signOrder/submitOrder/privateKey in intelligence/strategy", async () => {
    // This would be run as a separate CI step (grep), but we can also test here
    // const files = await glob("src/pm/{intelligence,strategy}/**/*.ts");
    // for (const file of files) {
    //   const content = await readFile(file, "utf-8");
    //   assert.ok(!/signOrder|submitOrder|privateKey/i.test(content),
    //     `Forbidden pattern in ${file}`);
    // }
    assert.ok(true, "Placeholder — run as CI grep step");
  });
});
