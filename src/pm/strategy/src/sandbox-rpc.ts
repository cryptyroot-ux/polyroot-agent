import { Worker } from "worker_threads";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface StrategySandboxClient {
  run(input: any): Promise<any>;
  evalInWorker(code: string): Promise<any>;
  terminate(): Promise<void>;
}

export async function spawnStrategyWorker(opts: {
  strategyCode: string;
  /**
   * Per-request timeout in ms. A worker that never replies (infinite loop,
   * deadlock, crash without exit) rejects with WORKER_TIMEOUT instead of
   * hanging the caller — and the leaked listener is always removed.
   */
  timeoutMs?: number;
}): Promise<{ client: StrategySandboxClient; worker: Worker }> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const worker = new Worker(resolve(HERE, "./sandbox-worker.js"), {
    workerData: { strategyCode: opts.strategyCode },
  });

  function callWorker(message: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = Date.now() + Math.random();
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeListener("message", handleMessage);
        worker.removeListener("error", handleError);
        worker.removeListener("exit", handleExit);
      };
      const handleMessage = (msg: any) => {
        if (msg?.id === id && !settled) {
          settled = true;
          cleanup();
          if (msg.error) reject(new Error(msg.error));
          else resolve(msg.result);
        }
      };
      // A worker crash/throw surfaces here — previously an unhandled
      // 'error' event that also left the caller hanging forever.
      const handleError = (err: unknown) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      };
      const handleExit = (code: number) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(`WORKER_EXITED: code ${code}`));
        }
      };
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(`WORKER_TIMEOUT: no reply within ${timeoutMs}ms`));
        }
      }, timeoutMs);
      worker.on("message", handleMessage);
      worker.once("error", handleError);
      worker.once("exit", handleExit);
      worker.postMessage({ ...(message as object), id });
    });
  }

  const client: StrategySandboxClient = {
    async run(input: any): Promise<any> {
      return callWorker({ code: opts.strategyCode, input });
    },

    async evalInWorker(code: string): Promise<any> {
      return callWorker({ code, input: null });
    },
    
    async terminate(): Promise<void> {
      return new Promise((resolve) => {
        worker.terminate();
        resolve();
      });
    }
  };
  
  return { client, worker };
}