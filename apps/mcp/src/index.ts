import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Server as HttpServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TOOL_SCHEMAS } from "../../../packages/mcp-shared/src/index.js";

// ── EVE-X MCP server: stdio + StreamableHTTP, strict zod schemas, caller auth ──
// Tools are thin typed shims over the control-plane REST API (see
// apps/api/src/index.ts + apps/api/openapi.json for the route table).
// There is NO loopback stub: every tool requires a reachable control plane at
// EVEX_API_URL (default http://localhost:8080); when the API is unreachable
// the tool returns a clear {error:"unreachable"|"timeout"} result.
//
// Auth model (tokens are never logged):
//   stdio mode: tools authenticate to the control plane with EVEX_AUTH_TOKEN.
//   http mode:  the MCP endpoint itself requires an Authorization bearer when
//               EVEX_MCP_TOKEN (preferred) or EVEX_AUTH_TOKEN is set — the
//               bearer must match EVEX_MCP_TOKEN ?? EVEX_AUTH_TOKEN (401
//               otherwise). When neither is set the endpoint stays open for
//               single-user local use and stamps x-evex-dev:1 on responses.
//               The CALLER's bearer is forwarded to the control plane; only
//               when the caller sent none is the server-side EVEX_AUTH_TOKEN
//               used as a fallback.

export const MCP_HTTP_PORT_DEFAULT = 8091;
export const API_TIMEOUT_MS_DEFAULT = 30_000;

function apiBase(): string {
  return (process.env["EVEX_API_URL"] ?? "http://localhost:8080").replace(/\/$/, "");
}

/** 30 s default; EVEX_API_TIMEOUT_MS or a per-tool override wins. */
function apiTimeoutMs(overrideMs?: number): number {
  if (overrideMs !== undefined && Number.isFinite(overrideMs) && overrideMs > 0) return overrideMs;
  const raw = process.env["EVEX_API_TIMEOUT_MS"];
  const n = raw === undefined || raw === "" ? Number.NaN : Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) return n;
  return API_TIMEOUT_MS_DEFAULT;
}

/** Bearer presented by the MCP caller (HTTP mode), forwarded to the control plane. */
const callerAuth = new AsyncLocalStorage<string | undefined>();

function controlPlaneHeaders(extra?: Record<string, string>): Record<string, string> {
  const caller = callerAuth.getStore();
  const serverToken = process.env["EVEX_AUTH_TOKEN"] ?? "";
  // Prefer the caller's own credential; fall back to the server token (stdio).
  const auth = caller ?? (serverToken ? `Bearer ${serverToken}` : undefined);
  return {
    "Content-Type": "application/json",
    ...(auth ? { Authorization: auth } : {}),
    ...(extra ?? {}),
  };
}

export class McpApiError extends Error {
  readonly status: number; // 0 = transport-level (timeout / unreachable)
  readonly code: string;
  readonly retryable: boolean;
  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "McpApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function oneLine(s: string, max = 300): string {
  return s.split("\n")[0]?.trim().slice(0, max) ?? "";
}

/** Map control-plane HTTP statuses to MCP error classes (no stacks, no body leaks). */
function toMcpError(status: number, body: string, label: string): McpApiError {
  const excerpt = oneLine(body, 300);
  if (status === 400) {
    return new McpApiError(status, "invalid-params", `control plane rejected request (${label}): ${excerpt || "bad request"}`);
  }
  if (status === 401) {
    return new McpApiError(status, "unauthorized", `control plane unauthorized (${label}): missing or invalid bearer token`);
  }
  if (status === 403) {
    return new McpApiError(status, "forbidden", `control plane forbidden (${label}): ${excerpt || "capability denied"}`);
  }
  if (status === 404) {
    return new McpApiError(status, "not-found", `control plane not-found (${label})`);
  }
  if (status === 409) {
    const stale = body.includes("stale_perception");
    return new McpApiError(
      status,
      "conflict",
      `control plane conflict (${label}): ${excerpt || "conflict"}${stale ? " [stale_perception: re-observe to refresh frameId before acting]" : ""}`,
    );
  }
  if (status === 429) {
    return new McpApiError(status, "rate-limited", `control plane rate-limited (${label}): retryable`, true);
  }
  // 5xx and anything unexpected: one-line summary only, never the body internals.
  return new McpApiError(status, "internal", `control plane error ${status} (${label})`, status >= 500);
}

