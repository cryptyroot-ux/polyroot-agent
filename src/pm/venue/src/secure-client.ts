/**
 * @polyroot/venue — Authenticated Polymarket secure-client factory.
 *
 * Builds the real `@polymarket/client` `SecureClient` used by the live CLI
 * path (SHADOW reads, MICRO_LIVE/LIVE submission). Fail-closed by
 * construction: every required credential is validated up front and a
 * precise `SECURE_CLIENT_ENV_MISSING` error names what is absent.
 *
 * Unit tests must never touch the network: `buildLiveVenueAdapter` accepts
 * an injected `createClient` so tests assert the exact options (signer,
 * wallet, credentials) without calling Polymarket.
 */

import { JsonRpcProvider, Wallet } from "ethers";
import {
  createPublicClient,
  createSecureClient,
  type Signer as SdkSigner,
  type TypedDataPayload,
} from "@polymarket/client";
import {
  PolymarketVenueAdapter,
  type PolymarketClientLike,
} from "./polymarket-adapter.js";

export interface SecureClientEnv {
  privateKeyHex: string;
  wallet?: string | undefined;
  rpcUrl: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
}

/**
 * Validate live-venue env. API credentials are REQUIRED (reuse mode):
 * deriving fresh credentials would need interactive signing flows that a
 * headless agent must never trigger implicitly.
 */
export function readSecureClientEnv(
  env: NodeJS.ProcessEnv = process.env,
): SecureClientEnv {
  const key = env["PRIVATE_KEY_HEX"] ?? env["WALLET_PRIVATE_KEY"];
  const missing: string[] = [];
  if (!key) missing.push("PRIVATE_KEY_HEX (or WALLET_PRIVATE_KEY)");
  if (!env["WALLET_ACCOUNT"]) missing.push("WALLET_ACCOUNT");
  if (!env["RPC_URL"]) missing.push("RPC_URL");
  if (!env["POLYMARKET_API_KEY"]) missing.push("POLYMARKET_API_KEY");
  if (!env["POLYMARKET_API_SECRET"]) missing.push("POLYMARKET_API_SECRET");
  if (!env["POLYMARKET_API_PASSPHRASE"])
    missing.push("POLYMARKET_API_PASSPHRASE");
  if (missing.length > 0) {
    throw new Error(
      `SECURE_CLIENT_ENV_MISSING: ${missing.join(", ")} required to build the Polymarket secure client`,
    );
  }
  return {
    privateKeyHex: key as string,
    wallet: env["WALLET_ACCOUNT"],
    rpcUrl: env["RPC_URL"] as string,
    apiKey: env["POLYMARKET_API_KEY"] as string,
    apiSecret: env["POLYMARKET_API_SECRET"] as string,
    apiPassphrase: env["POLYMARKET_API_PASSPHRASE"] as string,
  };
}

/**
 * Adapt an ethers v6 wallet to the SDK `Signer` interface. Signing stays
 * fully offline; `sendTransaction` routes through the Polygon RPC provider
 * (used by SDK wallet-setup flows, never by the order path).
 */
export function buildSdkSigner(
  privateKeyHex: string,
  rpcUrl: string,
): SdkSigner {
  const normalized = privateKeyHex.startsWith("0x")
    ? privateKeyHex
    : `0x${privateKeyHex}`;
  const wallet = new Wallet(normalized, new JsonRpcProvider(rpcUrl));
  // Single structural cast: the SDK brands address/signature strings, but
  // runtime behavior (derived address, 65-byte signatures) is asserted by
  // contract tests, not by the brand tags.
  return {
    getAddress: () => wallet.getAddress(),
    signMessage: (message: string) => wallet.signMessage(message),
    signTypedData: (payload: TypedDataPayload) =>
      wallet.signTypedData(
        payload.domain as Parameters<Wallet["signTypedData"]>[0],
        payload.types as Parameters<Wallet["signTypedData"]>[1],
        payload.message as Parameters<Wallet["signTypedData"]>[2],
      ),
    sendTransaction: (async (request: never) => {
      const tx = await wallet.sendTransaction(
        request as Parameters<Wallet["sendTransaction"]>[0],
      );
      return {
        transactionHash: tx.hash,
        transactionId: null,
        wait: async () => {
          const receipt = await tx.wait();
          return {
            transactionHash: tx.hash,
            transactionId: null,
            status: receipt?.status === 1 ? "success" : "failed",
          };
        },
      };
    }) as never,
  } as unknown as SdkSigner;
}

/**
 * Public (unauthenticated) adapter for SHADOW mode: live market reads with
 * zero secrets. Construction performs no network I/O; calls fail with the
 * usual transport errors only when actually used.
 */
export function buildPublicVenueAdapter(): PolymarketVenueAdapter {
  const client = createPublicClient();
  return new PolymarketVenueAdapter(client as unknown as PolymarketClientLike);
}

export interface VenueCheckResult {
  ok: boolean;
  assetId: string;
  yesPrice?: number | undefined;
  noPrice?: number | undefined;
  detail: string;
}

/**
 * Read-only connectivity probe: fetch one order book and report prices.
 * Used by `polyroot venue check` so operators verify live reads without
 * starting the agent. Accepts an injected adapter for offline tests.
 */
export async function runVenueCheck(
  assetId: string,
  deps: { adapter?: PolymarketVenueAdapter } = {},
): Promise<VenueCheckResult> {
  const adapter = deps.adapter ?? buildPublicVenueAdapter();
  try {
    const snap = await adapter.getOrderBook(assetId);
    if (snap.yes_price === undefined && snap.no_price === undefined) {
      return {
        ok: false,
        assetId,
        detail: `no live prices for ${assetId} (empty book or unknown market)`,
      };
    }
    return {
      ok: true,
      assetId,
      yesPrice: snap.yes_price,
      noPrice: snap.no_price,
      detail: `YES ${snap.yes_price ?? "—"} / NO ${snap.no_price ?? "—"}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, assetId, detail: `venue read failed: ${msg}` };
  }
}

export async function buildLiveVenueAdapter(
  env: NodeJS.ProcessEnv = process.env,
  overrides: {
    createClient?: typeof createSecureClient;
  } = {},
): Promise<PolymarketVenueAdapter> {
  const cfg = readSecureClientEnv(env);
  const signer = buildSdkSigner(cfg.privateKeyHex, cfg.rpcUrl);
  const create = overrides.createClient ?? createSecureClient;
  const client = await create({
    signer,
    wallet: cfg.wallet,
    credentials: {
      key: cfg.apiKey,
      secret: cfg.apiSecret,
      passphrase: cfg.apiPassphrase,
    },
  } as Parameters<typeof createSecureClient>[0]);
  // Structural cast at a single wiring point: the real SecureClient carries
  // the full SDK surface; the adapter only depends on the Like-shape subset.
  return new PolymarketVenueAdapter(client as unknown as PolymarketClientLike);
}
