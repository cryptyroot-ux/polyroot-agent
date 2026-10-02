/**
 * @polyroot/control — LIVE admission (owner-signed promotion).
 *
 * Chain: OWNER KEY SIGNS promotion tuple
 *     -> live_promotions row (append-only, revokable)
 *     -> startup verifies signature + expiry + policy (evaluateLivePromotion)
 *     -> G4CoreConfig.liveAdmission (the gate only consumes this decision)
 *
 * Single-operator model: the expected signer is the agent's own wallet
 * signer (WALLET_ADDRESS). Multisig / delegated owners are out of scope.
 * Signatures are Ethereum-style secp256k1 over keccak256(tuple), encoded
 * 0x + r(32) + s(32) + v(1, 27/28). Pure functions: no I/O, fully tested.
 */

import elliptic from "elliptic";
import keccak256 from "keccak256";
import {
  evaluateLivePromotion,
  type CapitalPromotion,
  type GateId,
  type MonitoringDeclaration,
  type RollbackPlan,
} from "./live-promotion.js";

const { ec: ECClass } = elliptic;
const ec = new ECClass("secp256k1");

export interface PromotionTuple {
  strategy: string;
  profile: string;
  fromCapUsd: number;
  toCapUsd: number;
  /** ISO-8601 expiry, UTC. */
  expiresAt: string;
}

/** Canonical bytes owner signs — changing ANY field voids the signature. */
export function canonicalPromotionMessage(t: PromotionTuple): string {
  return [
    "POLYROOT_LIVE_PROMOTION",
    t.strategy,
    t.profile,
    String(t.fromCapUsd),
    String(t.toCapUsd),
    t.expiresAt,
  ].join("|");
}

export function hashPromotionMessage(message: string): string {
  return "0x" + keccak256(Buffer.from(message, "utf8")).toString("hex");
}

function normalizeHex(hex: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]{64}$/.test(h)) {
    throw new Error("PROMOTION_KEY_INVALID: expected 32-byte hex");
  }
  return h.toLowerCase();
}

function addressFromUncompressedPubkey(pubkey: Buffer): string {
  const bytes = pubkey[0] === 0x04 ? pubkey.slice(1) : pubkey;
  const hash = keccak256(bytes);
  return "0x" + hash.slice(-20).toString("hex");
}

/** Owner signs the canonical tuple with the agent wallet key. */
export function signPromotion(
  privateKeyHex: string,
  tuple: PromotionTuple,
): { signature: string; messageHash: string } {
  const key = ec.keyFromPrivate(normalizeHex(privateKeyHex));
  const messageHash = hashPromotionMessage(canonicalPromotionMessage(tuple));
  const sig = key.sign(Buffer.from(messageHash.slice(2), "hex"), {
    canonical: true,
  });
  const r = sig.r.toArrayLike(Buffer, "be", 32);
  const s = sig.s.toArrayLike(Buffer, "be", 32);
  const v = Buffer.from([(sig.recoveryParam ?? 0) + 27]);
  return {
    signature: "0x" + Buffer.concat([r, s, v]).toString("hex"),
    messageHash,
  };
}

/** Recover the signer address from a promotion signature (no key needed). */
export function recoverPromotionSigner(
  tuple: PromotionTuple,
  signatureHex: string,
): string {
  const sig = (
    signatureHex.startsWith("0x") ? signatureHex.slice(2) : signatureHex
  ).toLowerCase();
  if (!/^[0-9a-fA-F]{130}$/.test(sig)) {
    throw new Error("PROMOTION_SIG_MALFORMED: expected 65-byte 0x hex");
  }
  const r = sig.slice(0, 64);
  const s = sig.slice(64, 128);
  const v = parseInt(sig.slice(128, 130), 16);
  if (v !== 27 && v !== 28) {
    throw new Error("PROMOTION_SIG_MALFORMED: bad recovery id");
  }
  const messageHash = hashPromotionMessage(canonicalPromotionMessage(tuple));
  const pub = ec.recoverPubKey(
    Buffer.from(messageHash.slice(2), "hex"),
    { r, s },
    v - 27,
  );
  return addressFromUncompressedPubkey(Buffer.from(pub.encode("array", false)));
}

export interface AdmissionInput {
  tuple: PromotionTuple;
  signature: string;
  /** Expected owner (agent wallet signer) address. */
  ownerAddress: string;
  gates: Record<GateId, boolean>;
  monitoring: MonitoringDeclaration;
  rollback: RollbackPlan;
  now?: Date;
}

export interface AdmissionDecision {
  admitted: boolean;
  promotionId?: string;
  reasons: string[];
  code?: string;
}

/**
 * Full admission verdict: cryptographic owner proof AND policy gates.
 * Either leg failing blocks. Never throws on hostile input (returns BLOCKED).
 */
export function resolveLiveAdmission(input: AdmissionInput): AdmissionDecision {
  const now = input.now ?? new Date();
  let recovered: string;
  try {
    recovered = recoverPromotionSigner(input.tuple, input.signature);
  } catch (err) {
    return {
      admitted: false,
      code: "PROMOTION_SIG_INVALID",
      reasons: [`promotion signature unreadable: ${(err as Error).message}`],
    };
  }
  if (recovered.toLowerCase() !== input.ownerAddress.toLowerCase()) {
    return {
      admitted: false,
      code: "PROMOTION_WRONG_SIGNER",
      reasons: [
        `promotion signed by ${recovered}, expected owner ${input.ownerAddress}`,
      ],
    };
  }
  const expiry = new Date(input.tuple.expiresAt);
  if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= now.getTime()) {
    return {
      admitted: false,
      code: "PROMOTION_EXPIRED",
      reasons: ["promotion expired"],
    };
  }
  const promotion: CapitalPromotion = {
    fromCapUsd: input.tuple.fromCapUsd,
    toCapUsd: input.tuple.toCapUsd,
    ownerAuth: input.signature,
    expiresAt: input.tuple.expiresAt,
  };
  const verdict = evaluateLivePromotion({
    strategy: input.tuple.strategy,
    profile: input.tuple.profile,
    gates: input.gates,
    promotion,
    monitoring: input.monitoring,
    rollback: input.rollback,
    now,
  });
  if (verdict.decision !== "PROMOTE_TO_LIVE") {
    return {
      admitted: false,
      code: verdict.code,
      reasons: verdict.reasons,
    };
  }
  return {
    admitted: true,
    reasons: [
      `owner-signed promotion verified (signer ${recovered})`,
      ...verdict.reasons,
    ],
  };
}
