import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  onboardNext,
  onboardIntro,
  wizardProviderOptions,
  applyOnboardWrites,
  onboardPaths,
  onboardSessionGet,
  onboardSessionReset,
  onboardSessionSet,
  buildTelegramHandlers,
  type OnboardFacts,
  type OnboardState,
} from "@polyroot/runtime";

const FACTS: OnboardFacts = {
  passphraseSet: true,
  signerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  codexReady: false,
  now: 1_000_000,
};

function start(): OnboardState {
  return { step: "provider", startedAt: 1_000_000 };
}

function turn(
  state: OnboardState,
  text: string,
  facts: OnboardFacts = FACTS,
  createdAddress?: string,
) {
  return onboardNext(
    state,
    text,
    { ...facts, now: facts.now ?? 1_000_000 },
    createdAddress,
  );
}

function scripted(texts: string[], facts: OnboardFacts = FACTS) {
  let s = start();
  let last = turn(s, texts[0] ?? "", facts);
  s = last.state;
  const allWrites = [...last.writes];
  for (const t of texts.slice(1)) {
    last = turn(s, t, facts);
    s = last.state;
    allWrites.push(...last.writes);
  }
  return { state: s, reply: last.reply, writes: allWrites };
}

describe("telegram /onboard wizard (pure machine)", () => {
  it("intro lists providers without secrets", () => {
    const intro = onboardIntro(FACTS);
    assert.match(intro, /Langkah 1/);
    assert.ok(!/sk-|0x[0-9a-fA-F]{64}/.test(intro));
  });

  it("batal aborts from any step", () => {
    const r = turn(start(), "batal");
    assert.equal(r.state.step, "aborted");
    assert.match(r.reply, /Dibatalkan/);
  });

  it("SHADOW path completes end to end (terminal key noted, never asked)", () => {
    const r = scripted([
      "5", // openai
      "1", // gpt-4o-mini
      "2", // keep existing wallet
      "1", // SHADOW
      "", // default capital
      "", // default loss
    ]);
    assert.equal(r.state.step, "done");
    const keys = Object.fromEntries(r.writes);
    assert.equal(keys["POLYROOT_FORECAST_PROVIDER"], "openai");
    assert.equal(keys["POLYROOT_FORECAST_MODEL"], "gpt-4o-mini");
    assert.equal(keys["RUNTIME_MODE"], "SHADOW");
    assert.ok(keys["POLYROOT_MICRO_LIVE_CAP_USD"]);
    assert.ok(keys["POLYROOT_MICRO_LIVE_LOSS_CAP_USD"]);
    assert.match(r.reply, /Setup selesai/);
    // No secret ever requested or stored.
    const blob = JSON.stringify(r.writes) + r.reply;
    assert.ok(!/sk-|PASSPHRASE=|PRIVATE/i.test(blob));
  });

  it("codex without login instructs terminal login instead of dying", () => {
    const r = turn(start(), "1");
    assert.equal(r.state.step, "provider");
    assert.match(r.reply, /codex login/);
  });

  it("wallet create requires YA, then records the minted address", () => {
    let s = start();
    let r = turn(s, "6"); // ollama
    s = r.state;
    r = turn(s, "1", FACTS); // llama3.1
    s = r.state;
    r = turn(s, "1", FACTS); // create
    assert.equal(r.state.step, "wallet_confirm");
    s = r.state;
    // Non-YA backs out without creating.
    r = turn(s, "tidak", FACTS);
    assert.equal(r.state.step, "wallet");
    // YA without a minted address (handler failure) stays put.
    const s2 = { ...s, step: "wallet_confirm" as const };
    r = turn(s2, "YA", FACTS);
    assert.equal(r.state.step, "wallet_confirm");
    // Handler success path carries the address through.
    r = turn(s2, "YA", FACTS, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.equal(r.state.step, "mode");
    assert.equal(
      r.state.newSignerAddress,
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });

  it("wallet create without stored passphrase teaches terminal setup", () => {
    const noPass: OnboardFacts = { ...FACTS, passphraseSet: false };
    let s = start();
    let r = turn(s, "5", noPass);
    s = r.state;
    r = turn(s, "1", noPass);
    s = r.state;
    r = turn(s, "1", noPass);
    assert.equal(r.state.step, "wallet");
    assert.match(r.reply, /telegram setup/);
  });

  it("MICRO_LIVE demands typed confirm + 3 distinct addresses", () => {
    let s = start();
    const seq = ["5", "1", "2"]; // openai, model, keep wallet
    for (const t of seq) s = turn(s, t).state;
    let r = turn(s, "3"); // MICRO_LIVE
    assert.equal(r.state.step, "mode_confirm");
    s = r.state;
    r = turn(s, "nope");
    assert.equal(r.state.step, "capital");
    assert.equal(r.state.mode, "SHADOW");
  });

  it("MICRO_LIVE full path validates distinctness", () => {
    let s = start();
    const seen: Array<[string, string]> = [];
    for (const t of ["5", "1", "2", "3", "MICRO_LIVE"]) {
      const r0 = turn(s, t);
      s = r0.state;
      seen.push(...r0.writes);
    }
    assert.equal(s.step, "account");
    // Signer reuse rejected.
    let r = turn(s, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(r.state.step, "account");
    // Bad format rejected.
    r = turn(s, "not-an-address");
    assert.equal(r.state.step, "account");
    const acct = "0x1111111111111111111111111111111111111111";
    r = turn(s, acct);
    assert.equal(r.state.step, "funder");
    s = r.state;
    seen.push(...r.writes);
    // Funder == account rejected.
    r = turn(s, acct);
    assert.equal(r.state.step, "funder");
    const fund = "0x2222222222222222222222222222222222222222";
    r = turn(s, fund);
    assert.equal(r.state.step, "capital");
    s = r.state;
    seen.push(...r.writes);
    r = turn(s, "100");
    s = r.state;
    seen.push(...r.writes);
    r = turn(s, "500");
    assert.equal(r.state.step, "done");
    seen.push(...r.writes);
    const keys = Object.fromEntries(seen);
    assert.equal(keys["WALLET_ACCOUNT"], acct);
    assert.equal(keys["WALLET_FUNDER"], fund);
    assert.equal(keys["RUNTIME_MODE"], "MICRO_LIVE");
    assert.match(r.reply, /live-promote/);
  });

  it("expired session restarts cleanly", () => {
    const old: OnboardState = { step: "mode", startedAt: 0 };
    const r = turn(old, "1", { ...FACTS, now: 60 * 60_1000 + 1_000_000 });
    assert.equal(r.state.step, "provider");
  });

  it("sessions registry round-trips per user with TTL", () => {
    const s = onboardSessionReset("u1", 1000);
    assert.equal(s.step, "provider");
    assert.deepEqual(onboardSessionGet("u1", 1001), s);
    onboardSessionSet("u1", { ...s, step: "done", startedAt: 1001 });
    assert.equal(onboardSessionGet("u1", 1002), null);
  });

  it("full SHADOW conversation through the real handler persists .env", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readFileSync } = await import("node:fs");
    const home = mkdtempSync(join(tmpdir(), "polyroot-onboard-e2e-"));
    const saved = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const h = buildTelegramHandlers({
        pool: {},
        getOpenExposureUsd: () => 0,
        installDir: "/tmp/polyroot-test",
      } as never);
      const say = (args: string[]) =>
        h["onboard"]!(args, {
          userId: "e2e-1",
          username: "op",
        }) as Promise<string>;
      const intro = await say([]);
      assert.match(intro, /Langkah 1/);
      await say(["5"]); // openai
      await say(["1"]); // gpt-4o-mini
      await say(["2"]); // keep wallet
      const m = await say(["1"]); // SHADOW
      assert.match(m, /SHADOW/);
      await say([""]); // default capital
      const done = await say([""]); // default loss
      assert.match(done, /Setup selesai/);
      const text = readFileSync(join(home, ".polyroot", ".env"), "utf8");
      assert.ok(text.includes("RUNTIME_MODE=SHADOW"));
      assert.ok(text.includes("POLYROOT_FORECAST_MODEL=gpt-4o-mini"));
      assert.ok(!/sk-|PRIVATE/i.test(text));
    } finally {
      if (saved === undefined) delete process.env["HOME"];
      else process.env["HOME"] = saved;
    }
  });

  it("applyOnboardWrites persists to HOME-redirected .env", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { readFileSync, existsSync } = await import("node:fs");
    const home = mkdtempSync(join(tmpdir(), "polyroot-onboard-"));
    const saved = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      const p = onboardPaths();
      assert.ok(p.envPath.startsWith(home));
      applyOnboardWrites([
        ["RUNTIME_MODE", "SHADOW"],
        ["POLYROOT_FORECAST_MODEL", "gpt-4o-mini"],
      ]);
      const text = readFileSync(join(home, ".polyroot", ".env"), "utf8");
      assert.ok(text.includes("RUNTIME_MODE=SHADOW"));
      assert.ok(existsSync(join(home, ".polyroot")));
    } finally {
      if (saved === undefined) delete process.env["HOME"];
      else process.env["HOME"] = saved;
    }
  });
});

describe("provider menu parity (terminal shortlist == wizard)", () => {
  const facts = {
    passphraseSet: true,
    codexReady: true,
    now: 1_000_000,
  };
  it("wizard order mirrors the terminal shortlist, Custom always last", () => {
    const ids = wizardProviderOptions(facts).map((o) => o.id);
    assert.deepEqual(ids, [
      "codex",
      "gemini",
      "openrouter",
      "deepseek",
      "openai",
      "ollama",
      "claude",
      "kimi",
      "custom",
    ]);
  });
  it("saved customs slot in after Kimi, still before Custom", () => {
    const ids = wizardProviderOptions({
      ...facts,
      savedCustoms: [{ name: "mygw", baseUrl: "https://gw.example/v1" }],
    }).map((o) => o.id);
    assert.deepEqual(ids, [
      "codex",
      "gemini",
      "openrouter",
      "deepseek",
      "openai",
      "ollama",
      "claude",
      "kimi",
      "saved:mygw",
      "custom",
    ]);
  });
});
