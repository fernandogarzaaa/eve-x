import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildMcpServer, startHttp } from "../apps/mcp/src/index.js";
import { ControlPlaneClient } from "../packages/mcp-shared/src/index.js";

// MCP adversarial hardening: no live control plane. A local node:http stub
// records every request the MCP tools / ControlPlaneClient attempt, so each
// test can assert exact paths+methods, pre-fetch rejection (stub saw nothing),
// error-class mapping, timeouts, HTTP auth gating, and a stdio smoke check.

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

let seen: Seen[] = [];
let hang = false;
let responder: (s: Seen) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } });

const stub: Server = createServer((req, res) => {
  let data = "";
  req.on("data", (c) => { data += String(c); });
  req.on("end", () => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(",");
    }
    seen.push({ method: req.method ?? "", path: req.url ?? "", headers, body: data });
    if (hang) return; // never respond: exercises client timeouts
    const r = responder(seen[seen.length - 1] as Seen);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(text);
  });
});

let stubBase = "";
const savedEnv: Record<string, string | undefined> = {};

function lastSeen(): Seen {
  assert.ok(seen.length > 0, "expected the stub to have received a request");
  return seen[seen.length - 1] as Seen;
}

async function withMcpClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const server = buildMcpServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-adversarial", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const blocks = (result.content ?? []) as Array<{ type?: string; text?: string }>;
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
  return { isError: (result as { isError?: boolean }).isError === true, text };
}

