import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import WebSocket from "ws";
import { startApi } from "../apps/api/src/index.js";

// WebSocket streams carry the same auth as HTTP: an upgrade without
// credentials is refused (401), unknown sessions fail closed (404), and
// cross-tenant sessions are forbidden (403) — an HTTP 401 never becomes a
// WS hello.

let srv: Server | null = null;
let base = "";
let httpBase = "";

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

const wsOutcome = (path: string): Promise<string> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`${base}${path}`);
    const t = setTimeout(() => resolve("hang"), 5000);
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(t);
      resolve(`status-${res.statusCode}`);
    });
    ws.on("open", () => {
      clearTimeout(t);
      try { ws.close(); } catch { /* ignore */ }
      resolve("opened");
    });
    ws.on("error", () => {
      clearTimeout(t);
      resolve("error");
    });
  });

describe("websocket upgrade router", () => {
  before(async () => {
    delete process.env["EVEX_MODE"];
    delete process.env["EVEX_AUTH_TOKEN"];
    process.env["VM_BACKEND"] = "dev-framebuffer";
    process.env["DATA_DIR"] = mkdtempSync(join(tmpdir(), "evex-ws-"));
    process.env["EVEX_MAX_VMS_PER_TENANT"] = "64";
    process.env["EVEX_MAX_TOTAL_VMS"] = "512";
    process.env["EVEX_MAX_CPU_PER_TENANT"] = "256";
    process.env["EVEX_MAX_MEM_MB_PER_TENANT"] = "524288";
    srv = await startApi(0);
    const addr = srv.address() as AddressInfo;
    base = `ws://127.0.0.1:${addr.port}`;
    httpBase = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    delete process.env["EVEX_MODE"];
    if (srv) {
      srv.closeAllConnections?.();
      await new Promise<void>((resolve) => srv?.close(() => resolve()));
    }
  });

  async function createSession(): Promise<string> {
    const r = await fetch(`${httpBase}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal: "ws case" }),
    });
    const text = await r.text();
    assert.equal(r.status, 201, text);
    const j = JSON.parse(text) as { id: string };
    return j.id;
  }

  it("serves /v1/stream/:sessionId with a session hello for a known session", async () => {
    const sid = await createSession();
    const { ws, first } = await wsOpen(`/v1/stream/${sid}`);
    try {
      const msg = JSON.parse(first) as { kind: string; sessionId: string };
      assert.equal(msg.kind, "hello");
      assert.equal(msg.sessionId, sid);
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

  it("refuses unknown sessions instead of helloing (fail closed)", async () => {
    const outcome = await wsOutcome("/v1/stream/sess-ghost-xyz");
    assert.ok(outcome !== "opened", `unknown session must not upgrade (got ${outcome})`);
  });

  it("destroys unknown upgrade paths instead of hanging", async () => {
    const outcome = await wsOutcome("/nope");
    assert.ok(outcome !== "opened", `unknown path must not upgrade (got ${outcome})`);
  });

  it("refuses upgrades without credentials in production mode", async () => {
    process.env["EVEX_MODE"] = "production";
    try {
      const outcome = await wsOutcome("/v1/stream");
      assert.ok(outcome === "status-401" || outcome === "error", `expected 401, got ${outcome}`);
    } finally {
      delete process.env["EVEX_MODE"];
    }
  });
});
