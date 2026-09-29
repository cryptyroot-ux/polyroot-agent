/**
 * @polyroot/runtime — Console UI kit.
 *
 * One visual language for every interactive surface (onboarding, setup,
 * status, console, markets, doctor, help): theme, panels, tables,
 * steppers, menu frames, spinners. Two iron rules, both load-bearing:
 *
 * 1. NEVER style inside a machine-tested phrase. Tests match markers via
 *    `includes("Choose AI provider")` — ANSI codes are applied around
 *    whole lines only, so every asserted substring stays contiguous.
 * 2. NEVER require a TTY. Piped stdin (tests), systemd units and log
 *    scrapers get the classic numbered/plain rendering; color and arrow
 *    menus light up only on a real terminal. `uiEnabled()` is the gate.
 */

export interface Theme {
  reset: (s: string) => string;
  bold: (s: string) => string;
  dim: (s: string) => string;
  cyan: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  red: (s: string) => string;
  magenta: (s: string) => string;
  blue: (s: string) => string;
  enabled: boolean;
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  magenta: "\u001b[35m",
  blue: "\u001b[34m",
} as const;

type ColorName = keyof typeof ANSI;

function paint(enabled: boolean, color: ColorName): (s: string) => string {
  if (!enabled) return (s: string) => s;
  const open = ANSI[color];
  const close = ANSI.reset;
  return (s: string) => `${open}${s}${close}`;
}

/**
 * True only on a real interactive terminal. Piped stdin (tests), systemd
 * units, dumb terminals and NO_COLOR/POLYROOT_NO_COLOR all disable styling
 * AND arrow-key menus (which need raw mode + a live screen).
 */
export function uiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["NO_COLOR"] !== undefined) return false;
  if (env["POLYROOT_NO_COLOR"] !== undefined) return false;
  if (env["TERM"] === "dumb") return false;
  return (
    (process.stdout.isTTY ?? false) && (process.stdin.isTTY ?? false)
  );
}

