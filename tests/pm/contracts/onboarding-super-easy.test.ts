import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CLI_SRC = join(process.cwd(), "src", "pm", "runtime", "src", "cli.ts");

describe("onboarding contains zero maintainer-owned provider defaults", () => {
  it("never ships files.pango.fun in the onboarding path", () => {
    const src = readFileSync(CLI_SRC, "utf8");
    assert.ok(
      !src.includes("files.pango.fun"),
      "onboarding must not default to a maintainer-owned gateway",
    );
  });
});
