import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer } from "node:net";
import {
  assertSingleInstance,
  isAddrInUse,
  AgentAlreadyRunningError,
} from "@polyroot/runtime";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port =
        typeof addr === "object" && addr !== null ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function occupy(port: number) {
  const s = createServer();
  return new Promise<{ close: () => Promise<void> }>((resolve, reject) => {
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => {
      resolve({
        close: () =>
          new Promise<void>((done) => {
            s.close(() => done());
          }),
      });
    });
  });
}

describe("single-instance guard", () => {
  it("resolves on a free port with no unit (normal start)", async () => {
    const port = await freePort();
    await assertSingleInstance(
      { port, skipSystemdCheck: true },
      { portInUse: async () => false },
    );
  });

  it("refuses a bound metrics port with management hints", async () => {
    const port = await freePort();
    const held = await occupy(port);
    try {
      await assert.rejects(
        assertSingleInstance(
          { port, skipSystemdCheck: true },
          {},
        ),
        (err: unknown) =>
          err instanceof AgentAlreadyRunningError &&
          /already bound/.test(err.message) &&
          /systemctl/.test(err.message),
      );
    } finally {
      await held.close();
    }
  });

  it("refuses when the systemd unit is active (injected, no systemd needed)", async () => {
    const port = await freePort();
    await assert.rejects(
      assertSingleInstance(
        { port },
        {
          readUnitState: () =>
            "LoadState=loaded\nActiveState=active\nMainPID=1234\n",
          portInUse: async () => false,
        },
      ),
      (err: unknown) =>
        err instanceof AgentAlreadyRunningError &&
        /systemd/.test(err.message) &&
        /1234/.test(err.message) &&
        /double-trade/.test(err.message),
    );
  });

  it("inactive unit + free port resolves", async () => {
    const port = await freePort();
    await assertSingleInstance(
      { port },
      {
        readUnitState: () =>
          "LoadState=loaded\nActiveState=inactive\nMainPID=0\n",
        portInUse: async () => false,
      },
    );
  });

  it("POLYROOT_NO_SYSTEMD skips the unit check", async () => {
    const prev = process.env["POLYROOT_NO_SYSTEMD"];
    process.env["POLYROOT_NO_SYSTEMD"] = "1";
    try {
      const port = await freePort();
      await assertSingleInstance(
        { port },
        {
          readUnitState: () =>
            "LoadState=loaded\nActiveState=active\nMainPID=99\n",
          portInUse: async () => false,
        },
      );
    } finally {
      if (prev === undefined) delete process.env["POLYROOT_NO_SYSTEMD"];
      else process.env["POLYROOT_NO_SYSTEMD"] = prev;
    }
  });

  it("isAddrInUse recognizes bind conflicts only", () => {
    assert.equal(isAddrInUse({ code: "EADDRINUSE" }), true);
    assert.equal(isAddrInUse({ code: "ECONNREFUSED" }), false);
    assert.equal(isAddrInUse(null), false);
    assert.equal(isAddrInUse("EADDRINUSE"), false);
  });
});
