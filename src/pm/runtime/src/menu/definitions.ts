/**
 * @polyroot/runtime — menu tree definitions.
 *
 * Mirrors the operator-approved layout 1:1 (9 categories). Every leaf maps
 * to an existing CLI invocation; adding a command here never changes the
 * command itself. The tree is data — asserted structurally by tests.
 */

import type { MenuNode } from "./types.js";

function leaf(
  id: string,
  label: string,
  run: string[],
  detail?: string,
  confirm?: string,
  needValue?: { flag: string; prompt: string; def?: string },
): MenuNode {
  return {
    id,
    label,
    ...(detail ? { detail } : {}),
    action: {
      run,
      ...(confirm ? { confirm } : {}),
      ...(needValue ? { needValue } : {}),
    },
  };
}

function branch(
  id: string,
  label: string,
  children: MenuNode[],
  detail?: string,
): MenuNode {
  return { id, label, ...(detail ? { detail } : {}), children };
}

export const POLYROOT_MENU: MenuNode = {
  id: "root",
  label: "Polyroot Agent Menu",
  children: [
    branch("mode", "Mode", [
      leaf("mode-show", "Show current mode", ["mode"], "MICRO_LIVE | LIVE"),

      leaf(
        "mode-micro",
        "Switch to MICRO_LIVE",
        ["mode", "MICRO_LIVE"],
        "Small real money (loss latch enforced)",
      ),
      leaf(
        "mode-live",
        "Switch to LIVE",
        ["mode", "LIVE"],
        "Full real money (promotion + gates enforced)",
      ),
      leaf(
        "live-promote",
        "LIVE promotion (grant/list/revoke)",
        ["live-promote"],
        "Owner-signed admission",
      ),
      leaf(
        "guard-reset",
        "Guard reset (unlock loss latch)",
        ["guard", "reset"],
        "Owner action, audited",
        undefined,
        { flag: "--loss", prompt: "Realized loss in pUSD" },
      ),
    ]),
    branch("wallet", "Wallet & Security", [
      leaf(
        "wallet-status",
        "Wallet status",
        ["wallet", "verify"],
        "Addresses, keystore, balance",
      ),
      leaf(
        "wallet-create",
        "Create new wallet",
        ["wallet", "create"],
        "Generates keystore in this terminal",
      ),
      leaf(
        "wallet-import",
        "Import private key",
        ["wallet", "import"],
        "Private key never leaves this terminal",
      ),
      leaf(
        "wallet-seal",
        "Seal key into keystore",
        ["wallet", "seal"],
        "Encrypts a raw key from env",
      ),
      leaf(
        "set-key",
        "Store provider API key",
        ["set-key"],
        "Hidden prompt, never argv",
      ),
      leaf(
        "shadow-fund",
        "Shadow fund (practice bankroll)",
        ["shadow-fund"],
        "MICRO_LIVE only",
        undefined,
        { flag: "--amount", prompt: "Amount in USD" },
      ),
    ]),
    branch("provider", "Provider/Model", [
      leaf(
        "provider-pick",
        "Choose provider & model",
        ["setup"],
        "Shortlist + live catalog",
      ),
      leaf(
        "provider-set-key",
        "Store provider API key",
        ["set-key"],
        "Hidden prompt, never argv",
      ),
    ]),
    branch("venue", "Venue Polymarket", [
      leaf(
        "venue-check",
        "Check venue connection",
        ["venue", "check"],
        "Order book + credentials",
      ),
      leaf("markets", "Browse markets", ["markets"], "Liquid markets by name"),
      leaf(
        "doctor-live",
        "LIVE readiness (doctor --live)",
        ["doctor", "--live"],
        "Required before real money",
      ),
    ]),
    branch("monitor", "Monitor", [
      leaf(
        "status",
        "System status",
        ["status"],
        "Config, wallet, caps, supervisor",
      ),
      leaf("health", "Health check", ["health"], "Probes + LiveGuard"),
      leaf("logs", "Logs", ["logs"], "Agent log files"),
      leaf("insight", "Market insight", ["insight"], "Opportunities + heatmap"),
      leaf(
        "explain",
        "Explain last decision",
        ["explain"],
        "AI decision chain",
      ),
      leaf(
        "halt",
        "HALT (emergency stop)",
        ["halt"],
        "Loss latch ON",
        "Stop the agent and engage the loss latch?",
      ),
    ]),
  ],
};

export const MENU_BACK_LABEL = "← Back";
export const MENU_QUIT_LABEL = "✕ Quit to console";
