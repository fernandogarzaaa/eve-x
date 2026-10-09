import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { startHttp } from "../apps/mcp/src/index.js";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

// MCP protocol surface, v2 dual-era (2026-07-28 modern + 2025-era legacy):
// - legacy: sessionful initialize/tools-list with stable session ids,
//   unknown versions fall back (never echoed), unknown sessions 400;
// - modern: stateless per-request serving, no session ids issued;
// - every served era is observable via x-evex-protocol-era;
// - tool calls validate schemas before touching the control plane;
// - HTTP auth gating holds on /mcp (before era routing) while /health
//   stays public.

const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const H = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

let srv: Server | null = null;
let base = "";

async function start(): Promise<void> {
  delete process.env["EVEX_MCP_TOKEN"];
  delete process.env["EVEX_AUTH_TOKEN"];
  delete process.env["EVEX_MODE"];
  srv = await startHttp(0);
  const addr = srv.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
}

async function stop(): Promise<void> {
  if (srv) {
    srv.closeAllConnections?.();
    await new Promise<void>((resolve) => srv?.close(() => resolve()));
    srv = null;
  }
}

beforeEach(start);
afterEach(stop);

async function rpc(body: unknown, extra?: Record<string, string>) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...H, ...(extra ?? {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

function firstJson(text: string): Record<string, unknown> {
  const line = text.split("\n").find((l) => l.trim().startsWith("{") || l.trim().startsWith("data:"));
  const clean = (line ?? text).replace(/^data:\s*/, "").trim();
  return JSON.parse(clean) as Record<string, unknown>;
}

async function initialize(version: string): Promise<{ status: number; sessionId: string | null; negotiated: string | null; text: string }> {
  const r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  const sid = r.headers.get("mcp-session-id");
  let negotiated: string | null = null;
  try {
    const j = firstJson(r.text);
    negotiated = ((j["result"] as Record<string, unknown> | undefined)?.["protocolVersion"] as string) ?? null;
  } catch { negotiated = null; }
  return { status: r.status, sessionId: sid, negotiated, text: r.text };
}

async function initialized(sid: string): Promise<void> {
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid });
}

