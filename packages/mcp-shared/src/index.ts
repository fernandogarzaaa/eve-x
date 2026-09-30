import { z } from "zod";
import { ActionIR, ComputerPercept, TaskSpec, TraceStep, VmSpec } from "../../protocol/src/index.js";

// ── EVE-X shared MCP tool schemas (single authority for MCP surface, ADR-10) ──
// The control-plane exposes these tools over MCP. This package owns the zod
// schemas both sides validate against, plus a small fetch-based HTTP client
// for the control plane REST surface backing the same operations.

export const MCP_TOOL_VERSION = "mcp/1" as const;

// vm.create — provision an isolated guest from a snapshot image.
export const VmCreateInput = z.object({
  image: z.string().min(1).default("ubuntu-desktop-v1"),
  snapshot: z.string().min(1).default("clean"),
  cpu: z.number().int().min(1).max(32).default(4),
  memoryMb: z.number().int().min(512).max(65536).default(8192),
  diskGb: z.number().int().min(8).max(512).default(32),
  width: z.number().int().min(640).max(3840).default(1920),
  height: z.number().int().min(480).max(2160).default(1080),
  locale: z.string().default("en-US"),
  timezone: z.string().default("UTC"),
  network: z.enum(["none", "allowlisted", "full"]).default("allowlisted"),
});
export type VmCreateInput = z.infer<typeof VmCreateInput>;

// vm.control — power / lifecycle operations on an existing VM.
export const VmControlOp = z.enum([
  "boot",
  "shutdown",
  "reboot",
  "pause",
  "resume",
  "snapshot",
  "restore",
  "fork",
  "destroy",
]);
export type VmControlOp = z.infer<typeof VmControlOp>;
export const VmControlInput = z.object({
  vmId: z.string().min(1),
  op: VmControlOp,
  snapshotId: z.string().min(1).optional(),
  reason: z.string().max(512).default(""),
});
export type VmControlInput = z.infer<typeof VmControlInput>;

// computer.observe — capture the current guest frame (screenshot + regions).
export const ObserveInput = z.object({
  vmId: z.string().min(1),
  includeScreenshot: z.boolean().default(true),
  maxWidth: z.number().int().min(320).max(3840).default(1920),
});
export type ObserveInput = z.infer<typeof ObserveInput>;

// computer.act — execute one validated ActionIR against the guest.
export const ActInput = z.object({
  vmId: z.string().min(1),
  taskId: z.string().min(1),
  action: ActionIR,
  idempotencyKey: z.string().min(1),
});
export type ActInput = z.infer<typeof ActInput>;

// task.execute — launch a seeded evaluation task on a VM.
export const TaskExecuteInput = TaskSpec;
export type TaskExecuteInput = z.infer<typeof TaskExecuteInput>;

// trace.read / trace.export — inspect the append-only run ledger.
export const TraceReadInput = z.object({
  sessionId: z.string().min(1),
  fromSeq: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(5000).default(500),
});
export type TraceReadInput = z.infer<typeof TraceReadInput>;
export const TraceExportInput = z.object({
  sessionId: z.string().min(1),
  format: z.enum(["jsonl", "json"]).default("jsonl"),
});
export type TraceExportInput = z.infer<typeof TraceExportInput>;

// human.takeover — escalate to a human operator (approval-gated actions).
export const HumanTakeoverInput = z.object({
  sessionId: z.string().min(1),
  stepId: z.string().min(1),
  reason: z.string().min(1).max(2048),
  requestedAction: ActionIR.optional(),
});
export type HumanTakeoverInput = z.infer<typeof HumanTakeoverInput>;

// model.invoke — route a percept through the registered inference service.
export const ModelInvokeInput = z.object({
  modelId: z.string().min(1),
  frameId: z.string().min(1),
  goal: z.string().min(1).max(2048),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
  pngBase64: z.string().min(1),
  regions: ComputerPercept.shape.regions,
  cursor: ComputerPercept.shape.cursor,
  timeoutMs: z.number().int().min(100).max(120000).default(15000),
});
export type ModelInvokeInput = z.infer<typeof ModelInvokeInput>;

export const TOOL_SCHEMAS = {
  "vm.create": VmCreateInput,
  "vm.control": VmControlInput,
  "computer.observe": ObserveInput,
  "computer.act": ActInput,
  "task.execute": TaskExecuteInput,
  "trace.read": TraceReadInput,
  "trace.export": TraceExportInput,
  "human.takeover": HumanTakeoverInput,
  "model.invoke": ModelInvokeInput,
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];

export function parseToolInput<N extends ToolName>(name: N, raw: unknown): z.infer<(typeof TOOL_SCHEMAS)[N]> {
  return (TOOL_SCHEMAS[name] as z.ZodTypeAny).parse(raw) as z.infer<(typeof TOOL_SCHEMAS)[N]>;
}

