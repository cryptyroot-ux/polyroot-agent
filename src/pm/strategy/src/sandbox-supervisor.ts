import { createServer, type Socket } from "net";
import { mkdirSync, existsSync, unlinkSync } from "fs";
import { dirname } from "path";
import { spawnStrategyWorker } from "./sandbox-rpc.js";

function resolveSocketPath(): string {
  const raw = process.env["STRATEGY_RPC_ENDPOINT"] ?? "unix:///run/strategy/strategy.sock";
  return raw.startsWith("unix://") ? raw.slice("unix://".length) : raw;
}

interface SupervisorRequest {
  id: number | string;
  code: string;
  input?: unknown;
}

interface SupervisorResponse {
  id: number | string;
  result?: unknown;
  error?: string;
}

/**
 * Maximum bytes buffered per connection awaiting a newline. The parsed-code
 * limit (CODE_TOO_LARGE) only applies AFTER a full line arrives — without
 * this cap a client can grow `buffer` without bound by never sending `\n`.
 */
export const MAX_BUFFER_BYTES = 1_048_576;

/**
 * Best-effort single-line write. Returns false when the message was NOT
 * sent (destroyed socket, failed write) so callers never throw on a dead
 * peer — previously an uncaught ERR_STREAM_DESTROYED. Backpressure
 * (`write()` returning false) is reported, not silently dropped.
 */
export function writeLine(socket: Socket, msg: SupervisorResponse): boolean {
  if (socket.destroyed || !socket.writable) return false;
  try {
    return socket.write(JSON.stringify(msg) + "\n");
  } catch {
    return false;
  }
}

export async function handleConnection(socket: Socket): Promise<void> {
  let buffer = "";
  socket.setEncoding("utf8");

  socket.on("data", (chunk: string) => {
    buffer += chunk;
    // Fail-closed on buffer abuse: refuse, report, and drop the connection
    // instead of growing memory without bound.
    if (buffer.length > MAX_BUFFER_BYTES) {
      writeLine(socket, { id: "unknown", error: "BUFFER_OVERFLOW" });
      socket.destroy();
      buffer = "";
      return;
    }
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
      if (line.length === 0) continue;
      void handleLine(socket, line);
    }
  });

  socket.on("error", () => {
    if (!socket.destroyed) socket.destroy();
  });
}

async function handleLine(socket: Socket, line: string): Promise<void> {
  let req: SupervisorRequest;
  try {
    req = JSON.parse(line) as SupervisorRequest;
  } catch {
    writeLine(socket, { id: "unknown", error: "INVALID_JSON" });
    return;
  }

  if (typeof req.code !== "string" || req.code.length === 0) {
    writeLine(socket, { id: req.id, error: "MISSING_CODE" });
    return;
  }
  if (req.code.length > 200_000) {
    writeLine(socket, { id: req.id, error: "CODE_TOO_LARGE" });
    return;
  }

  let worker: Awaited<ReturnType<typeof spawnStrategyWorker>>["worker"] | undefined;
  try {
    const spawned = await spawnStrategyWorker({ strategyCode: req.code });
    worker = spawned.worker;
    const result = await spawned.client.run(req.input ?? null);
    writeLine(socket, { id: req.id, result });
  } catch (err: unknown) {
    writeLine(socket, { id: req.id, error: err instanceof Error ? err.message : String(err) });
  } finally {
    try {
      await worker?.terminate();
    } catch {
      // ignore teardown errors
    }
  }
}

export function startSupervisor(socketPath: string = resolveSocketPath()): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const dir = dirname(socketPath);
      mkdirSync(dir, { recursive: true });
      if (existsSync(socketPath)) unlinkSync(socketPath);
    } catch (err: unknown) {
      reject(err);
      return;
    }

    const server = createServer((socket) => {
      void handleConnection(socket);
    });

    server.on("error", (err: unknown) => {
      console.error("Strategy supervisor error:", err);
    });

    server.listen(socketPath, () => {
      console.log("Strategy sandbox supervisor listening on unix://" + socketPath);
      resolve();
    });

    const shutdown = () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
}

const isMain = process.argv[1] !== undefined && process.argv[1].endsWith("sandbox-supervisor.ts");
if (isMain) {
  startSupervisor().catch((err: unknown) => {
    console.error("Supervisor fatal error:", err);
    process.exit(1);
  });
}
