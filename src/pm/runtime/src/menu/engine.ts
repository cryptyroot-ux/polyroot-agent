/**
 * @polyroot/runtime — menu engine.
 *
 * A breadcrumb navigator over MENU tree definitions. Each level renders via
 * the shared askChoice picker (arrow keys on TTY, numbered fallback
 * otherwise — the same picker onboarding uses, so piped stdin and tests
 * keep working). Leaf actions spawn `polyroot <argv...>` as a child
 * process with inherited stdio and wait for it; the menu resumes after.
 *
 * Nothing here reimplements any command. Unknown argv can never boot the
 * loop: leaves carry fixed argv specs, never free text.
 */

import { spawnSync } from "node:child_process";
import {
  askChoice,
  askText,
  closeSharedSession,
  OnboardingCancelled,
} from "../cli.js";
import { banner, theme } from "../console-ui.js";
import {
  MENU_BACK_LABEL,
  MENU_QUIT_LABEL,
  POLYROOT_MENU,
} from "./definitions.js";
import type { MenuBreadcrumb, MenuNode } from "./types.js";

function cliEntry(): string {
  const entry = process.argv[1] ?? "";
  if (!entry) {
    throw new Error("Menu cannot locate the CLI entrypoint.");
  }
  return entry;
}

function childrenOf(node: MenuNode): MenuNode[] {
  return node.children ?? [];
}

async function confirmAction(prompt: string): Promise<boolean> {
  const answer = await askText(`${prompt} (y/n)`, {
    defaultValue: "n",
  }).catch((err: unknown) => {
    if (err instanceof OnboardingCancelled) return "n";
    throw err;
  });
  return answer.trim().toLowerCase().startsWith("y");
}

function runLeaf(argv: string[]): void {
  // Mirror the parent loader flags (e.g. `--import tsx` in dev): without
  // them a .ts entrypoint dies with ERR_MODULE_NOT_FOUND in the child.
  // In production (compiled dist/cli.js) execArgv is empty — plain node.
  const res = spawnSync(
    process.execPath,
    [...process.execArgv, cliEntry(), ...argv],
    { stdio: "inherit" },
  );
  if (res.error) {
    console.log(
      `\n⚠️  Command failed to start: ${(res.error as Error).message}`,
    );
  }
  if (typeof res.status === "number" && res.status !== 0) {
    console.log(`\n(exit ${res.status} — back to menu)`);
  }
}

async function runNodeAction(
  node: Exclude<MenuNode["action"], undefined>,
): Promise<void> {
  const action = node;
  let argv = [...action.run];
  if (action.needValue) {
    const value = await askText(action.needValue.prompt, {
      ...(action.needValue.def ? { defaultValue: action.needValue.def } : {}),
    }).catch((err: unknown) => {
      if (err instanceof OnboardingCancelled) return "";
      throw err;
    });
    if (!value.trim()) {
      console.log("Cancelled — no value entered.");
      return;
    }
    argv = [...argv, action.needValue.flag, value.trim()];
  }
  if (action.confirm) {
    const ok = await confirmAction(action.confirm);
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }
  runLeaf(argv);
}

/**
 * Run the interactive menu. Returns when the operator quits.
 * Ctrl-C / ESC backs out one level (quits at root), mirroring every
 * other interactive flow in this CLI.
 */
export async function runMenu(): Promise<void> {
  const t = theme();
  const crumbs: MenuBreadcrumb[] = [{ id: "root", label: POLYROOT_MENU.label }];
  let node: MenuNode = POLYROOT_MENU;
  try {
    for (;;) {
      const kids = childrenOf(node);
      const labels = kids.map(
        (k) => `${k.label}${k.detail ? t.dim(` — ${k.detail}`) : ""}`,
      );
      const isRoot = crumbs.length === 1;
      labels.push(isRoot ? MENU_QUIT_LABEL : MENU_BACK_LABEL);
      const title =
        crumbs.length > 1
          ? `${POLYROOT_MENU.label} › ${crumbs
              .slice(1)
              .map((c) => c.label)
              .join(" › ")}`
          : POLYROOT_MENU.label;
      console.log("");
      console.log(banner(title, "↑↓ navigate · Enter select · Esc back"));
      let picked: string;
      try {
        picked = await askChoice("Menu:", labels, 0);
      } catch (err) {
        if (err instanceof OnboardingCancelled) {
          if (isRoot) return;
          crumbs.pop();
          node =
            crumbs.length === 1
              ? POLYROOT_MENU
              : (findNode(
                  POLYROOT_MENU,
                  crumbs[crumbs.length - 1]?.id ?? "root",
                ) ?? POLYROOT_MENU);
          continue;
        }
        if ((err as { code?: string }).code === "ERR_USE_AFTER_CLOSE") {
          // stdin EOF (piped input ended) — leave quietly, not a crash.
          // Same contract as the legacy console REPL.
          return;
        }
        throw err;
      }
      const idx = labels.indexOf(picked);
      if (picked === MENU_QUIT_LABEL || (isRoot && idx === labels.length - 1))
        return;
      if (picked === MENU_BACK_LABEL || idx === labels.length - 1) {
        crumbs.pop();
        node =
          crumbs.length === 1
            ? POLYROOT_MENU
            : (findNode(
                POLYROOT_MENU,
                crumbs[crumbs.length - 1]?.id ?? "root",
              ) ?? POLYROOT_MENU);
        continue;
      }
      const next = kids[idx];
      if (!next) continue;
      if (next.action) {
        await runNodeAction(next.action);
        console.log("");
        continue;
      }
      if (next.children) {
        crumbs.push({ id: next.id, label: next.label });
        node = next;
        continue;
      }
    }
  } finally {
    closeSharedSession();
  }
}

function findNode(root: MenuNode, id: string): MenuNode | null {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}
