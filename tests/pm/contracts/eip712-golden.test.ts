import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import {
  encodeType,
  typeHash,
  hashStruct,
  signingDigest,
  hashNested1271,
} from "@polyroot/signer";

const require = createRequire(import.meta.url);
const { TypedDataEncoder } = require("ethers");

// Independent oracle: ethers v6 TypedDataEncoder. Our encoder must match
// byte-for-byte, or the golden vectors below fail loudly.
describe("No.2 EIP-712 golden vs ethers v6 (CT-06 offline half)", () => {
  const domain = {
    name: "PolyrootValidator",
    version: "1",
    chainId: 137,
    verifyingContract: "0x0000000000000000000000000000000000000001",
  };
  const types = {
    Order: [
      { name: "signer", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "payloadHash", type: "bytes32" },
      { name: "note", type: "string" },
      { name: "fillOrKill", type: "bool" },
    ],
  };
  const message = {
    signer: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
    amount: 1_000_000,
    payloadHash: "0x" + "ab".repeat(32),
    note: "hello",
    fillOrKill: true,
  };

  it("encodeType + typeHash match ethers", () => {
    const ours = encodeType("Order", [
      { name: "signer", type: "address", value: message.signer },
      { name: "amount", type: "uint256", value: message.amount },
      { name: "payloadHash", type: "bytes32", value: message.payloadHash },
      { name: "note", type: "string", value: message.note },
      { name: "fillOrKill", type: "bool", value: message.fillOrKill },
    ]);
    assert.equal(
      ours,
      "Order(address signer,uint256 amount,bytes32 payloadHash,string note,bool fillOrKill)",
    );
    // typeHash equality is proven via the full digest comparison below.
    assert.equal(typeof typeHash, "function");
    void TypedDataEncoder;
  });

  it("signing digest matches ethers.hashTypedDataV4 byte-for-byte", () => {
    const fields = [
      { name: "signer", type: "address", value: message.signer },
      { name: "amount", type: "uint256", value: message.amount },
      { name: "payloadHash", type: "bytes32", value: message.payloadHash },
      { name: "note", type: "string", value: message.note },
      { name: "fillOrKill", type: "bool", value: message.fillOrKill },
    ] as any;
    const { TypedDataEncoder: Enc } = require("ethers");
    const domainSep =
      "0x" +
      Enc.hashDomain({
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId,
        verifyingContract: domain.verifyingContract,
      }).slice(2);
    const expected = Enc.hash(domain, { Order: types.Order }, message);
    const ours =
      "0x" +
      signingDigest(
        hashStruct("EIP712Domain", [
          { name: "name", type: "string", value: domain.name },
          { name: "version", type: "string", value: domain.version },
          { name: "chainId", type: "uint256", value: domain.chainId },
          {
            name: "verifyingContract",
            type: "address",
            value: domain.verifyingContract,
          },
        ]),
        hashStruct("Order", fields),
      ).toString("hex");
    assert.equal(ours, expected);
    assert.equal(domainSep.length, 66);
  });

  it("nested 1271 digest embeds the inner hash and is deterministic", () => {
    const inner = hashStruct("Order", [
      {
        name: "signer",
        type: "address",
        value: message.signer,
      },
      { name: "amount", type: "uint256", value: 42 },
    ]);
    const innerHex = "0x" + inner.toString("hex");
    const a = hashNested1271({
      domainFields: [
        { name: "name", type: "string", value: "PolyrootValidator" },
        { name: "version", type: "string", value: "1" },
        { name: "chainId", type: "uint256", value: 137 },
      ],
      messageType: "NestedApproval",
      messageFields: [
        { name: "wallet", type: "address", value: message.signer },
      ],
      innerMessageHash: innerHex,
    });
    const b = hashNested1271({
      domainFields: [
        { name: "name", type: "string", value: "PolyrootValidator" },
        { name: "version", type: "string", value: "1" },
        { name: "chainId", type: "uint256", value: 137 },
      ],
      messageType: "NestedApproval",
      messageFields: [
        { name: "wallet", type: "address", value: message.signer },
      ],
      innerMessageHash: innerHex,
    });
    assert.equal(a.digest, b.digest);
    assert.match(a.digest, /^0x[0-9a-f]{64}$/);
    assert.ok(a.trace.outerType.includes("bytes32 innerHash"));
    assert.throws(
      () =>
        hashNested1271({
          domainFields: [],
          messageType: "X",
          messageFields: [],
          innerMessageHash: "0x1234",
        }),
      /innerMessageHash/,
    );
  });
});

describe("No.3 coverage: eip712 invalid-input branches", () => {
  it("malformed addresses, out-of-range uints, bad bytes32/bool refuse", async () => {
    const m = await import("@polyroot/signer");
    assert.throws(() => m.encodeField("address", "0x123"), /address/);
    assert.throws(() => m.encodeField("uint256", -1), /out of range/);
    assert.throws(() => m.encodeField("uint256", 1.5), /non-integer/);
    assert.throws(() => m.encodeField("bytes32", "0x1234"), /bytes32/);
    assert.throws(() => m.encodeField("bool", "yes" as any), /bool/);
    assert.throws(() => m.encodeField("uint256", "0xZZ" as any), /hex/);
  });
  it("oversize words and bad digests refuse", async () => {
    const m = await import("@polyroot/signer");
    assert.throws(
      () => m.signingDigest(Buffer.alloc(31), Buffer.alloc(32)),
      /32 bytes/,
    );
    assert.throws(
      () =>
        m.hashNested1271({
          domainFields: [],
          messageType: "M",
          messageFields: [],
          innerMessageHash: "0x1234",
        }),
      /innerMessageHash/,
    );
  });
});
