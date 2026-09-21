/**
 * Commission Autonomy Charter Script
 * Creates an immutable Autonomy Charter for LIVE mode operation.
 * Usage: npx tsx scripts/commission-charter.ts [options]
 */

import { program } from "commander";
import { commissionCharter } from "../src/pm/control/src/charter.js";
import fs from "node:fs";
import path from "node:path";

program
  .name("commission-charter")
  .description("Create an immutable Autonomy Charter for PolyRoot LIVE mode")
  .requiredOption("--wallet-id <address>", "Wallet address (e.g., 0x1234...)")
  .requiredOption("--capital-usd-cap <number>", "Maximum capital in USD (hard cap)")
  .requiredOption("--daily-loss-stop-pct <number>", "Daily loss stop percentage (0.05 = 5%)")
  .requiredOption("--strategy-ids <ids...>", "Qualified strategy IDs (space-separated)")
  .requiredOption("--market-classes <classes...>", "Allowed market classes (space-separated)")
  .option("--expires-days <days>", "Charter validity in days", "365")
  .requiredOption("--release-ref <ref>", "Release reference (e.g., v0.1.0-stable)")
  .option("--output <path>", "Output file path", "autonomy-charter.json")
  .action((options) => {
    try {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + parseInt(options.expiresDays, 10));

      const charter = commissionCharter({
        walletId: options.walletId,
        capitalUsdCap: parseFloat(options.capitalUsdCap),
        dailyLossStopPct: parseFloat(options.dailyLossStopPct),
        qualifiedStrategyIds: options.strategyIds,
        marketClassAllowlist: options.marketClasses,
        expiresAt,
        releaseRef: options.releaseRef,
      });

      const outputPath = path.resolve(options.output);
      fs.writeFileSync(outputPath, JSON.stringify(charter, null, 2));

      console.log("✅ Autonomy Charter commissioned successfully!");
      console.log(`   Charter ID: ${charter.charter_id}`);
      console.log(`   Wallet: ${charter.wallet_id}`);
      console.log(`   Capital Cap: $${charter.capital_usd_cap} USD`);
      console.log(`   Daily Loss Stop: ${charter.daily_loss_stop_pct * 100}%`);
      console.log(`   Qualified Strategies: ${charter.qualified_strategy_ids.join(", ")}`);
      console.log(`   Market Classes: ${charter.market_class_allowlist.join(", ")}`);
      console.log(`   Expires: ${charter.expires_at.toISOString()}`);
      console.log(`   Release Ref: ${charter.release_ref}`);
      console.log(`   Saved to: ${outputPath}`);
      console.log("");
      console.log("📋 Next steps:");
      console.log("   1. Store this file securely (required for LIVE mode startup)");
      console.log("   2. Reference in process manager config or mount as volume");
      console.log("   3. Set RUNTIME_MODE=LIVE after SHADOW baseline complete");
    } catch (err) {
      console.error("❌ Failed to commission charter:", err);
      process.exit(1);
    }
  });

program.parse();