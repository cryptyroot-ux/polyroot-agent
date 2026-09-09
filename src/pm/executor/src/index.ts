/**
 * @polyroot/executor — Order lifecycle, signing, venue routing
 *
 * ONLY THIS PACKAGE HOLDS THE SIGNING KEY (via WalletAdapter).
 *
 * Exports:
 * - Executor: main order lifecycle orchestrator
 * - SignatureRegistry: validates + signs orders
 * - WalletAdapter: abstracts key material (Clef, HSM, Keystore, Test)
 * - OrderRouter: routes to venue adapter
 * - ReconciliationService: handles unknown/cancel/settlement
 */

export { Executor } from "./executor";
export { SignatureRegistry } from "./signing/registry";
export { WalletAdapter, TestWallet, KeystoreWallet } from "./wallet";
export { OrderRouter } from "./routing/router";
export { ReconciliationService } from "./reconciliation";
