import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const ROOT = new URL("../../..", import.meta.url);
function read(rel: string): string {
  return readFileSync(new URL(rel, ROOT), "utf8");
}

function parseComposeService(text: string, name: string): Record<string, any> {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  assert.ok(start >= 0, `service ${name} missing`);
  const out: Record<string, any> = {};
  let current: string | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^  \S/.test(line) && !line.startsWith("    ")) break;
    const kv = line.match(/^    ([A-Za-z_]+):(.*)$/);
    if (kv) {
      current = kv[1] as string;
      const rest = (kv[2] ?? "").trim();
      out[current] = rest === "" ? [] : rest;
      continue;
    }
    const item = line.match(/^      - (.*)$/);
    if (item && current && Array.isArray(out[current])) {
      (out[current] as string[]).push(item[1] as string);
    }
  }
  return out;
}

describe("Phase 29: deployment hardening gate (Blueprint §2/§15)", () => {
  const compose = read("docker-compose.yml");
  const composeProd = read("docker-compose.prod.yml");

  const matrix: Array<{ file: string; text: string; services: string[] }> = [
    {
      file: "docker-compose.yml",
      text: compose,
      services: ["agent", "strategy-worker"],
    },
    { file: "docker-compose.prod.yml", text: composeProd, services: ["agent"] },
  ];

  for (const { file, text, services } of matrix) {
    for (const svc of services) {
      it(`${file} :: ${svc} runs hardened: no-new-privileges, cap_drop ALL, read-only, mem cap`, () => {
        const s = parseComposeService(text, svc);
        assert.ok(
          (s["security_opt"] as string[]).includes("no-new-privileges:true"),
          `${svc} missing no-new-privileges`,
        );
        assert.ok(
          (s["cap_drop"] as string[]).includes("ALL"),
          `${svc} must drop ALL capabilities`,
        );
        assert.equal(s["read_only"], "true", `${svc} must be read-only`);
        assert.match(
          String(s["mem_limit"] ?? ""),
          /^\d+[mg]$/i,
          `${svc} must declare a memory cap`,
        );
      });
    }
  }

  it("strategy socket crosses services only via the shared volume", () => {
    assert.match(compose, /strategy-socket:\/run\/strategy/);
    assert.match(compose, /polyroot-internal/);
  });

  it("migrations seed read-only; pgdata persists (backup/restore posture)", () => {
    assert.match(compose, /\.\/migrations:\/docker-entrypoint-initdb\.d:ro/);
    assert.match(compose, /polyroot_pgdata:/);
  });

  it("no real secrets baked into Dockerfiles or compose (env references only)", () => {
    const prod = read("docker-compose.prod.yml");
    const text =
      compose + prod + read("Dockerfile") + read("Dockerfile.strategy");
    for (const pattern of [
      /AKIA[0-9A-Z]{16}/,
      /-----BEGIN (RSA )?PRIVATE KEY-----/,
      /sk-live-[A-Za-z0-9]+/,
      /PRIVATE_KEY_HEX\s*=\s*["']?[0-9a-f]{32,}/i,
    ]) {
      assert.ok(!pattern.test(text), `secret pattern leaked: ${pattern}`);
    }
    // Wallet keys must arrive via ${VAR} references, never literals.
    for (const [file, body] of [
      ["docker-compose.yml", compose],
      ["docker-compose.prod.yml", prod],
    ] as Array<[string, string]>) {
      assert.match(
        body,
        /WALLET_PRIVATE_KEY:\s*\$\{/,
        `${file}: wallet key must be an env reference`,
      );
    }
  });

  it("Dockerfiles run final stages as non-root with healthchecks", () => {
    for (const file of ["Dockerfile", "Dockerfile.strategy"]) {
      const text = read(file);
      const stages = text.split(/^FROM /m).slice(1);
      const runtime = stages[stages.length - 1] ?? "";
      assert.match(
        runtime,
        /USER nodejs/,
        `${file}: final stage must be non-root`,
      );
      assert.match(
        runtime,
        /HEALTHCHECK/,
        `${file}: runtime needs a HEALTHCHECK`,
      );
    }
  });
});
