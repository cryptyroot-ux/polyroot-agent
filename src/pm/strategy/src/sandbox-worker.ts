import { parentPort, workerData } from "worker_threads";
import vm from "node:vm";

const { strategyCode } = workerData as { strategyCode: string };

/**
 * Interim hardening (P1): strategy code runs in a `vm` context with a
 * minimal global allow-list — no process, fetch, require, Worker, sockets,
 * or filesystem. Synchronous runaways die on VM_TIMEOUT_MS (stronger than
 * the rpc-level timeout, which only covers async hangs).
 *
 * HONEST LIMIT: `vm` is NOT a security boundary (documented V8 escapes
 * exist). This raises the bar from "wide open" to "casual escape closed".
 * True hostile-code isolation (separate uid + seccomp + netns + read-only
 * fs, no secret env) is tracked separately and is REQUIRED before running
 * untrusted third-party strategies with real money.
 */
const VM_TIMEOUT_MS = 5_000;

const SAFE_GLOBALS: Record<string, unknown> = {
  Math,
  JSON,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Date,
  RegExp,
  Error,
  Map,
  Set,
  isFinite,
  isNaN,
  parseFloat,
  parseInt,
  encodeURIComponent,
  decodeURIComponent,
};

function runSandboxed(codeToRun: string, input: unknown): unknown {
  const context = vm.createContext({ ...SAFE_GLOBALS, input });
  const wrapped = codeToRun.startsWith("return")
    ? `(function(input){ ${codeToRun} })(input)`
    : `((${codeToRun}))(input)`;
  return vm.runInContext(wrapped, context, { timeout: VM_TIMEOUT_MS });
}

parentPort?.on(
  "message",
  async (msg: { id: number; code?: string; input?: unknown }) => {
    try {
      const codeToRun = msg.code || strategyCode;
      const result = await runSandboxed(codeToRun, msg.input);
      parentPort?.postMessage({ id: msg.id, result });
    } catch (err: unknown) {
      parentPort?.postMessage({ id: msg.id, error: String(err) });
    }
  },
);
