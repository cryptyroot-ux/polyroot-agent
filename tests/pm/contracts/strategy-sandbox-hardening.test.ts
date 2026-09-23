import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { spawnStrategyWorker } from "@polyroot/strategy/sandbox-rpc";
import {
  handleConnection,
  writeLine,
  MAX_BUFFER_BYTES,
} from "@polyroot/strategy/sandbox-supervisor";

function fakeSocket(opts: { destroyed?: boolean; throwOnWrite?: boolean } = {}) {
  const emitter = new EventEmitter() as EventEmitter & {
    setEncoding: (enc: string) => void;
    write: (data: string) => boolean;
    destroy: () => void;
    destroyed: boolean;
    writable: boolean;
    written: string[];
    destroyCalled: boolean;
  };
  emitter.setEncoding = () => undefined;
  emitter.written = [];
  emitter.destroyCalled = false;
  emitter.destroyed = opts.destroyed ?? false;
  emitter.writable = !(opts.destroyed ?? false);
  emitter.write = (data: string) => {
    if (opts.throwOnWrite) throw new Error("ERR_STREAM_DESTROYED");
    emitter.written.push(data);
    return true;
  };
  emitter.destroy = () => {
    emitter.destroyCalled = true;
    emitter.destroyed = true;
  };
  return emitter;
}

describe("Take-over audit: sandbox hardening (#7 worker timeout)", () => {
  it("a never-resolving worker rejects with WORKER_TIMEOUT instead of hanging", async () => {
    const { client, worker } = await spawnStrategyWorker({
      strategyCode: "(input) => new Promise(() => {})",
      timeoutMs: 100,
    });
    try {
      await assert.rejects(client.run(null), /WORKER_TIMEOUT/);
    } finally {
      await worker.terminate();
    }
  });

  it("evalInWorker honors the timeout as well", async () => {
    const { client, worker } = await spawnStrategyWorker({
      strategyCode: "return 1",
      timeoutMs: 100,
    });
    try {
      await assert.rejects(
        client.evalInWorker("(input) => new Promise(() => {})"),
        /WORKER_TIMEOUT/,
      );
    } finally {
      await worker.terminate();
    }
  });
});

describe("Take-over audit: socket hardening (#8 buffer cap, #9 writeLine guard)", () => {
  it("unbounded line-less input is refused with BUFFER_OVERFLOW and the socket destroyed", async () => {
    const socket = fakeSocket();
    await handleConnection(socket as any);
    socket.emit("data", "x".repeat(MAX_BUFFER_BYTES + 1));
    assert.equal(socket.destroyCalled, true);
    assert.match(socket.written.join(""), /BUFFER_OVERFLOW/);
  });

  it("normal newline-delimited input is still processed (no false positive)", async () => {
    const socket = fakeSocket();
    await handleConnection(socket as any);
    socket.emit(
      "data",
      JSON.stringify({ id: 1, code: "return 1" }) + "\n",
    );
    // Poll for the reply instead of a fixed sleep: worker spawn time
    // varies under parallel-suite load; a fixed timeout flakes.
    const deadline = Date.now() + 30_000;
    while (
      !socket.written.join("").includes('"result":1') &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(socket.destroyCalled, false);
    assert.match(socket.written.join(""), /"result":1/);
  });

  it("writeLine on a destroyed socket returns false instead of throwing", () => {
    assert.equal(writeLine(fakeSocket({ destroyed: true }) as any, { id: 1 }), false);
  });

  it("writeLine swallows a throwing write and returns false", () => {
    assert.equal(
      writeLine(fakeSocket({ throwOnWrite: true }) as any, { id: 1 }),
      false,
    );
  });
});
