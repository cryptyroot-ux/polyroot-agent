import { Worker } from "worker_threads";
import { resolve } from "path";

export interface StrategySandboxClient {
  run(input: any): Promise<any>;
  evalInWorker(code: string): Promise<any>;
  terminate(): Promise<void>;
}

export async function spawnStrategyWorker(opts: { strategyCode: string }): Promise<{ client: StrategySandboxClient; worker: Worker }> {
  const worker = new Worker(resolve(__dirname, "./sandbox-worker.js"), {
    workerData: { strategyCode: opts.strategyCode },
  });
  
  const client: StrategySandboxClient = {
    async run(input: any): Promise<any> {
      return new Promise((resolve, reject) => {
        const id = Date.now();
        worker.postMessage({ id, code: opts.strategyCode, input });
        
        const handleMessage = (msg: any) => {
          if (msg.id === id) {
            if (msg.error) reject(new Error(msg.error));
            else resolve(msg.result);
            worker.removeListener("message", handleMessage);
          }
        };
        worker.on("message", handleMessage);
      });
    },
    
    async evalInWorker(code: string): Promise<any> {
      return new Promise((resolve, reject) => {
        const id = Date.now();
        worker.postMessage({ id, code, input: null });
        
        const handleMessage = (msg: any) => {
          if (msg.id === id) {
            if (msg.error) reject(new Error(msg.error));
            else resolve(msg.result);
            worker.removeListener("message", handleMessage);
          }
        };
        worker.on("message", handleMessage);
      });
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