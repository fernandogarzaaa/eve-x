import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { buildApp, ensureOptionals, hydrateFromDisk, __clearMemory, metricsSnapshot } from "../apps/api/src/index.js";
import { startHttp } from "../apps/mcp/src/index.js";

// Observability + resource bounds: deterministic failure behavior is
// counted and exposed, floods fail predictably (429) instead of
// accumulating unbounded state.

const MASTER = "test-master-obs-limits";

describe("api metrics counters", () => {
  let base = "";
  let srv: Server | null = null;

  before(async () => {
    process.env["DATA_DIR"] = mkdtempSync(join(tmpdir(), "evex-obs-"));
    process.env["EVEX_AUTH_TOKEN"] = MASTER;
    process.env["VM_BACKEND"] = "dev-framebuffer";
    process.env["EVEX_MAX_VMS_PER_TENANT"] = "64";
    process.env["EVEX_MAX_TOTAL_VMS"] = "512";
    delete process.env["EVEX_TENANT"];
    await ensureOptionals();
    __clearMemory();
    const app = buildApp();
    hydrateFromDisk();
    const s = createServer(app);
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
    srv = s;
    base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => srv?.close(() => resolve()));
  });

  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${MASTER}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json: json as Record<string, unknown>, text: typeof json === "string" ? json : "" };
  }

  it("counts stale rejections and exposes them on /metrics", async () => {
    const s = await api("POST", "/v1/sessions", { goal: "metrics case" });
    assert.equal(s.status, 201);
    const sid = String(s.json["id"]);
    const bad = await api("POST", `/v1/computer/${sid}/act`, { type: "wait", confidence: 0.5, frameId: "frame-ancient" });
    assert.equal(bad.status, 409);
    const m = await fetch(`${base}/metrics`);
    assert.equal(m.status, 200);
    const text = await m.text();
    assert.match(text, /evex_sessions \d+/);
    assert.match(text, /evex_stale_rejected [1-9]\d*/);
    const snap = metricsSnapshot();
    assert.ok((snap.counters["stale_rejected"] ?? 0) >= 1);
    assert.ok(snap.gauges["sessions_active"] >= 1);
  });

  it("counts validation verdicts", async () => {
    const t = await api("POST", "/v1/tasks/start", { goal: "metrics validation" });
    assert.equal(t.status, 201);
    const tid = String(t.json["id"]);
    const v = await api("POST", `/v1/tasks/${tid}/validate`, {});
    assert.equal(v.status, 400);
    const snap = metricsSnapshot();
    assert.deepEqual(Object.keys(snap.counters).filter((k) => k.startsWith("validation_")).length, 4);
  });
});

describe("websocket flood discipline", () => {
  let srv: Server | null = null;
  let wsBase = "";
  let httpBase = "";

  before(async () => {
    delete process.env["EVEX_MODE"];
    delete process.env["EVEX_AUTH_TOKEN"];
    process.env["VM_BACKEND"] = "dev-framebuffer";
    process.env["DATA_DIR"] = mkdtempSync(join(tmpdir(), "evex-wsflood-"));
    process.env["EVEX_MAX_WS_PER_SESSION"] = "1";
    srv = await (await import("../apps/api/src/index.js")).startApi(0);
    const addr = srv.address() as AddressInfo;
    wsBase = `ws://127.0.0.1:${addr.port}`;
    httpBase = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    delete process.env["EVEX_MAX_WS_PER_SESSION"];
    if (srv) {
      srv.closeAllConnections?.();
      await new Promise<void>((resolve) => srv?.close(() => resolve()));
    }
  });

  it("second concurrent stream on a capped session gets 429, not a hang", async () => {
    const r = await fetch(`${httpBase}/v1/sessions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ goal: "flood case" }),
    });
    assert.equal(r.status, 201);
    const sid = String(((await r.json()) as { id: string }).id);
    const first = new WebSocket(`${wsBase}/v1/stream/${sid}`);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("first stream never opened")), 8000);
      first.on("message", () => { clearTimeout(t); resolve(); });
      first.on("error", reject);
    });
    try {
      const outcome: string = await new Promise((resolve) => {
        const second = new WebSocket(`${wsBase}/v1/stream/${sid}`);
        const t = setTimeout(() => resolve("hang"), 5000);
        second.on("unexpected-response", (_req, res) => { clearTimeout(t); resolve(`status-${res.statusCode}`); });
        second.on("open", () => { clearTimeout(t); resolve("opened"); });
        second.on("error", () => { clearTimeout(t); resolve("error"); });
      });
      assert.equal(outcome, "status-429", `expected 429 flood refusal, got ${outcome}`);
    } finally {
      try { first.close(); } catch { /* ignore */ }
    }
  });
});

describe("mcp flood discipline", () => {
  it("rate-limits /mcp with 429 + Retry-After (health untouched)", async () => {
    delete process.env["EVEX_MCP_TOKEN"];
    delete process.env["EVEX_AUTH_TOKEN"];
    process.env["EVEX_MCP_RATE_LIMIT"] = "3";
    const srv = await startHttp(0);
    try {
      const addr = srv.address() as AddressInfo;
      const base = `http://127.0.0.1:${addr.port}`;
      const H = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      const statuses: number[] = [];
      let retryAfter: string | null = null;
      for (let i = 0; i < 5; i += 1) {
        const res = await fetch(`${base}/mcp`, {
          method: "POST", headers: H,
          body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "ping", params: {} }),
        });
        statuses.push(res.status);
        await res.text();
        if (res.status === 429) retryAfter = res.headers.get("retry-after");
      }
      assert.ok(statuses.includes(429), `expected a 429 in the burst, got ${statuses.join(",")}`);
      assert.ok((retryAfter ?? "").length > 0, "Retry-After required on 429");
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
    } finally {
      delete process.env["EVEX_MCP_RATE_LIMIT"];
      srv.closeAllConnections?.();
      await new Promise<void>((resolve) => srv?.close(() => resolve()));
    }
  });
});