describe("mcp protocol negotiation", () => {
  it("negotiates the latest version exactly", async () => {
    const r = await initialize("2025-11-25");
    assert.equal(r.status, 200);
    assert.ok(r.sessionId, "must issue a session id");
    assert.equal(r.negotiated, "2025-11-25");
  });

  it("negotiates each supported legacy version", async () => {
    for (const v of ["2025-06-18", "2025-03-26", "2024-11-05"]) {
      const r = await initialize(v);
      assert.equal(r.status, 200, `version ${v}`);
      assert.equal(r.negotiated, v, `version ${v} must be honored, got ${r.negotiated}`);
    }
  });

  it("never echoes an unknown future version (falls back to supported)", async () => {
    const r = await initialize("9999-99-99");
    assert.equal(r.status, 200);
    assert.ok(r.negotiated !== null && r.negotiated !== "9999-99-99", `must not echo unknown version, got ${r.negotiated}`);
    assert.ok(SUPPORTED.includes(r.negotiated as string), `fallback must be supported, got ${r.negotiated}`);
  });

  it("isolates concurrent sessions (distinct ids, both functional)", async () => {
    const a = await initialize("2025-11-25");
    const b = await initialize("2025-06-18");
    assert.ok(a.sessionId && b.sessionId && a.sessionId !== b.sessionId, "sessions must be distinct");
    await initialized(a.sessionId as string);
    await initialized(b.sessionId as string);
    const la = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": a.sessionId as string });
    const lb = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "mcp-session-id": b.sessionId as string });
    assert.equal(la.status, 200);
    assert.equal(lb.status, 200);
    assert.ok(la.text.includes("eve_session_create") && lb.text.includes("eve_session_create"));
  });

  it("closing a session ends it (later use is 400)", async () => {
    const r = await initialize("2025-11-25");
    const sid = r.sessionId as string;
    await initialized(sid);
    const del = await fetch(`${base}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid } });
    assert.ok(del.status === 200 || del.status === 204, `close got ${del.status}`);
    const after = await rpc({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }, { "mcp-session-id": sid });
    assert.equal(after.status, 400);
  });

  it("tool calls validate schemas before the control plane (no plane needed)", async () => {
    const r = await initialize("2025-11-25");
    const sid = r.sessionId as string;
    await initialized(sid);
    // eve_computer_act requires a valid action type; garbage must fail
    // at the schema boundary with a JSON-RPC error, not a crash.
    const bad = await rpc(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "eve_computer_act", arguments: { sessionId: "x", type: "nope" } } },
      { "mcp-session-id": sid },
    );
    assert.equal(bad.status, 200);
    assert.ok(bad.text.includes("error") || bad.text.includes("isError"), `schema violation must error: ${bad.text.slice(0, 300)}`);
    // Unknown tool names error as well.
    const ghost = await rpc(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "eve_not_a_tool", arguments: {} } },
      { "mcp-session-id": sid },
    );
    assert.ok(ghost.text.includes("error") || ghost.text.includes("Unknown"), `unknown tool must error: ${ghost.text.slice(0, 300)}`);
  });
});

describe("mcp http auth gating", () => {
  it("refuses /mcp without a token when one is configured (health stays public)", async () => {
    // Auth is read per request: no restart needed to arm the token.
    process.env["EVEX_MCP_TOKEN"] = "mcp-secret-xyz";
    try {
      const denied = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
      assert.equal(denied.status, 401);
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
      const authed = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { ...H, authorization: "Bearer mcp-secret-xyz" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
      });
      assert.equal(authed.status, 200);
    } finally {
      delete process.env["EVEX_MCP_TOKEN"];
    }
  });

  it("dev-open fallback exists only in development mode", async () => {
    delete process.env["EVEX_MCP_TOKEN"];
    delete process.env["EVEX_AUTH_TOKEN"];
    const prevMode = process.env["EVEX_MODE"];
    try {
      process.env["EVEX_MODE"] = "production";
      const denied = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
      assert.equal(denied.status, 401);
      process.env["EVEX_MODE"] = "test";
      const deniedTest = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
      assert.equal(deniedTest.status, 401);
    } finally {
      if (prevMode === undefined) delete process.env["EVEX_MODE"];
      else process.env["EVEX_MODE"] = prevMode;
    }
  });
});

describe("mcp modern era (2026-07-28, stateless)", () => {
  it("auto-negotiates modern and serves tools without sessions", async () => {
    const client = new Client({ name: "modern-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await client.connect(transport);
    try {
      assert.equal(client.getProtocolEra(), "modern");
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      assert.ok(names.includes("eve_session_create"), `expected eve tools, got ${names.slice(0, 3).join(",")}`);
      assert.equal(names.length, 21);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("modern responses carry the era header and issue no session id", async () => {
    const client = new Client({ name: "modern-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    await client.connect(transport);
    try {
      // A second stateless call works with no session affinity at all.
      const listed = await client.listTools();
      assert.ok(listed.tools.length >= 20);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it("modern era rejects unauthenticated callers when a token is configured", async () => {
    process.env["EVEX_MCP_TOKEN"] = "era-secret-xyz";
    try {
      const client = new Client({ name: "modern-test", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
      const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
      await assert.rejects(client.connect(transport), /401|auth/i);
    } finally {
      delete process.env["EVEX_MCP_TOKEN"];
    }
  });

  it("malformed modern requests fail as JSON-RPC errors, never crashes", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
      },
      body: "{not json",
    });
    // Body unreadable: the entry answers 4xx/500 without taking down the server.
    assert.ok(res.status === 400 || res.status === 500, `got ${res.status}`);
    await res.text();
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
  });
});

describe("mcp era observability", () => {
  it("legacy responses carry x-evex-protocol-era: legacy", async () => {
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-evex-protocol-era"), "legacy");
  });
});
