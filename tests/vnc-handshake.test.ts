import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { VncRfbInput } from "../packages/computer/src/index.js";

// Both RFB security-negotiation styles observed in the wild must connect;
// anything else must fail closed (never proceed unauthenticated).

// Simpler deterministic fake: full scripted handshake per behavior.
function startScriptedFake(behavior: "standard" | "x11vnc" | "auth-required"): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((conn: Socket) => {
      conn.write(Buffer.from("RFB 003.008\n"));
      let buf = Buffer.alloc(0);
      let step = 0;
      conn.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (step === 0 && buf.length >= 12) {
          buf = buf.subarray(12);
          step = 1;
          if (behavior === "standard") conn.write(Buffer.from([1, 1]));
          else if (behavior === "x11vnc") conn.write(Buffer.from([1]));
          else conn.write(Buffer.from([1, 2]));
        } else if (step === 1 && buf.length >= 1) {
          const sel = buf[0] as number;
          buf = buf.subarray(1);
          if (behavior === "auth-required" || sel !== 1) {
            conn.write(Buffer.from([0, 0, 0, 1]));
            conn.destroy();
            return;
          }
          step = 2;
          conn.write(Buffer.from([0, 0, 0, 0]));
        } else if (step === 2 && buf.length >= 1) {
          buf = buf.subarray(1); // ClientInit shared flag
          step = 3;
          const head = Buffer.alloc(24);
          head.writeUInt16BE(1024, 0);
          head.writeUInt16BE(768, 2);
          head.writeUInt32BE(4, 20); // name "test"
          conn.write(Buffer.concat([head, Buffer.from("test")]));
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? (addr.port as number) : 0;
      resolve({ port, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

describe("VNC RFB handshake styles", () => {
  it("connects with standard 3.8 count+list", async () => {
    const fake = await startScriptedFake("standard");
    try {
      const v = new VncRfbInput();
      const dims = await v.connect("127.0.0.1", fake.port);
      assert.deepEqual(dims, { width: 1024, height: 768 });
      assert.equal(v.connected(), true);
      v.disconnect();
    } finally {
      await fake.close();
    }
  });

  it("connects with x11vnc count-only style", async () => {
    const fake = await startScriptedFake("x11vnc");
    try {
      const v = new VncRfbInput();
      const dims = await v.connect("127.0.0.1", fake.port);
      assert.deepEqual(dims, { width: 1024, height: 768 });
      v.disconnect();
    } finally {
      await fake.close();
    }
  });

  it("refuses auth-required servers without proceeding", async () => {
    const fake = await startScriptedFake("auth-required");
    try {
      const v = new VncRfbInput();
      await assert.rejects(() => v.connect("127.0.0.1", fake.port), /auth|Security/i);
      assert.equal(v.connected(), false);
    } finally {
      await fake.close();
    }
  });
});
