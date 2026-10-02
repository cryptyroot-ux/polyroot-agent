import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MENU_BACK_LABEL,
  MENU_QUIT_LABEL,
  POLYROOT_MENU,
} from "@polyroot/runtime";
import type { MenuNode } from "@polyroot/runtime";

function leaves(node: MenuNode): MenuNode[] {
  const out: MenuNode[] = [];
  const walk = (n: MenuNode): void => {
    if (n.action) out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return out;
}

function ids(node: MenuNode): string[] {
  const out: string[] = [node.id];
  for (const c of node.children ?? []) out.push(...ids(c));
  return out;
}

describe("menu tree (operator spec: 5 categories)", () => {
  it("root has exactly the 5 approved categories in order", () => {
    const kids = POLYROOT_MENU.children ?? [];
    assert.deepEqual(
      kids.map((k) => k.id),
      ["mode", "wallet", "provider", "venue", "monitor"],
    );
  });

  it("every leaf carries a runnable argv (no dead ends)", () => {
    for (const leaf of leaves(POLYROOT_MENU)) {
      assert.ok(
        Array.isArray(leaf.action?.run) && (leaf.action?.run.length ?? 0) > 0,
        `leaf ${leaf.id} has empty argv`,
      );
    }
  });

  it("ids are unique across the whole tree", () => {
    const all = ids(POLYROOT_MENU);
    assert.equal(new Set(all).size, all.length);
  });

  it("every leaf targets a known CLI command", () => {
    const known = new Set([
      "mode",
      "live-promote",
      "guard",
      "wallet",
      "set-key",
      "shadow-fund",
      "setup",
      "onboard",
      "venue",
      "markets",
      "doctor",
      "status",
      "health",
      "logs",
      "insight",
      "explain",
      "halt",
      "run",
    ]);
    for (const leaf of leaves(POLYROOT_MENU)) {
      const cmd = leaf.action?.run[0] ?? "";
      assert.ok(
        known.has(cmd),
        `leaf ${leaf.id} targets unknown command: ${cmd}`,
      );
    }
  });

  it("back/quit labels are non-empty and distinct", () => {
    assert.ok(MENU_BACK_LABEL.length > 0);
    assert.ok(MENU_QUIT_LABEL.length > 0);
    assert.notEqual(MENU_BACK_LABEL, MENU_QUIT_LABEL);
  });
});
