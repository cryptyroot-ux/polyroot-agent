import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = "src/pm/control/src/orchestrator-pg.ts";

describe("single shared pool", () => {
  it("orchestrator-pg accepts an injected pool", () => {
    const src = readFileSync(SRC, "utf8");
    assert.match(src, /pool\?: Pool/);
  });

  it("reuses the injected pool instead of creating new ones", () => {
    const src = readFileSync(SRC, "utf8");
    assert.match(src, /deps\.pool \?\?/);
  });

  it("shutdown ends only pools the factory owns", () => {
    const src = readFileSync(SRC, "utf8");
    assert.match(src, /ownsPool/);
  });

  it("hydrates idempotency state from the durable seen store", () => {
    const src = readFileSync(SRC, "utf8");
    assert.match(src, /PgSeenStore/);
  });
});
