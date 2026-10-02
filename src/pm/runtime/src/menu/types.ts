/**
 * @polyroot/runtime — menu-driven CLI types.
 *
 * The menu is a thin navigator over the existing command surface: every
 * leaf carries the argv it would run as `polyroot <argv...>`, executed in
 * a child process. No command logic lives here; nothing here can change
 * what a command does — only how the operator reaches it.
 */

/**
 * A leaf action: argv to run as `polyroot <argv...>`.
 * If `needValue` is set, the engine prompts first and appends flag+value
 * (for commands that require an argument, e.g. --amount).
 */
export interface MenuAction {
  run: string[];
  /** Shown when the action needs confirmation first (destructive). */
  confirm?: string;
  needValue?: {
    flag: string;
    prompt: string;
    def?: string;
  };
}

export interface MenuNode {
  /** Stable id, e.g. "mode". */
  id: string;
  /** Display label, e.g. "Mode & Trading". */
  label: string;
  /** One-line description shown under the label. */
  detail?: string;
  /** Leaf action; absent = category with children. */
  action?: MenuAction;
  children?: MenuNode[];
}

export interface MenuBreadcrumb {
  id: string;
  label: string;
}
