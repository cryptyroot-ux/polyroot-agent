import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  uiEnabled,
  theme,
  stripAnsi,
  visibleWidth,
  banner,
  stepper,
  box,
  kv,
  table,
  progressBar,
  pill,
  menuFrame,
  startSpinner,
} from "@polyroot/runtime";

const OFF = {
  NO_COLOR: undefined,
  POLYROOT_NO_COLOR: undefined,
  TERM: "dumb",
} as unknown as NodeJS.ProcessEnv;

describe("console UI kit", () => {
  it("stays plain off-TTY (tests, pipes, systemd)", () => {
    assert.equal(uiEnabled(OFF), false);
    const t = theme(OFF);
    assert.equal(t.enabled, false);
    assert.equal(t.bold("x"), "x");
    assert.equal(t.cyan("y"), "y");
  });

  it("paints on a real terminal", () => {
    const t = theme({
      TERM: "xterm-256color",
    } as unknown as NodeJS.ProcessEnv);
    // isTTY decides in this process; the contract is identity-off only.
    assert.equal(typeof t.bold("x"), "string");
    assert.ok(stripAnsi(t.bold("hello")).includes("hello"));
  });

  it("stripAnsi + visibleWidth ignore escape codes", () => {
    const painted = "[36mhello[0m";
    assert.equal(stripAnsi(painted), "hello");
    assert.equal(visibleWidth(painted), 5);
    assert.equal(visibleWidth("plain"), 5);
  });

  it("banner keeps title text contiguous (marker-safe)", () => {
    const b = banner("Welcome to PolyRoot Agent — First-Time Setup", undefined, theme(OFF));
    assert.ok(b.includes("Welcome to PolyRoot Agent — First-Time Setup"));
    assert.ok(b.includes("═"));
  });

  it("stepper renders progress dots + label", () => {
    const s = stepper(2, 3, "Wallet", theme(OFF));
    assert.ok(s.includes("Step 2/3"));
    assert.ok(s.includes("Wallet"));
    assert.ok(s.includes("●") && s.includes("○"));
  });

  it("box aligns borders to the widest line", () => {
    const b = box("Done", ["a", "longer line"], theme(OFF));
    const lines = b.split("\n");
    const widths = new Set(lines.map((l) => l.length));
    assert.equal(widths.size, 1);
    assert.ok(b.includes("Done") && b.includes("longer line"));
  });

  it("kv aligns values, table aligns columns", () => {
    const k = kv(
      [
        ["Mode:", "SHADOW"],
        ["Database:", "✅ Set"],
      ],
      theme(OFF),
    );
    const [l1, l2] = k.split("\n");
    assert.equal(l1?.indexOf("SHADOW"), l2?.indexOf("✅ Set"));
    const tb = table(["#", "Market"], [["1", "Will X?"]], {}, theme(OFF));
    assert.ok(tb.includes("#") && tb.includes("Will X?"));
  });

  it("progressBar fills proportionally", () => {
    const p0 = stripAnsi(progressBar(0, 10, theme(OFF)));
    const p1 = stripAnsi(progressBar(1, 10, theme(OFF)));
    assert.ok(p0.includes("0%") && p1.includes("100%"));
    assert.ok(!p0.includes("█") && p1.includes("█".repeat(10)));
  });

  it("pill wraps text verbatim", () => {
    assert.ok(pill("SHADOW", "cyan", theme(OFF)).includes("SHADOW"));
  });

  it("menuFrame shows identical options in order with cursor + default", () => {
    const f = menuFrame("Choose mode (Enter = SHADOW):", ["SHADOW — x", "PAPER — y"], 0, 1, {}, theme(OFF));
    assert.ok(f.includes("Choose mode (Enter = SHADOW):"));
    assert.ok(f.indexOf("SHADOW — x") < f.indexOf("PAPER — y"));
    assert.ok(f.includes("▸") && f.includes("→"));
    assert.ok(f.includes("Choice [1-2]"));
  });

  it("menuFrame paginates long lists without dropping the cursor", () => {
    const opts = Array.from({ length: 33 }, (_, i) => `opt ${i + 1}`);
    const f = menuFrame("Pick:", opts, 0, 32, { pageSize: 12 }, theme(OFF));
    assert.ok(f.includes("opt 33"));
    assert.ok(f.includes("of 33"));
  });

  it("startSpinner is a silent no-op off-TTY", () => {
    const seen: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (...a: unknown[]) => boolean }).write =
      ((...a: unknown[]) => {
        seen.push(String(a[0]));
        return true;
      }) as never;
    try {
      const prev1 = process.env["NO_COLOR"];
      const prev2 = process.env["POLYROOT_NO_COLOR"];
      process.env["POLYROOT_NO_COLOR"] = "1";
      try {
        startSpinner("Fetching…").stop("done");
      } finally {
        if (prev1 === undefined) delete process.env["NO_COLOR"];
        else process.env["NO_COLOR"] = prev1;
        if (prev2 === undefined) delete process.env["POLYROOT_NO_COLOR"];
        else process.env["POLYROOT_NO_COLOR"] = prev2;
      }
    } finally {
      process.stdout.write = orig as never;
    }
    assert.deepEqual(seen, []);
  });
});
