import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateWalletMapping } from "@polyroot/signer";

function wallet(over: Record<string, any> = {}) {
  return {
    wallet_type: "EOA",
    signer_address: "0xSIGNER",
    account_wallet: "0xACCOUNT",
    funder: "0xFUNDER",
    ...over,
  } as any;
}

describe("Phase 17 CT-04/05/06: wallet mapping, G0 half (PM-WALLET-01)", () => {
  it("EOA with distinct identities selects the direct path", () => {
    const r = validateWalletMapping({ wallet: wallet() });
    assert.equal(r.ok, true);
  });

  it("CT-04 POLY_PROXY requires a complete owner/funder/proxy binding", () => {
    const ok = validateWalletMapping({
      wallet: wallet({ wallet_type: "POLY_PROXY" }),
    });
    assert.equal(ok.ok, true);
    const missing = validateWalletMapping({
      wallet: wallet({ wallet_type: "POLY_PROXY", funder: "" }),
    });
    assert.equal(missing.ok, false);
  });

  it("CT-05 GNOSIS_SAFE requires a complete safe/funder binding", () => {
    const ok = validateWalletMapping({
      wallet: wallet({ wallet_type: "GNOSIS_SAFE" }),
    });
    assert.equal(ok.ok, true);
    const missing = validateWalletMapping({
      wallet: wallet({ wallet_type: "GNOSIS_SAFE", account_wallet: "" }),
    });
    assert.equal(missing.ok, false);
  });

  it("WAL-03 distinctness is enforced for every wallet type", () => {
    for (const t of ["EOA", "POLY_PROXY", "GNOSIS_SAFE", "POLY_1271"] as const) {
      const r = validateWalletMapping({
        wallet: wallet({ wallet_type: t, funder: "0xSIGNER" }),
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, "WALLET_NOT_DISTINCT");
    }
  });

  it("CT-06 POLY_1271 refuses without a 1271 wrapper (unsupported-for-LIVE)", () => {
    const r = validateWalletMapping({ wallet: wallet({ wallet_type: "POLY_1271" }) });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "POLY_1271_UNSUPPORTED");
    const withWrapper = validateWalletMapping({
      wallet: wallet({ wallet_type: "POLY_1271" }),
      supports1271: true,
    });
    assert.equal(withWrapper.ok, true);
  });
});