export function theme(env: NodeJS.ProcessEnv = process.env): Theme {
  const on = uiEnabled(env);
  return {
    reset: paint(on, "reset"),
    bold: paint(on, "bold"),
    dim: paint(on, "dim"),
    cyan: paint(on, "cyan"),
    green: paint(on, "green"),
    yellow: paint(on, "yellow"),
    red: paint(on, "red"),
    magenta: paint(on, "magenta"),
    blue: paint(on, "blue"),
    enabled: on,
  };
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** Strip ANSI escape codes (width math + log scraping). */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Visible width: ANSI-stripped length (CJK double-width out of scope). */
export function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

function padEndVisible(s: string, width: number): string {
  const w = visibleWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

/**
 * Classic banner (same ═══ voice as before, now one function).
 * Title/subtitle text is emitted verbatim — safe for tested phrases.
 */
export function banner(
  title: string,
  subtitle?: string,
  t: Theme = theme(),
): string {
  const bar = "═".repeat(47);
  const lines = ["", t.cyan(bar), `  ${t.bold(title)}`, t.cyan(bar)];
  if (subtitle !== undefined) lines.push(`  ${t.dim(subtitle)}`);
  lines.push("");
  return lines.join("\n");
}

/** Stepper: ━━●━━○━━○  Step 2/3 · Wallet */
export function stepper(
  current: number,
  total: number,
  label: string,
  t: Theme = theme(),
): string {
  const parts: string[] = [];
  for (let i = 1; i <= total; i++) {
    parts.push(i < current ? "━" : i === current ? "●" : "○");
    if (i < total) parts.push("━━");
  }
  return `${t.cyan(parts.join(""))}  ${t.bold(`Step ${current}/${total}`)} ${t.dim(`· ${label}`)}`;
}

/** Rounded panel with an optional title. Body lines emit verbatim. */
export function box(
  title: string | null,
  body: string[],
  t: Theme = theme(),
): string {
  const inner = body.map((l) => `  ${l}  `);
  const width = Math.max(
    title ? visibleWidth(title) + 4 : 0,
    ...inner.map(visibleWidth),
    10,
  );
  const top = title
    ? `╭─ ${t.bold(title)} ${"─".repeat(Math.max(width - visibleWidth(title) - 1, 1))}╮`
    : `╭${"─".repeat(width + 2)}╮`;
  const bottom = `╰${"─".repeat(width + 2)}╯`;
  return [
    t.dim(top),
    ...inner.map((l) => `${t.dim("│")}${padEndVisible(l, width + 2)}${t.dim("│")}`),
    t.dim(bottom),
  ].join("\n");
}

/** Left column padded, values untouched. */
export function kv(
  rows: Array<[string, string]>,
  t: Theme = theme(),
): string {
  const labelWidth = Math.max(...rows.map(([k]) => visibleWidth(k)), 0);
  return rows
    .map(
      ([k, v]) =>
        `  ${t.cyan(padEndVisible(k, labelWidth))}  ${v}`,
    )
    .join("\n");
}

/** Plain-text table with padded columns; long cells truncate with …. */
export function table(
  headers: string[],
  rows: string[][],
  opts: { maxWidth?: number } = {},
  t: Theme = theme(),
): string {
  const widths = headers.map((h, i) =>
    Math.max(
      visibleWidth(h),
      ...rows.map((r) => visibleWidth(r[i] ?? "")),
    ),
  );
  const maxWidth = opts.maxWidth ?? 110;
  const total = widths.reduce((a, b) => a + b, 0) + widths.length * 3 + 1;
  const scale =
    total > maxWidth
      ? (maxWidth - widths.length * 3 - 1) /
        Math.max(
          widths.reduce((a, b) => a + b, 0),
          1,
        )
      : 1;
  const col = (s: string, i: number): string => {
    let w = Math.max(Math.floor(widths[i]! * scale), 4);
    let v = s;
    if (visibleWidth(v) > w) v = `${v.slice(0, w - 1)}…`;
    return padEndVisible(v, w);
  };
  const head = headers.map((h, i) => t.bold(col(h, i))).join(" │ ");
  const sep = widths.map((_, i) => "─".repeat(Math.max(Math.floor(widths[i]! * scale), 4))).join("─┼─");
  const body = rows.map((r) =>
    r.map((c, i) => col(c ?? "", i)).join(" │ "),
  );
  return [`  ${head}`, `  ${t.dim(sep)}`, ...body.map((l) => `  ${l}`)].join(
    "\n",
  );
}

/** Progress bar: ████████░░░░ 62% */
export function progressBar(
  frac: number,
  width = 24,
  t: Theme = theme(),
): string {
  const f = Math.min(Math.max(frac, 0), 1);
  const filled = Math.round(f * width);
  const bar =
    t.green("█".repeat(filled)) + t.dim("░".repeat(width - filled));
  return `${bar} ${t.bold(`${Math.round(f * 100)}%`)}`;
}

export type PillTone = "green" | "yellow" | "red" | "cyan" | "dim";

/** Colored pill: [ SHADOW ] — text emitted verbatim inside. */
export function pill(
  text: string,
  tone: PillTone = "cyan",
  t: Theme = theme(),
): string {
  const painters: Record<PillTone, (s: string) => string> = {
    green: t.green,
    yellow: t.yellow,
    red: t.red,
    cyan: t.cyan,
    dim: t.dim,
  };
  return painters[tone](`[ ${text} ]`);
}

export interface MenuFrameOpts {
  /** Extra footer line (e.g. "↑↓ navigate · Enter select"). */
  hint?: string;
  /** Max options before the list scrolls in interactive mode. */
  pageSize?: number;
}

/**
 * Pure menu frame shared by the numbered fallback AND the arrow-key menu,
 * so both show identical options in identical order. The message line and
 * every option emit VERBATIM (marker-safe): only the cursor glyph, the
 * default arrow and the surrounding frame carry styling.
 */
export function menuFrame(
  message: string,
  options: string[],
  defaultIdx: number,
  cursorIdx: number,
  opts: MenuFrameOpts = {},
  t: Theme = theme(),
): string {
  const pageSize = opts.pageSize ?? options.length;
  let start = 0;
  if (options.length > pageSize) {
    start = Math.min(
      Math.max(cursorIdx - Math.floor(pageSize / 2), 0),
      options.length - pageSize,
    );
  }
  const lines = [message];
  for (let i = start; i < Math.min(start + pageSize, options.length); i++) {
    const opt = options[i] ?? "";
    const cursor = i === cursorIdx ? t.cyan("▸") : " ";
    const marker = i === defaultIdx ? t.yellow("→") : " ";
    lines.push(`  ${cursor}${marker} ${i + 1}. ${opt}`);
  }
  if (options.length > pageSize) {
    lines.push(
      t.dim(`    … ${start + 1}–${Math.min(start + pageSize, options.length)} of ${options.length}`),
    );
  }
  lines.push(
    t.dim(
      opts.hint ?? `Choice [1-${options.length}] (Enter = ${defaultIdx + 1})`,
    ),
  );
  return lines.join("\n");
}

/** Spinner frames; startSpinner() is a silent no-op off-TTY. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  stop: (finalLine?: string) => void;
}

export function startSpinner(label: string): Spinner {
  const t = theme();
  if (!t.enabled) {
    return { stop: () => undefined };
  }
  let i = 0;
  const timer = setInterval(() => {
    const frame = SPINNER_FRAMES[i % SPINNER_FRAMES.length] ?? "⠋";
    process.stdout.write(`\r${t.cyan(frame)} ${label}`);
    i += 1;
  }, 80);
  return {
    stop: (finalLine?: string) => {
      clearInterval(timer);
      process.stdout.write("\r\x1b[2K");
      if (finalLine !== undefined) console.log(finalLine);
    },
  };
}
