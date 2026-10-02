import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import WebSocket from "ws";
import { startApi } from "../apps/api/src/index.js";

// Regression: /v1/stream/:sessionId upgrades were destroyed by competing
// upgrade handlers (path-filtered WebSocketServer + manual listener).
// A single upgrade router must serve exact, parameterized, and unknown paths.

let srv: Server | null = null;
let base = "";

const wsOpen = (path: string): Promise<{ ws: WebSocket; first: string }> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}${path}`);
    const t = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error(`ws timeout for ${path}`));
    }, 8000);
    ws.on("message", (m) => {
      clearTimeout(t);
      resolve({ ws, first: String(m) });
    });
    ws.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });

describe("websocket upgrade router", () => {
  before(async () => {
    srv = await startApi(0);
    const addr = srv.address() as AddressInfo;
    base = `ws://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (srv) {
      srv.closeAllConnections?.();
      await new Promise<void>((resolve) => srv?.close(() => resolve()));
    }
  });

  it("serves /v1/stream/:sessionId with a session hello", async () => {
    const { ws, first } = await wsOpen("/v1/stream/sess-router-1");
    try {
      const msg = JSON.parse(first) as { kind: string; sessionId: string };
      assert.equal(msg.kind, "hello");
      assert.equal(msg.sessionId, "sess-router-1");
    } finally {
      ws.close();
    }
  });

  it("serves exact /v1/stream with a hint hello", async () => {
    const { ws, first } = await wsOpen("/v1/stream");
    try {
      const msg = JSON.parse(first) as { kind: string; hint: string };
      assert.equal(msg.kind, "hello");
      assert.ok(msg.hint.includes("sessionId"));
    } finally {
      ws.close();
    }
  });

  it("destroys unknown upgrade paths instead of hanging", async () => {
    const ws = new WebSocket(`${base}/nope`);
    const outcome = await new Promise<string>((resolve) => {
      const t = setTimeout(() => resolve("hang"), 5000);
      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(t);
        resolve(`status-${res.statusCode}`);
      });
      ws.on("open", () => {
        clearTimeout(t);
        resolve("opened");
      });
      ws.on("error", () => {
        clearTimeout(t);
        resolve("error");
      });
    });
    try {
      ws.close();
    } catch { /* ignore */ }
    assert.ok(outcome !== "opened", `unknown path must not upgrade (got ${outcome})`);
  });
});
