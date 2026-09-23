import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleConnection } from "../src/sandbox-supervisor.js";
import { Socket } from "net";

describe("Task 2 — Sandbox supervisor socket cleanup on error", () => {
  it("destroys socket on connection error", () => {
    const socket = new Socket();
    let destroyed = false;
    const origDestroy = socket.destroy.bind(socket);
    socket.destroy = () => {
      destroyed = true;
      return origDestroy();
    };
    // Register handlers via handleConnection
    handleConnection(socket);
    // Emit error - should trigger destroy
    socket.emit("error", new Error("test error"));
    assert.ok(destroyed, "socket.destroy should be called on error");
  });

  it("destroys socket on buffer overflow in handleConnection", () => {
    const socket = new Socket();
    let destroyed = false;
    const origDestroy = socket.destroy.bind(socket);
    socket.destroy = () => {
      destroyed = true;
      return origDestroy();
    };
    handleConnection(socket);
    // Send data exceeding MAX_BUFFER_BYTES
    const largeData = "x".repeat(1_100_000);
    socket.emit("data", largeData);
    assert.ok(destroyed, "socket.destroy should be called on buffer overflow");
  });
});
