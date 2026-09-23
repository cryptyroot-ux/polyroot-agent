/**
 * @polyroot/signer — Minimal EIP-712 core + ERC-7739 nesting (No.2, CT-06).
 *
 * Offline-provable half of the POLY_1271 path: canonical EIP-712 encoding
 * for flat field lists (address, uint256, bytes32, string, bytes, bool),
 * domain separation, and the 0x1901 signing hash — plus the ERC-7739
 * nesting pattern where the outer TypedData message embeds the INNER
 * message hash as bytes32 (so arbitrary nesting collapses to flat
 * encoding; no recursive encoder needed).
 *
 * Scope notes (honest): on-chain `isValidSignature` against the wallet
 * validator contract is G4 (needs chain + validator deployment). What this
 * module proves offline: byte-exact canonical encoding (golden-tested
 * against ethers v6 TypedDataEncoder), deterministic digests, and wrapper
 * structural validation. No network, no keys here.
 */

import keccak256 from "keccak256";

export type Eip712FieldType =
  | "address"
  | "uint256"
  | "bytes32"
  | "string"
  | "bytes"
  | "bool";

export interface Eip712Field {
  name: string;
  type: Eip712FieldType;
  value: string | number | bigint | boolean;
}

function leftPad32(bytes: Buffer): Buffer {
  if (bytes.length > 32) throw new Error("EIP712: value exceeds 32 bytes");
  return Buffer.concat([Buffer.alloc(32 - bytes.length, 0), bytes]);
}

function toBigInt(value: string | number | bigint | boolean): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1n : 0n;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error("EIP712: non-integer number");
    return BigInt(value);
  }
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]*$/.test(hex)) throw new Error("EIP712: bad hex string");
  return BigInt("0x" + (hex === "" ? "0" : hex));
}

/** ABI-encode one atomic value to a 32-byte word (EIP-712 encodeData). */
export function encodeField(type: Eip712FieldType, value: Eip712Field["value"]): Buffer {
  // Built‑in stricter runtime guards – ensure the supplied value truly matches the declared type
  switch (type) {
    case "address": {
      if (typeof value !== "string") {
        throw new Error("EIP712: address value must be a string");
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw new Error("EIP712: address must be 0x + 40 hex chars");
      }
      return leftPad32(Buffer.from(value.slice(2), "hex"));
    }
    case "uint256": {
      if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string") {
        throw new Error("EIP712: uint256 value must be bigint, number, or numeric string");
      }
      const n = toBigInt(value);
      if (n < 0n || n >= 2n ** 256n) throw new Error("EIP712: uint256 out of range");
      return leftPad32(Buffer.from(n.toString(16).padStart(64, "0"), "hex"));
    }
    case "bytes32": {
      if (typeof value !== "string") {
        throw new Error("EIP712: bytes32 value must be a string");
      }
      if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error("EIP712: bytes32 must be 0x + 64 hex chars");
      }
      return Buffer.from(value.slice(2), "hex");
    }
    case "string": {
      if (typeof value !== "string") {
        throw new Error("EIP712: string value must be a string");
      }
      return keccak256(Buffer.from(value, "utf8"));
    }
    case "bytes": {
      if (typeof value !== "string") {
        throw new Error("EIP712: bytes value must be a hex string");
      }
      const bytes = value.startsWith("0x") ? Buffer.from(value.slice(2), "hex") : Buffer.from(value, "utf8");
      return keccak256(bytes);
    }
    case "bool": {
      if (typeof value !== "boolean") {
        throw new Error("EIP712: bool must be boolean");
      }
      return leftPad32(Buffer.from(value ? "01" : "00", "hex"));
    }
  }
  // Unreachable – TypeScript exhaustive check
  throw new Error("EIP712: unknown field type");
}

/** encodeType string, e.g. `Order(address signer,uint256 amount)`. */
export function encodeType(primaryType: string, fields: Eip712Field[]): string {
  return `${primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

/** keccak256 of the UTF-8 encodeType string. */
export function typeHash(primaryType: string, fields: Eip712Field[]): Buffer {
  return keccak256(Buffer.from(encodeType(primaryType, fields), "utf8"));
}

/** hashStruct = keccak256(typeHash ‖ encodeData). */
export function hashStruct(primaryType: string, fields: Eip712Field[]): Buffer {
  const encoded = fields.map((f) => encodeField(f.type, f.value));
  return keccak256(Buffer.concat([typeHash(primaryType, fields), ...encoded]));
}

/** EIP-712 signing digest: keccak256(0x1901 ‖ domainSeparator ‖ messageHash). */
export function signingDigest(domainSeparator: Buffer, messageHash: Buffer): Buffer {
  if (domainSeparator.length !== 32 || messageHash.length !== 32) {
    throw new Error("EIP712: separator and message hash must be 32 bytes");
  }
  return keccak256(Buffer.concat([Buffer.from([0x19, 0x01]), domainSeparator, messageHash]));
}

export interface Nested1271Input {
  /** EIP712Domain fields of the validator-facing domain (chainId, etc.). */
  domainFields: Eip712Field[];
  /** Primary type name of the outer (validator-facing) message. */
  messageType: string;
  /** Outer message fields EXCLUDING the nested inner hash. */
  messageFields: Eip712Field[];
  /** Inner (app) typed-data hash — the nested payload, already hashed. */
  innerMessageHash: string;
  /** Field name carrying the inner hash in the outer message. */
  innerHashField?: string;
}

export interface Nested1271Result {
  /** The 0x1901 digest the wallet validator must see. */
  digest: string;
  /** Canonical encoding trace for audit replay. */
  trace: { outerType: string; innerHash: string };
}

/**
 * ERC-7739-style nesting (offline half): hash the inner app payload FIRST
 * (bytes32), then encode it as a single flat field of the outer message.
 * Returns the outer signing digest plus an audit trace. Contract-call
 * execution against the validator remains G4.
 */
export function hashNested1271(input: Nested1271Input): Nested1271Result {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.innerMessageHash)) {
    throw new Error("7739: innerMessageHash must be 0x + 64 hex chars");
  }
  const fieldName = input.innerHashField ?? "innerHash";
  const outerFields: Eip712Field[] = [
    ...input.messageFields,
    { name: fieldName, type: "bytes32", value: input.innerMessageHash },
  ];
  // Domain separator uses the EIP712Domain type over the domain fields.
  const separator = hashStruct("EIP712Domain", input.domainFields);
  const messageHash = hashStruct(input.messageType, outerFields);
  const digest = signingDigest(separator, messageHash);
  return {
    digest: "0x" + digest.toString("hex"),
    trace: {
      outerType: encodeType(input.messageType, outerFields),
      innerHash: input.innerMessageHash,
    },
  };
}