async function callApi<T>(
  path: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number; idempotencyKey?: string },
): Promise<T> {
  const base = apiBase();
  const timeoutMs = apiTimeoutMs(init?.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, {
      method: init?.method ?? "GET",
      headers: controlPlaneHeaders(init?.idempotencyKey ? { "idempotency-key": init.idempotencyKey } : undefined),
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw toMcpError(res.status, text, `${init?.method ?? "GET"} ${path}`);
    return (text ? JSON.parse(text) : {}) as T;
  } catch (err) {
    if (err instanceof McpApiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new McpApiError(0, "timeout", `control plane request timed out after ${timeoutMs}ms (${path})`, true);
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new McpApiError(
      0,
      "unreachable",
      `control plane unreachable at ${base}${path} (requires reachable control plane): ${oneLine(detail, 200)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function okResult(obj: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

function errResult(err: unknown): ToolResult {
  if (err instanceof McpApiError) {
    const payload: Record<string, unknown> = { error: err.code, message: err.message };
    if (err.status) payload["status"] = err.status;
    if (err.retryable) payload["retryable"] = true;
    if (err.code === "conflict" && err.message.includes("stale_perception")) {
      payload["hint"] = "stale_perception: re-observe the session to refresh frameId, then retry the act";
    }
    return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
  }
  // Programming/transport surprise: message first line only — never a stack trace.
  const msg = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: JSON.stringify({ error: "internal", message: oneLine(msg, 200) || "tool failed" }) }],
    isError: true,
  };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "eve-x", version: "1.0.3" });

  server.registerTool("eve_session_create",
    { description: "Create an EVE-X computer-use session", inputSchema: TOOL_SCHEMAS["eve_session_create"] },
    async (args) => {
      try {
        return okResult(await callApi("/v1/sessions", {
          method: "POST",
          body: { goal: args.goal, persona: args.persona, seed: args.seed, maxSteps: args.maxSteps },
        }));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_session_status",
    { description: "Get session status", inputSchema: TOOL_SCHEMAS["eve_session_status"] },
    async (args) => {
      try {
        return okResult(await callApi(`/v1/sessions/${encodeURIComponent(args.sessionId)}`));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_session_stop",
    { description: "Stop a session", inputSchema: TOOL_SCHEMAS["eve_session_stop"] },
    async (args) => {
      try {
        return okResult(await callApi(`/v1/sessions/${encodeURIComponent(args.sessionId)}/stop`, { method: "POST", body: {} }));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_vm_create",
    { description: "Create a VM", inputSchema: TOOL_SCHEMAS["eve_vm_create"] },
    async (args) => {
      try {
        return okResult(await callApi("/v1/vms", {
          method: "POST",
          body: { image: args.image, cpu: args.cpu, memoryMb: args.memoryMb },
        }));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_vm_status",
    { description: "VM status", inputSchema: TOOL_SCHEMAS["eve_vm_status"] },
    async (args) => {
      try {
        return okResult(await callApi(`/v1/vms/${encodeURIComponent(args.vmId)}/status`));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_vm_snapshot",
    { description: "Snapshot a VM", inputSchema: TOOL_SCHEMAS["eve_vm_snapshot"] },
    async (args) => {
      try {
        return okResult(await callApi(`/v1/vms/${encodeURIComponent(args.vmId)}/snapshot`, {
          method: "POST",
          body: args.label === undefined ? {} : { label: args.label },
        }));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_vm_restore",
    { description: "Restore a VM snapshot", inputSchema: TOOL_SCHEMAS["eve_vm_restore"] },
    async (args) => {
      try {
        return okResult(await callApi(`/v1/vms/${encodeURIComponent(args.vmId)}/restore`, {
          method: "POST",
          body: args.snapshot === undefined ? {} : { snapshot: args.snapshot },
        }));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_vm_fork",
    { description: "Fork a VM", inputSchema: TOOL_SCHEMAS["eve_vm_fork"] },
    async (args) => {
      try {
        return okResult(await callApi(`/v1/vms/${encodeURIComponent(args.vmId)}/fork`, { method: "POST", body: {} }));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_computer_observe",
    { description: "Observe the session screen", inputSchema: TOOL_SCHEMAS["eve_computer_observe"] },
    async (args) => {
      try {
        return okResult(await callApi(`/v1/computer/${encodeURIComponent(args.sessionId)}/observe`));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_computer_act",
    {
      description: "Act on the session computer (flat action body)",
      inputSchema: TOOL_SCHEMAS["eve_computer_act"],
    },
    async (args) => {
      try {
        const body: Record<string, unknown> = { type: args.type };
        if (args.x !== undefined) body["x"] = args.x;
        if (args.y !== undefined) body["y"] = args.y;
        if (args.text !== undefined) body["text"] = args.text;
        if (args.keys !== undefined) body["keys"] = args.keys;
        if (args.ms !== undefined) body["ms"] = args.ms;
        if (args.confidence !== undefined) body["confidence"] = args.confidence;
        if (args.frameId !== undefined) body["frameId"] = args.frameId;
        if (args.idempotencyKey !== undefined) body["idempotencyKey"] = args.idempotencyKey;
        return okResult(await callApi(`/v1/computer/${encodeURIComponent(args.sessionId)}/act`, {
          method: "POST",
          body,
          idempotencyKey: args.idempotencyKey,
        }));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_human_request",
    { description: "Request human help on a session", inputSchema: TOOL_SCHEMAS["eve_human_request"] },
    async (args) => {
      try {
        return okResult(await callApi("/v1/human/request", {
          method: "POST",
          body: { sessionId: args.sessionId, reason: args.reason ?? "help" },
        }));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_human_takeover",
    { description: "Human takes over a session", inputSchema: TOOL_SCHEMAS["eve_human_takeover"] },
    async (args) => {
      try {
        return okResult(await callApi("/v1/human/takeover", {
          method: "POST",
          body: { sessionId: args.sessionId },
        }));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_human_release",
    { description: "Human releases a session", inputSchema: TOOL_SCHEMAS["eve_human_release"] },
    async (args) => {
      try {
        return okResult(await callApi("/v1/human/release", {
          method: "POST",
          body: { sessionId: args.sessionId },
        }));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_task_start",
    { description: "Start an evaluation task", inputSchema: TOOL_SCHEMAS["eve_task_start"] },
    async (args) => {
      try {
        return okResult(await callApi("/v1/tasks/start", {
          method: "POST",
          body: { goal: args.goal, persona: args.persona, seed: args.seed },
        }));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_task_status",
    { description: "Task status", inputSchema: TOOL_SCHEMAS["eve_task_status"] },
    async (args) => {
      try {
        return okResult(await callApi(`/v1/tasks/${encodeURIComponent(args.taskId)}/status`));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_task_validate",
    { description: "Validate a task", inputSchema: TOOL_SCHEMAS["eve_task_validate"] },
    async (args) => {
      try {
        return okResult(await callApi(`/v1/tasks/${encodeURIComponent(args.taskId)}/validate`, { method: "POST", body: {} }));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_trace_get",
    { description: "Get session trace", inputSchema: TOOL_SCHEMAS["eve_trace_get"] },
    async (args) => {
      try {
        return okResult(await callApi(`/v1/trace/${encodeURIComponent(args.sessionId)}`));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_replay",
    { description: "Replay a session deterministically", inputSchema: TOOL_SCHEMAS["eve_replay"] },
    async (args) => {
      try {
        return okResult(await callApi(`/v1/replay/${encodeURIComponent(args.sessionId)}`, {
          method: "POST",
          body: { seed: args.seed },
        }));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_report",
    { description: "Session report", inputSchema: TOOL_SCHEMAS["eve_report"] },
    async (args) => {
      try {
        return okResult(await callApi(`/v1/report/${encodeURIComponent(args.sessionId)}`));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_benchmark",
    { description: "Run a benchmark suite", inputSchema: TOOL_SCHEMAS["eve_benchmark"] },
    async (args) => {
      try {
        return okResult(await callApi("/v1/benchmarks", {
          method: "POST",
          body: { name: args.name, size: args.size },
        }));
      } catch (err) { return errResult(err); }
    });

  server.registerTool("eve_model_status",
    { description: "Inference model status", inputSchema: TOOL_SCHEMAS["eve_model_status"] },
    async () => {
      try {
        return okResult(await callApi("/v1/models/status"));
      } catch (err) { return errResult(err); }
    });

  return server;
}

export async function startStdio(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp] eve-x stdio server online\n");
}

function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Bearer expected on the MCP HTTP endpoint: EVEX_MCP_TOKEN ?? EVEX_AUTH_TOKEN ("" = dev mode). */
function expectedMcpToken(): string {
  return process.env["EVEX_MCP_TOKEN"] ?? process.env["EVEX_AUTH_TOKEN"] ?? "";
}

/**
 * Gate the /mcp endpoint. Returns false after writing 401 when a token is
 * configured and the caller did not present it. Open endpoints stay
 * unauthenticated: /health is always public.
 */
function checkMcpAuth(req: Request, res: Response): boolean {
  const expected = expectedMcpToken();
  if (!expected) {
    // Single-user dev scope: no shared secret configured. Allow local use,
    // but stamp every response so callers know auth is off.
    res.setHeader("x-evex-dev", "1");
    return true;
  }
  const raw = String(req.headers.authorization ?? "");
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  // Constant-time compare; the token value itself is never logged.
  if (!token || !safeEq(token, expected)) {
    res.status(401).json({ error: "unauthorized", message: "Missing or invalid MCP bearer token" });
    return false;
  }
  return true;
}

export async function startHttp(port?: number): Promise<HttpServer> {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  // Flood discipline: fixed-window per-caller rate limit on /mcp (the
  // control plane has its own per-tenant limiter; this one protects the MCP
  // front door). 429s carry Retry-After; /health is never limited.
  const mcpBuckets = new Map<string, { count: number; resetAt: number }>();
  const mcpLimit = (): number => {
    const n = Number(process.env["EVEX_MCP_RATE_LIMIT"] ?? 600);
    return Number.isFinite(n) && n > 0 ? Math.min(100000, Math.floor(n)) : 600;
  };
  const mcpRateLimit = (req: Request, res: Response, next: NextFunction): void => {
    const caller = String(req.headers.authorization ?? req.socket.remoteAddress ?? "anon");
    const nowMs = Date.now();
    let b = mcpBuckets.get(caller);
    if (!b || nowMs >= b.resetAt) b = { count: 0, resetAt: nowMs + 60_000 };
    b.count += 1;
    mcpBuckets.set(caller, b);
    if (b.count > mcpLimit()) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((b.resetAt - nowMs) / 1000))));
      res.status(429).json({ jsonrpc: "2.0", error: { code: -32000, message: "rate_limited" }, id: null });
      return;
    }
    next();
  };
  app.get("/health", (_req: Request, res: Response) => res.json({ ok: true, service: "evex-mcp", at: new Date().toISOString() }));
  // Persistent StreamableHTTP sessions: one server+transport per MCP session id.
  // A fresh server per request can never complete initialize → tools/list, so
  // transports are parked here and re-entered via the mcp-session-id header.
  const live = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();
  const forget = (transport: StreamableHTTPServerTransport): void => {
    for (const [k, v] of live) {
      if (v.transport === transport) { live.delete(k); break; }
    }
  };
  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    if (!checkMcpAuth(req, res)) return;
    const inbound = typeof req.headers.authorization === "string" && req.headers.authorization
      ? req.headers.authorization
      : undefined;
    // Forward the caller's bearer to the control plane for the whole request.
    await callerAuth.run(inbound, async () => {
      const sid = String(req.headers["mcp-session-id"] ?? "");
      const body = req.body as { method?: string } | undefined;
      const entry = sid ? live.get(sid) : undefined;
      if (entry) {
        try {
          await entry.transport.handleRequest(req, res, req.body);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!res.headersSent) res.status(500).json({ error: "internal", message: oneLine(msg, 200) });
        }
        return;
      }
      if (body?.method !== "initialize") {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: unknown session; send initialize first" }, id: null });
        return;
      }
      const server = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          live.set(id, { server, transport });
        },
      });
      transport.onclose = () => forget(transport);
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        forget(transport);
        const msg = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) res.status(500).json({ error: "internal", message: oneLine(msg, 200) });
      }
    });
  };
  app.post("/mcp", mcpRateLimit, (req: Request, res: Response) => {
    void handleMcp(req, res);
  });
  app.get("/mcp", mcpRateLimit, (req: Request, res: Response) => {
    void handleMcp(req, res);
  });
  app.delete("/mcp", (req: Request, res: Response) => {
    if (!checkMcpAuth(req, res)) return;
    const sid = String(req.headers["mcp-session-id"] ?? "");
    const entry = sid ? live.get(sid) : undefined;
    if (!entry) { res.status(404).json({ error: "not_found" }); return; }
    live.delete(sid);
    entry.transport.close().catch(() => undefined);
    res.json({ closed: true });
  });
  const p = port ?? Number(process.env["MCP_PORT"] ?? MCP_HTTP_PORT_DEFAULT);
  const srv = app.listen(p);
  await new Promise<void>((resolve) => srv.once("listening", resolve));
  const addr = srv.address();
  const shown = typeof addr === "object" && addr !== null ? addr.port : p;
  process.stdout.write(`[mcp] streamable-http on :${shown}/mcp\n`);
  return srv;
}

const mode = (process.argv[2] ?? "stdio").toLowerCase();
const _entry = (process.argv[1] ?? "").replace(/\\/g, "/");
const isMain = _entry.endsWith("apps/mcp/index.js") ||
  _entry.endsWith("apps/mcp/src/index.js");
if (isMain) {
  if (mode === "http" || mode === "serve") {
    startHttp().catch((err) => {
      process.stderr.write(`[mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
  } else {
    startStdio().catch((err) => {
      process.stderr.write(`[mcp] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
  }
}
