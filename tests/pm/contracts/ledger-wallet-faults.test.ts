import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applySettlementEvent,
  initialSettlement,
  applyReceiptOnce,
  reviseRewardEstimate,
  type ReceiptLedger,
} from "@polyroot/ledger";
import {
  submitRelayerOp,
  noteConfirmationTimeout,
  availableToTrade,
} from "@polyroot/control";

describe("Phase 14 FT-33: settlement failure posts compensation (PM-LED-03)", () => {
  it("MATCHED inventory is provisional and NOT spendable", () => {
    const s0 = initialSettlement();
    assert.equal(s0.spendable, false);
    const r = applySettlementEvent(s0, { kind: "MATCH", entry: "J1" });
    assert.equal(r.ok, true);
    if (!r.ok) throw new Error("expected ok");
    assert.equal(r.state.status, "MATCHED");
    assert.equal(r.state.spendable, false);
  });

  it("MATCHED later FAILED posts a compensating entry; still not spendable", () => {
    const s0 = initialSettlement();
    const m = applySettlementEvent(s0, { kind: "MATCH", entry: "J1" });
    assert.equal(m.ok, true);
    if (!m.ok) throw new Error("expected ok");
    const f = applySettlementEvent(m.state, { kind: "FAIL", entry: "J1" });
    assert.equal(f.ok, true);
    if (!f.ok) throw new Error("expected ok");
    assert.equal(f.state.status, "FAILED");
    assert.equal(f.state.spendable, false);
    assert.ok(f.state.journal.includes("COMPENSATE:J1"));
    assert.equal(f.note, "compensating entry posted");
  });

  it("only CONFIRMED holdings are spendable; illegal transitions refuse", () => {
    const c = applySettlementEvent(initialSettlement(), {
      kind: "CONFIRM",
      entry: "J0",
    });
    assert.equal(c.ok, false);
    if (!c.ok) assert.equal(c.code, "SETTLEMENT_INVALID_TRANSITION");
    const m = applySettlementEvent(initialSettlement(), {
      kind: "MATCH",
      entry: "J1",
    });
    assert.equal(m.ok, true);
    if (!m.ok) throw new Error("expected ok");
    const cc = applySettlementEvent(m.state, { kind: "CONFIRM", entry: "J2" });
    assert.equal(cc.ok, true);
    if (!cc.ok) throw new Error("expected ok");
    assert.equal(cc.state.spendable, true);
  });
});

describe("Phase 14 FT-34: double redeem posts exactly once (PM-EXE-08)", () => {
  it("the same receipt delivered twice yields one posting", () => {
    const ledger: ReceiptLedger = { postedIds: new Set(), postingCount: 0 };
    const first = applyReceiptOnce(ledger, "tx_abc/log_1");
    assert.equal(first.ok, true);
    const second = applyReceiptOnce(ledger, "tx_abc/log_1");
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.code, "DUPLICATE_SUPPRESSED");
    assert.equal(ledger.postingCount, 1);
  });

  it("distinct receipts each post once", () => {
    const ledger: ReceiptLedger = { postedIds: new Set(), postingCount: 0 };
    assert.equal(applyReceiptOnce(ledger, "tx_1").ok, true);
    assert.equal(applyReceiptOnce(ledger, "tx_2").ok, true);
    assert.equal(ledger.postingCount, 2);
  });
});

describe("Phase 14 FT-43: reward estimate reversal never funds cash (PM-ECON-03)", () => {
  it("revising the estimate down corrects only the estimate", () => {
    const books = { estimateTotal: 100, confirmedTotal: 40, cashReserved: 25 };
    const revised = reviseRewardEstimate(books, 30);
    assert.equal(revised.estimateTotal, 30);
    assert.equal(revised.confirmedTotal, 40);
    assert.equal(revised.cashReserved, 25);
  });

  it("negative or non-finite estimates are rejected, never posted", () => {
    const books = { estimateTotal: 100, confirmedTotal: 40, cashReserved: 25 };
    assert.throws(() => reviseRewardEstimate(books, -5), /finite non-negative/);
    assert.throws(
      () => reviseRewardEstimate(books, Number.NaN),
      /finite non-negative/,
    );
  });
});

describe("Phase 14 FT-22: relayer ambiguity stays UNKNOWN, no duplicate setup (PM-WALLET-04)", () => {
  it("a delayed confirmation leaves the operation UNKNOWN", () => {
    const first = submitRelayerOp(null, "op_1", 7);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("expected ok");
    assert.equal(first.duplicate, false);
    const { op, outcome } = noteConfirmationTimeout(first.op);
    assert.equal(op.status, "UNKNOWN");
    assert.equal(outcome, "STILL_UNKNOWN");
  });

  it("resubmitting the same operation_id reuses the record (no new nonce, no duplicate setup)", () => {
    const first = submitRelayerOp(null, "op_1", 7);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("expected ok");
    const retry = submitRelayerOp(first.op, "op_1", 7);
    assert.equal(retry.ok, true);
    if (!retry.ok) throw new Error("expected ok");
    assert.equal(retry.duplicate, true);
    assert.equal(retry.op.nonce, 7);
    assert.equal(retry.op.attempts, 2);
  });

  it("a conflicting nonce on an existing id is refused, not forked", () => {
    const first = submitRelayerOp(null, "op_1", 7);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("expected ok");
    const bad = submitRelayerOp(first.op, "op_1", 8);
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.code, "INVALID_NONCE");
  });
});

describe("Phase 14 FT-23: wrong-spender approval authorizes nothing (PM-WALLET-05)", () => {
  it("an owner-EOA approval contributes zero when the wallet spender is required", () => {
    const res = availableToTrade(
      [{ spender: "0xOWNER_EOA", allowance: 10_000 }],
      "0xWALLET_SPENDER",
      10_000,
    );
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.code, "SPENDER_NOT_APPROVED");
      assert.equal(res.availableToTrade, 0);
    }
  });

  it("the exact required spender with allowance yields min(balance, allowance)", () => {
    const res = availableToTrade(
      [
        { spender: "0xOWNER_EOA", allowance: 10_000 },
        { spender: "0xWALLET_SPENDER", allowance: 400 },
      ],
      "0xWALLET_SPENDER",
      10_000,
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.availableToTrade, 400);
  });
});
