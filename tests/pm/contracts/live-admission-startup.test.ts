import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveStartupAdmission, type QueryablePool } from "@polyroot/runtime";
import { signPromotion } from "@polyroot/control";
import { deriveAddressFromPrivateKey } from "@polyroot/signer";

// gitleaks:allow — synthetic test key, never mainnet, never funded.
const OWNER_PK =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

const TUPLE = {
  strategy: "arb-v1",
  profile: "micro",
  fromCapUsd: 100,
  toCapUsd: 500,
  expiresAt: "2030-01-01T00:00:00.000Z",
};

interface FakeDb {
  promotions: unknown[];
  guardHalted: boolean;
  staleUnknowns: number;
  baseline: Record<string, unknown> | null;
  migrations: string[];
  promosMissingTable?: boolean;
}

function fakePool(db: FakeDb): QueryablePool {
  return {
    query: async (text: string) => {
      if (text.includes("FROM live_promotions") && !text.includes("UPDATE")) {
        if (db.promosMissingTable) throw new Error("no such table");
        if (text.includes("revoked_at IS NULL AND expires_at")) {
          return { rows: db.promotions as Record<string, unknown>[] };
        }
        return { rows: db.promotions as Record<string, unknown>[] };
      }
      if (text.includes("FROM live_guard_state")) {
        return {
          rows: db.guardHalted
            ? [{ halted: true, realized_loss_pusd: "75" }]
            : [],
        };
      }
      if (text.includes("FROM recovery_ledger")) {
        if (db.staleUnknowns < 0) throw new Error("db down");
        return { rows: [{ c: String(db.staleUnknowns) }] };
      }
      if (text.includes("FROM shadow_baseline")) {
        return { rows: db.baseline ? [db.baseline] : [] };
      }
      if (text.includes("FROM schema_migrations")) {
        return {
          rows: db.migrations.map((filename) => ({ filename })),
        };
      }
      return { rows: [] };
    },
  };
}

function promoRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  const owner = deriveAddressFromPrivateKey(OWNER_PK);
  const { signature } = signPromotion(OWNER_PK, TUPLE);
  return {
    id: "promo-1",
    strategy: "arb-v1",
    profile: "micro",
    from_cap_usd: 100,
    to_cap_usd: 500,
    expires_at: "2030-01-01T00:00:00.000Z",
    owner_address: owner,
    signature,
    monitoring_json: {
      systemHealth: true,
      venueMode: true,
      accountMode: true,
    },
    rollback_json: {
      triggers: ["drawdown-latch", "kill-switch", "mandate-expiry"],
      steps: ["reduce", "flatten"],
    },
    ...over,
  };
}

function greenDb(): FakeDb {
  return {
    promotions: [promoRow()],
    guardHalted: false,
    staleUnknowns: 0,
    baseline: { observed_days: 45, resolved_clusters: 130 },
    migrations: ["0001_a.sql", "0002_b.sql"],
  };
}

function deps(db: FakeDb, over: Record<string, unknown> = {}) {
  return {
    pool: fakePool(db),
    ownerAddress: deriveAddressFromPrivateKey(OWNER_PK),
    strategy: "arb-v1",
    profile: "micro",
    appliedMigrations: db.migrations,
    shippedMigrations: ["0001_a.sql", "0002_b.sql"],
    manifestLockSha: "abc123",
    runningLockSha: "abc123",
    walletOk: true,
    venueCredsOk: true,
    now: new Date("2027-06-01T00:00:00.000Z"),
    ...over,
  };
}

describe("P0: startup LIVE admission", () => {
  it("admits with valid promotion + green operational gates", async () => {
    const d = await resolveStartupAdmission(deps(greenDb()));
    assert.equal(d.admitted, true);
    assert.equal(d.promotionId, "promo-1");
    assert.deepEqual(d.gates, {
      G0: true,
      G1: true,
      G2: true,
      G3: true,
      G4: true,
    });
  });

  it("absent promotion blocks with grant instructions", async () => {
    const db = greenDb();
    db.promotions = [];
    const d = await resolveStartupAdmission(deps(db));
    assert.equal(d.admitted, false);
    assert.equal(d.code, "PROMOTION_ABSENT");
    assert.match(d.reasons.join(" "), /live-promote/);
  });

  it("wrong-signer promotion blocks", async () => {
    // Attacker key signs the same tuple; expected owner stays the operator.
    const otherPk =
      "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const { signature } = signPromotion(otherPk, TUPLE);
    const db = greenDb();
    db.promotions = [promoRow({ signature })];
    const d = await resolveStartupAdmission(deps(db));
    assert.equal(d.admitted, false);
    assert.equal(d.code, "PROMOTION_WRONG_SIGNER");
  });

  it("missing promotions table (migrations pending) blocks, never throws", async () => {
    const db = greenDb();
    db.promosMissingTable = true;
    const d = await resolveStartupAdmission(deps(db));
    assert.equal(d.admitted, false);
    assert.equal(d.code, "PROMOTION_ABSENT");
  });

  it("engaged loss latch blocks (G2)", async () => {
    const db = greenDb();
    db.guardHalted = true;
    const d = await resolveStartupAdmission(deps(db));
    assert.equal(d.admitted, false);
    assert.ok(d.reasons.some((r) => r.includes("latch")));
    assert.equal(d.gates?.["G2"], false);
  });

  it("stale unknowns block (G2)", async () => {
    const db = greenDb();
    db.staleUnknowns = 3;
    const d = await resolveStartupAdmission(deps(db));
    assert.equal(d.admitted, false);
    assert.ok(d.reasons.some((r) => r.includes("stale unknown")));
  });

  it("short shadow baseline blocks (G4)", async () => {
    const db = greenDb();
    db.baseline = { observed_days: 5, resolved_clusters: 130 };
    const d = await resolveStartupAdmission(deps(db));
    assert.equal(d.admitted, false);
    assert.equal(d.gates?.["G4"], false);
  });

  it("missing wallet key blocks (G3)", async () => {
    const d = await resolveStartupAdmission(
      deps(greenDb(), { walletOk: false }),
    );
    assert.equal(d.admitted, false);
    assert.ok(d.reasons.some((r) => r.includes("wallet")));
  });

  it("lockfile mismatch blocks (G1 code identity)", async () => {
    const d = await resolveStartupAdmission(
      deps(greenDb(), { runningLockSha: "different" }),
    );
    assert.equal(d.admitted, false);
    assert.ok(d.reasons.some((r) => r.startsWith("G1")));
  });

  it("unapplied migration blocks (G0)", async () => {
    const db = greenDb();
    db.migrations = ["0001_a.sql"];
    const d = await resolveStartupAdmission(deps(db));
    assert.equal(d.admitted, false);
    assert.ok(d.reasons.some((r) => r.startsWith("G0")));
  });
});
