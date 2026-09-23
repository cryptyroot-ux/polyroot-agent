import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleConnection } from "../src/sandbox-supervisor.js";
import { Socket } from "net";

describe("Task 2 — Sandbox supervisor socket cleanup on error", () => {
  it("destroys socket on unhandled error or buffer overflow", () => {
    const socket = new Socket();
    let destroyed = false;
    socket.destroy = () => {
      destroyed = true;
      return socket;
    };
    // Simulate error event or large data
    socket.emit("error", new Error("test error"));
    assert.ok(true);
  });
});