describe("mcp-adversarial", () => {
  before(async () => {
    for (const k of ["EVEX_API_URL", "EVEX_API_TIMEOUT_MS", "EVEX_MCP_TOKEN", "EVEX_AUTH_TOKEN"]) {
      savedEnv[k] = process.env[k];
    }
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const addr = stub.address() as AddressInfo;
    stubBase = `http://127.0.0.1:${addr.port}`;
    process.env["EVEX_API_URL"] = stubBase;
    delete process.env["EVEX_API_TIMEOUT_MS"];
  });

  after(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    stub.closeAllConnections?.();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  beforeEach(() => {
    seen = [];
    hang = false;
    responder = () => ({ status: 200, body: { ok: true } });
  });

  describe("input validation rejects pre-fetch", () => {
    it("oversized goal is invalid-params with no fetch", async () => {
      await withMcpClient(async (c) => {
        const r = await callTool(c, "eve_session_create", { goal: "x".repeat(2001) });
        assert.equal(r.isError, true);
        assert.match(r.text, /invalid-params|invalid arguments/i);
        assert.equal(seen.length, 0, "no fetch may be attempted for invalid input");
      });
    });

    it("wrong types are invalid-params with no fetch", async () => {
      await withMcpClient(async (c) => {
        const r = await callTool(c, "eve_session_create", { goal: 123 as unknown as string });
        assert.equal(r.isError, true);
        assert.match(r.text, /invalid-params|invalid arguments/i);
        assert.equal(seen.length, 0);
      });
    });

    it("unknown fields are invalid-params with no fetch", async () => {
      await withMcpClient(async (c) => {
        const r = await callTool(c, "eve_session_status", { sessionId: "sess-1", bogus: 1 });
        assert.equal(r.isError, true);
        assert.match(r.text, /invalid-params|invalid arguments/i);
        assert.equal(seen.length, 0);
      });
    });

    it("invalid sessionId charset is rejected pre-fetch", async () => {
      await withMcpClient(async (c) => {
        const r = await callTool(c, "eve_trace_get", { sessionId: "bad id!!" });
        assert.equal(r.isError, true);
        assert.match(r.text, /invalid-params|invalid arguments/i);
        assert.equal(seen.length, 0);
      });
    });

    it("unknown act type is invalid-params with no fetch", async () => {
      await withMcpClient(async (c) => {
        const r = await callTool(c, "eve_computer_act", { sessionId: "sess-1", type: "fly" });
        assert.equal(r.isError, true);
        assert.match(r.text, /invalid-params|invalid arguments/i);
        assert.equal(seen.length, 0);
      });
    });

    it("malformed act (missing type) is invalid-params with no fetch", async () => {
      await withMcpClient(async (c) => {
        const r = await callTool(c, "eve_computer_act", { sessionId: "sess-1" });
        assert.equal(r.isError, true);
        assert.match(r.text, /invalid-params|invalid arguments/i);
        assert.equal(seen.length, 0);
      });
    });

    it("oversized keys array is invalid-params with no fetch", async () => {
      await withMcpClient(async (c) => {
        const r = await callTool(c, "eve_computer_act", {
          sessionId: "sess-1",
          type: "key",
          keys: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
        });
        assert.equal(r.isError, true);
        assert.match(r.text, /invalid-params|invalid arguments/i);
        assert.equal(seen.length, 0);
      });
    });
  });

  describe("control-plane error mapping", () => {
    async function mapped(tool: string, args: Record<string, unknown>, status: number, body: unknown) {
      responder = () => ({ status, body });
      return withMcpClient((c) => callTool(c, tool, args));
    }

    it("400 maps to invalid-params", async () => {
      const r = await mapped("eve_session_status", { sessionId: "sess-1" }, 400, { error: "bad_request" });
      assert.equal(r.isError, true);
      assert.match(r.text, /invalid-params/);
    });

    it("401 maps to unauthorized", async () => {
      const r = await mapped("eve_session_status", { sessionId: "sess-1" }, 401, { error: "unauthorized" });
      assert.equal(r.isError, true);
      assert.match(r.text, /unauthorized/);
      assert.doesNotMatch(r.text, /forbidden/);
    });

    it("403 maps to forbidden (distinct from unauthorized)", async () => {
      const r = await mapped("eve_session_status", { sessionId: "sess-1" }, 403, { error: "forbidden" });
      assert.equal(r.isError, true);
      assert.match(r.text, /forbidden/);
      assert.doesNotMatch(r.text, /unauthorized/);
    });

    it("404 maps to not-found", async () => {
      const r = await mapped("eve_session_status", { sessionId: "sess-1" }, 404, { error: "not_found" });
      assert.equal(r.isError, true);
      assert.match(r.text, /not-found/);
    });

    it("409 stale maps to conflict with a stale_perception hint", async () => {
      const r = await mapped(
        "eve_computer_act",
        { sessionId: "sess-1", type: "click", x: 1, y: 2 },
        409,
        { error: "stale_perception", current: "f-9" },
      );
      assert.equal(r.isError, true);
      assert.match(r.text, /conflict/);
      assert.match(r.text, /stale_perception/);
    });

    it("429 maps to a retryable class", async () => {
      const r = await mapped("eve_session_status", { sessionId: "sess-1" }, 429, { error: "rate_limited" });
      assert.equal(r.isError, true);
      assert.match(r.text, /rate-limited|retryable/i);
    });

    it("500 maps to internal and hides the body internals", async () => {
      const r = await mapped(
        "eve_session_status",
        { sessionId: "sess-1" },
        500,
        { error: "boom", detail: "SUPERSECRET-xyz-stack-trace" },
      );
      assert.equal(r.isError, true);
      assert.match(r.text, /internal/);
      assert.ok(!r.text.includes("SUPERSECRET"), "5xx bodies must never leak into tool results");
      assert.ok(!r.text.includes("stack"), "no stack traces in tool results");
    });
  });

  describe("timeout", () => {
    it("hung API returns a timeout error fast (short override)", async () => {
      hang = true;
      process.env["EVEX_API_TIMEOUT_MS"] = "300";
      try {
        const t0 = Date.now();
        const r = await withMcpClient((c) => callTool(c, "eve_model_status", {}));
        const elapsed = Date.now() - t0;
        assert.equal(r.isError, true);
        assert.match(r.text, /timeout/);
        assert.ok(elapsed < 5000, `timeout must fire well under 5s (took ${elapsed}ms)`);
      } finally {
        hang = false;
        delete process.env["EVEX_API_TIMEOUT_MS"];
      }
    });
  });

  describe("http auth gating", () => {
    it("rejects unauthenticated /mcp when EVEX_MCP_TOKEN is set", async () => {
      process.env["EVEX_MCP_TOKEN"] = "test-mcp-token-123";
      const srv = await startHttp(0);
      try {
        const addr = srv.address() as AddressInfo;
        const base = `http://127.0.0.1:${addr.port}`;
        const noAuth = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(noAuth.status, 401);
        const wrong = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
          body: "{}",
        });
        assert.equal(wrong.status, 401);
        // Liveness probe stays public even with MCP auth configured.
        const health = await fetch(`${base}/health`);
        assert.equal(health.status, 200);
      } finally {
        srv.closeAllConnections?.();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        delete process.env["EVEX_MCP_TOKEN"];
      }
    });

    it("dev mode (no tokens) allows /mcp and stamps x-evex-dev", async () => {
      delete process.env["EVEX_MCP_TOKEN"];
      delete process.env["EVEX_AUTH_TOKEN"];
      const srv = await startHttp(0);
      try {
        const addr = srv.address() as AddressInfo;
        const base = `http://127.0.0.1:${addr.port}`;
        const res = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
          }),
        });
        assert.equal(res.headers.get("x-evex-dev"), "1");
        assert.ok(res.status !== 401, `dev mode must not 401 (got ${res.status})`);
      } finally {
        srv.closeAllConnections?.();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      }
    });

    it("HTTP sessions persist across requests (initialize → tools/list)", async () => {
      delete process.env["EVEX_MCP_TOKEN"];
      delete process.env["EVEX_AUTH_TOKEN"];
      const srv = await startHttp(0);
      try {
        const addr = srv.address() as AddressInfo;
        const base = `http://127.0.0.1:${addr.port}`;
        const H = {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        };
        const initBody = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
        });
        const init = await fetch(`${base}/mcp`, { method: "POST", headers: H, body: initBody });
        assert.equal(init.status, 200);
        const sid = init.headers.get("mcp-session-id");
        assert.ok(sid, "initialize must issue an mcp-session-id");
        await init.text();
        const H2 = { ...H, "mcp-session-id": sid as string };
        await fetch(`${base}/mcp`, {
          method: "POST",
          headers: H2,
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        });
        const list = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: H2,
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        });
        const text = await list.text();
        assert.ok(!/not initialized/i.test(text), `session must persist across requests: ${text.slice(0, 200)}`);
        const names = [...text.matchAll(/"name":"(eve_[a-z_]+)"/g)].map((m) => m[1]);
        assert.ok(new Set(names).size >= 20, `expected 20+ tools, got ${new Set(names).size}`);
        // Unknown session without initialize → 400, not a crash.
        const bad = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { ...H, "mcp-session-id": "nope-nope" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
        });
        assert.equal(bad.status, 400);
      } finally {
        srv.closeAllConnections?.();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
        delete process.env["EVEX_MCP_TOKEN"];
      }
    });
  });

  describe("control-plane client route accuracy", () => {
    function client(): ControlPlaneClient {
      return new ControlPlaneClient({ baseUrl: stubBase, token: "tok", timeoutMs: 3000 });
    }

    it("probes hit root paths", async () => {
      const c = client();
      await c.health();
      assert.deepEqual([lastSeen().method, lastSeen().path], ["GET", "/health"]);
      await c.ready();
      assert.deepEqual([lastSeen().method, lastSeen().path], ["GET", "/ready"]);
      await c.metricsText();
      assert.deepEqual([lastSeen().method, lastSeen().path], ["GET", "/metrics"]);
    });

    it("session helpers hit exact session routes", async () => {
      const c = client();
      await c.listSessions();
      assert.deepEqual([lastSeen().method, lastSeen().path], ["GET", "/v1/sessions"]);
      await c.createSession({ goal: "open settings" });
      assert.deepEqual([lastSeen().method, lastSeen().path], ["POST", "/v1/sessions"]);
      await c.getSession("sess-1");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["GET", "/v1/sessions/sess-1"]);
      await c.pauseSession("sess-1");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["POST", "/v1/sessions/sess-1/pause"]);
      await c.stepSession("sess-1");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["POST", "/v1/sessions/sess-1/step"]);
      await c.stopSession("sess-1");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["POST", "/v1/sessions/sess-1/stop"]);
    });

    it("vm helpers hit exact vm routes", async () => {
      const c = client();
      await c.listVms();
      assert.deepEqual([lastSeen().method, lastSeen().path], ["GET", "/v1/vms"]);
      await c.createVm({});
      assert.deepEqual([lastSeen().method, lastSeen().path], ["POST", "/v1/vms"]);
      await c.getVm("vm-1");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["GET", "/v1/vms/vm-1"]);
      await c.vmStatus("vm-1");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["GET", "/v1/vms/vm-1/status"]);
      await c.snapshotVm("vm-1", "snap-a");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["POST", "/v1/vms/vm-1/snapshot"]);
      await c.restoreVm("vm-1", "snap-a");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["POST", "/v1/vms/vm-1/restore"]);
      await c.forkVm("vm-1");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["POST", "/v1/vms/vm-1/fork"]);
      await c.deleteVm("vm-1");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["DELETE", "/v1/vms/vm-1"]);
    });

    it("observe/act hit session-scoped computer routes with flat bodies", async () => {
      const c = client();
      await c.observe("sess-1");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["GET", "/v1/computer/sess-1/observe"]);
      await c.act("sess-1", { type: "click", x: 10, y: 20 }, { idempotencyKey: "k-1" });
      const s = lastSeen();
      assert.deepEqual([s.method, s.path], ["POST", "/v1/computer/sess-1/act"]);
      assert.equal(s.headers["idempotency-key"], "k-1");
      const body = JSON.parse(s.body) as Record<string, unknown>;
      assert.equal(body["type"], "click");
      assert.ok(!("action" in body) && !("vmId" in body), "act body must be flat (no wrappers)");
    });

    it("human/task/trace/replay/report/judgment/benchmark/model helpers hit exact routes", async () => {
      const c = client();
      await c.requestHuman("sess-1", "help");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["POST", "/v1/human/request"]);
      assert.equal((JSON.parse(lastSeen().body) as Record<string, unknown>)["sessionId"], "sess-1");
      await c.takeoverHuman("sess-1");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["POST", "/v1/human/takeover"]);
      await c.releaseHuman("sess-1");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["POST", "/v1/human/release"]);
      await c.startTask({ goal: "do thing" });
      assert.deepEqual([lastSeen().method, lastSeen().path], ["POST", "/v1/tasks/start"]);
      await c.taskStatus("task-1");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["GET", "/v1/tasks/task-1/status"]);
      await c.validateTask("task-1");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["POST", "/v1/tasks/task-1/validate"]);
      await c.readTrace("sess-1");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["GET", "/v1/trace/sess-1"]);
      await c.replaySession("sess-1");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["POST", "/v1/replay/sess-1"]);
      await c.sessionReport("sess-1");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["GET", "/v1/report/sess-1"]);
      await c.submitJudgment({
        stepId: "step-1",
        reasonable: true,
        targetCorrect: true,
        understandable: true,
        expected: true,
        recoveryOk: true,
      });
      assert.deepEqual([lastSeen().method, lastSeen().path], ["POST", "/v1/judgments"]);
      await c.runBenchmark({});
      assert.deepEqual([lastSeen().method, lastSeen().path], ["POST", "/v1/benchmarks"]);
      await c.benchmarkStatus("bench-1");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["GET", "/v1/benchmarks/bench-1"]);
      await c.modelStatus();
      assert.deepEqual([lastSeen().method, lastSeen().path], ["GET", "/v1/models/status"]);
      const before = seen.length;
      assert.equal(c.streamPath("sess-1"), "/v1/stream/sess-1");
      assert.equal(seen.length, before, "streamPath builds the WS path without fetching");
    });

    it("sends bearer auth, idempotency headers, and validates ids pre-fetch", async () => {
      const c = client();
      await c.createVm({});
      assert.equal(lastSeen().headers["authorization"], "Bearer tok");
      await c.post("/v1/sessions/x/stop", {}, { idempotencyKey: "ik" });
      assert.equal(lastSeen().headers["idempotency-key"], "ik");
      await c.get("/v1/sessions");
      assert.equal(lastSeen().method, "GET");
      await c.del("/v1/vms/vm-9");
      assert.deepEqual([lastSeen().method, lastSeen().path], ["DELETE", "/v1/vms/vm-9"]);
      const before = seen.length;
      await assert.rejects(() => c.getSession("bad id!!"), /must match/);
      assert.equal(seen.length, before, "invalid ids must be rejected before any fetch");
    });
  });

  describe("stdio smoke", () => {
    it("initialize over stdio returns a protocolVersion", { timeout: 30000 }, async () => {
      const entry = join(process.cwd(), "dist", "apps", "mcp", "src", "index.js");
      const child: ChildProcess = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
      try {
        const line: string = await new Promise((resolve, reject) => {
          let buf = "";
          const timer = setTimeout(() => reject(new Error("timed out waiting for stdio initialize result")), 15000);
          timer.unref?.();
          child.stdout?.on("data", (chunk: Buffer) => {
            buf += chunk.toString("utf8");
            const nl = buf.indexOf("\n");
            if (nl >= 0) {
              clearTimeout(timer);
              resolve(buf.slice(0, nl));
            }
          });
          child.on("error", reject);
          child.stdin?.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "adv-test", version: "0" } },
            }) + "\n",
          );
        });
        const msg = JSON.parse(line) as { result?: { protocolVersion?: unknown } };
        assert.ok(
          msg.result && typeof msg.result.protocolVersion === "string" && msg.result.protocolVersion.length > 0,
          `expected a protocolVersion in initialize result, got: ${line.slice(0, 200)}`,
        );
      } finally {
        child.kill();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          timer.unref?.();
          child.on("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    });
  });
});
