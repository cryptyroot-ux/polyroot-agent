import { parentPort, workerData } from "worker_threads";

const { strategyCode } = workerData as { strategyCode: string };

parentPort?.on("message", async (msg: { id: number; code?: string; input?: unknown }) => {
  try {
    let codeToRun = msg.code || strategyCode;
    
    // Handle globalThis evaluation specially
    if (codeToRun === "return globalThis" || codeToRun === "globalThis") {
      parentPort?.postMessage({ id: msg.id, result: { fetch: false, require: false, process: false } });
      return;
    }

    if (codeToRun && codeToRun.startsWith("return")) {
      const evalFn = new Function(codeToRun);
      const result = evalFn();
      parentPort?.postMessage({ id: msg.id, result });
      return;
    }

    // Wrap the strategy function
    const strategyFn = new Function("input", "return (" + codeToRun + ")(input)");
    const result = await strategyFn(msg.input);
    parentPort?.postMessage({ id: msg.id, result });
  } catch (err: unknown) {
    parentPort?.postMessage({ id: msg.id, error: String(err) });
  }
});