export function safeParseToolInput<N extends ToolName>(
  name: N,
  raw: unknown,
): { ok: true; value: z.infer<(typeof TOOL_SCHEMAS)[N]> } | { ok: false; issues: string } {
  const r = (TOOL_SCHEMAS[name] as z.ZodTypeAny).safeParse(raw);
  if (r.success) return { ok: true, value: r.data as z.infer<(typeof TOOL_SCHEMAS)[N]> };
  return { ok: false, issues: JSON.stringify(r.error.issues) };
}

// Re-exported response shapes so MCP clients share one vocabulary.
export type { VmSpec, TraceStep };

// ── Control-plane HTTP client (fetch-based, auth headers, timeouts) ──

export interface ControlPlaneClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
}

export class ControlPlaneError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = "ControlPlaneError";
    this.status = status;
    this.body = body;
  }
}

interface RequestOptions {
  method: string;
  path: string;
  body?: unknown;
  timeoutMs?: number;
  idempotencyKey?: string;
}

const DEFAULT_TIMEOUT_MS = 15000;

function joinUrl(baseUrl: string, path: string): string {
  const b = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

export class ControlPlaneClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly defaultTimeoutMs: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: ControlPlaneClientOptions) {
    if (!opts.baseUrl || !opts.token) {
      throw new Error("ControlPlaneClient requires baseUrl and token");
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    const h: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      accept: "application/json",
      ...this.extraHeaders,
    };
    if (idempotencyKey) h["idempotency-key"] = idempotencyKey;
    return h;
  }

  async request<T>(opts: RequestOptions): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(joinUrl(this.baseUrl, opts.path), {
        method: opts.method,
        headers: this.headers(opts.idempotencyKey),
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new ControlPlaneError(res.status, text, `Control plane ${opts.method} ${opts.path} failed with ${res.status}`);
      }
      if (text.length === 0) return undefined as unknown as T;
      const parsed: unknown = JSON.parse(text);
      return parsed as T;
    } catch (err: unknown) {
      if (err instanceof ControlPlaneError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new ControlPlaneError(0, "", `Control plane ${opts.method} ${opts.path} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  get<T>(path: string, timeoutMs?: number): Promise<T> {
    return this.request<T>({ method: "GET", path, timeoutMs });
  }

  post<T>(path: string, body: unknown, opts?: { timeoutMs?: number; idempotencyKey?: string }): Promise<T> {
    return this.request<T>({
      method: "POST",
      path,
      body,
      timeoutMs: opts?.timeoutMs,
      idempotencyKey: opts?.idempotencyKey,
    });
  }

  del<T>(path: string, timeoutMs?: number): Promise<T> {
    return this.request<T>({ method: "DELETE", path, timeoutMs });
  }

  health(): Promise<{ status: string; version: string }> {
    return this.get<{ status: string; version: string }>("/v1/health");
  }

  createVm(input: VmCreateInput): Promise<{ vmId: string; state: string }> {
    return this.post<{ vmId: string; state: string }>("/v1/vms", VmCreateInput.parse(input));
  }

  controlVm(input: VmControlInput): Promise<{ vmId: string; state: string }> {
    const parsed = VmControlInput.parse(input);
    return this.post<{ vmId: string; state: string }>(`/v1/vms/${encodeURIComponent(parsed.vmId)}/control`, parsed);
  }

  observe(input: ObserveInput): Promise<unknown> {
    const parsed = ObserveInput.parse(input);
    return this.get<unknown>(`/v1/vms/${encodeURIComponent(parsed.vmId)}/screen`);
  }

  act(input: ActInput, timeoutMs?: number): Promise<unknown> {
    const parsed = ActInput.parse(input);
    return this.post<unknown>(
      `/v1/vms/${encodeURIComponent(parsed.vmId)}/act`,
      parsed,
      { timeoutMs, idempotencyKey: parsed.idempotencyKey },
    );
  }

  executeTask(input: TaskExecuteInput): Promise<{ sessionId: string; taskId: string }> {
    return this.post<{ sessionId: string; taskId: string }>("/v1/tasks", TaskExecuteInput.parse(input));
  }

  readTrace(input: TraceReadInput): Promise<{ steps: TraceStep[] }> {
    const parsed = TraceReadInput.parse(input);
    return this.get<{ steps: TraceStep[] }>(
      `/v1/sessions/${encodeURIComponent(parsed.sessionId)}/trace?fromSeq=${parsed.fromSeq}&limit=${parsed.limit}`,
    );
  }
}

export function createClientFromEnv(env?: Record<string, string | undefined>): ControlPlaneClient {
  const e = env ?? (process.env as Record<string, string | undefined>);
  const baseUrl = e["EVEX_CONTROL_PLANE_URL"] ?? "http://localhost:8080";
  const token = e["EVEX_AUTH_TOKEN"] ?? "";
  if (!token) throw new Error("EVEX_AUTH_TOKEN is required to build a ControlPlaneClient");
  const rawTimeout = e["EVEX_CONTROL_PLANE_TIMEOUT_MS"];
  const parsed = rawTimeout === undefined ? Number.NaN : Number.parseInt(rawTimeout, 10);
  return new ControlPlaneClient({
    baseUrl,
    token,
    timeoutMs: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
  });
}
