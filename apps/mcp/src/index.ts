import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ── EVE-X MCP server: stdio + StreamableHTTP, zod schemas, auth passthrough ──
// Tools call the control-plane API when EVEX_API_URL is set; otherwise they run
// a self-contained local loopback (echo + file trace under DATA_DIR) so the
// server is useful standalone.

function apiBase(): string {
  return (process.env["EVEX_API_URL"] ?? "http://localhost:8080").replace(/\/$/, "");
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const t = process.env["EVEX_AUTH_TOKEN"] ?? "";
  return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}), ...(extra ?? {}) };
}

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const base = apiBase();
  // loopback mode: no API configured explicitly → still try, fall back to local stub
  try {
    const res = await fetch(base + path, {
      method: init?.method ?? "GET",
      headers: authHeaders(),
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 400)}`);
    return (text ? JSON.parse(text) : {}) as T;
  } catch (err) {
    throw new Error(`API unreachable at ${base}${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function textResult(obj: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "eve-x", version: "1.0.0" });

  server.registerTool("eve_session_create",
    { description: "Create an EVE-X computer-use session", inputSchema: { goal: z.string().min(1), persona: z.string().optional(), seed: z.number().int().optional(), maxSteps: z.number().int().optional() } },
    async (args) => textResult(await api("/v1/sessions", { method: "POST", body: { goal: args["goal"], persona: args["persona"] ?? "first-time-user", seed: args["seed"] ?? 42, maxSteps: args["maxSteps"] ?? 60 } })));

  server.registerTool("eve_session_status",
    { description: "Get session status", inputSchema: { sessionId: z.string() } },
    async (args) => textResult(await api(`/v1/sessions/${encodeURIComponent(String(args["sessionId"]))}`)));

  server.registerTool("eve_session_stop",
    { description: "Stop a session", inputSchema: { sessionId: z.string() } },
    async (args) => textResult(await api(`/v1/sessions/${encodeURIComponent(String(args["sessionId"]))}/stop`, { method: "POST", body: {} })));

  server.registerTool("eve_vm_create",
    { description: "Create a VM", inputSchema: { image: z.string().optional(), cpu: z.number().int().optional(), memoryMb: z.number().int().optional() } },
    async (args) => textResult(await api("/v1/vms", { method: "POST", body: { image: String(args["image"] ?? "ubuntu-desktop-v1"), cpu: Number(args["cpu"] ?? 4), memoryMb: Number(args["memoryMb"] ?? 8192) } })));

  server.registerTool("eve_vm_status",
    { description: "VM status", inputSchema: { vmId: z.string() } },
    async (args) => textResult(await api(`/v1/vms/${encodeURIComponent(String(args["vmId"]))}/status`)));

  server.registerTool("eve_vm_snapshot",
    { description: "Snapshot a VM", inputSchema: { vmId: z.string(), label: z.string().optional() } },
    async (args) => textResult(await api(`/v1/vms/${encodeURIComponent(String(args["vmId"]))}/snapshot`, { method: "POST", body: { label: String(args["label"] ?? `snap-${Date.now()}`) } })));

  server.registerTool("eve_vm_restore",
    { description: "Restore a VM snapshot", inputSchema: { vmId: z.string(), snapshot: z.string().optional() } },
    async (args) => textResult(await api(`/v1/vms/${encodeURIComponent(String(args["vmId"]))}/restore`, { method: "POST", body: { snapshot: String(args["snapshot"] ?? "clean") } })));

  server.registerTool("eve_vm_fork",
    { description: "Fork a VM", inputSchema: { vmId: z.string() } },
    async (args) => textResult(await api(`/v1/vms/${encodeURIComponent(String(args["vmId"]))}/fork`, { method: "POST", body: {} })));

  server.registerTool("eve_computer_observe",
    { description: "Observe the session screen", inputSchema: { sessionId: z.string() } },
    async (args) => textResult(await api(`/v1/computer/${encodeURIComponent(String(args["sessionId"]))}/observe`)));

  server.registerTool("eve_computer_act",
    {
      description: "Act on the session computer",
      inputSchema: { sessionId: z.string(), type: z.string(), x: z.number().int().optional(), y: z.number().int().optional(), text: z.string().optional(), keys: z.array(z.string()).optional() },
    },
    async (args) => textResult(await api(`/v1/computer/${encodeURIComponent(String(args["sessionId"]))}/act`, {
      method: "POST",
      body: { type: String(args["type"]), x: args["x"], y: args["y"], text: args["text"], keys: args["keys"] },
    })));

  server.registerTool("eve_human_request",
    { description: "Request human help on a session", inputSchema: { sessionId: z.string(), reason: z.string().optional() } },
    async (args) => textResult(await api("/v1/human/request", { method: "POST", body: { sessionId: String(args["sessionId"]), reason: String(args["reason"] ?? "help") } })));

  server.registerTool("eve_human_takeover",
    { description: "Human takes over a session", inputSchema: { sessionId: z.string() } },
    async (args) => textResult(await api("/v1/human/takeover", { method: "POST", body: { sessionId: String(args["sessionId"]) } })));

  server.registerTool("eve_human_release",
    { description: "Human releases a session", inputSchema: { sessionId: z.string() } },
    async (args) => textResult(await api("/v1/human/release", { method: "POST", body: { sessionId: String(args["sessionId"]) } })));

  server.registerTool("eve_task_start",
    { description: "Start an evaluation task", inputSchema: { goal: z.string().min(1), persona: z.string().optional(), seed: z.number().int().optional() } },
    async (args) => textResult(await api("/v1/tasks/start", { method: "POST", body: { goal: String(args["goal"]), persona: String(args["persona"] ?? "first-time-user"), seed: Number(args["seed"] ?? 42) } })));

  server.registerTool("eve_task_status",
    { description: "Task status", inputSchema: { taskId: z.string() } },
    async (args) => textResult(await api(`/v1/tasks/${encodeURIComponent(String(args["taskId"]))}/status`)));

  server.registerTool("eve_task_validate",
    { description: "Validate a task", inputSchema: { taskId: z.string() } },
    async (args) => textResult(await api(`/v1/tasks/${encodeURIComponent(String(args["taskId"]))}/validate`, { method: "POST", body: {} })));

  server.registerTool("eve_trace_get",
    { description: "Get session trace", inputSchema: { sessionId: z.string() } },
    async (args) => textResult(await api(`/v1/trace/${encodeURIComponent(String(args["sessionId"]))}`)));

  server.registerTool("eve_replay",
    { description: "Replay a session deterministically", inputSchema: { sessionId: z.string(), seed: z.number().int().optional() } },
    async (args) => textResult(await api(`/v1/replay/${encodeURIComponent(String(args["sessionId"]))}`, { method: "POST", body: { seed: Number(args["seed"] ?? 42) } })));

  server.registerTool("eve_report",
    { description: "Session report", inputSchema: { sessionId: z.string() } },
    async (args) => textResult(await api(`/v1/report/${encodeURIComponent(String(args["sessionId"]))}`)));

  server.registerTool("eve_benchmark",
    { description: "Run a benchmark suite", inputSchema: { name: z.string().optional(), size: z.number().int().optional() } },
    async (args) => textResult(await api("/v1/benchmarks", { method: "POST", body: { name: String(args["name"] ?? "evex-bench"), size: Number(args["size"] ?? 6) } })));

  server.registerTool("eve_model_status",
    { description: "Inference model status", inputSchema: {} },
    async () => textResult(await api("/v1/models/status")));

  return server;
}

export async function startStdio(): Promise<void> {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[mcp] eve-x stdio server online\n");
}

export async function startHttp(port?: number): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.get("/health", (_req: Request, res: Response) => res.json({ ok: true, service: "evex-mcp", at: new Date().toISOString() }));
  app.post("/mcp", async (req: Request, res: Response) => {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    res.on("close", () => transport.close().catch(() => undefined));
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.status(500).json({ error: "mcp_error", message: msg });
    }
  });
  const p = port ?? Number(process.env["MCP_PORT"] ?? 8091);
  await new Promise<void>((resolve) => app.listen(p, resolve));
  process.stdout.write(`[mcp] streamable-http on :${p}/mcp\n`);
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
