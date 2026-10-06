import { z } from "zod";
import { ActionType, TraceStep, VmSpec } from "../../protocol/src/index.js";

// ── EVE-X shared MCP tool schemas (single authority for MCP surface, ADR-10) ──
// Every schema below mirrors the real control-plane routes 1:1
// (see apps/api/src/index.ts + apps/api/openapi.json):
//   probes live at ROOT: GET /health | /ready | /metrics (no /v1 prefix);
//   product routes live under /v1; live frames stream over WS /v1/stream/:sessionId.
// Tool names match the MCP server tool names (eve_*) so the server and any
// client validate the same wire contract against exactly one definition.
// All schemas are strict: unknown fields are rejected before any fetch.

export const MCP_TOOL_VERSION = "mcp/1" as const;

/** All session/vm/task ids: [A-Za-z0-9_-]{1,128}. Rejected pre-fetch on mismatch. */
export const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const IdString = z.string().min(1).max(128).regex(ID_PATTERN, "must match [A-Za-z0-9_-]{1,128}");
export type IdString = z.infer<typeof IdString>;

const Goal = z.string().min(1).max(2000);
const Persona = z.string().min(1).max(128).default("first-time-user");
const Seed = z.number().int().default(42);
const MaxSteps = z.number().int().min(1).max(500).default(60);

// ── MCP tool inputs (one per eve_* server tool) ──

export const EveSessionCreate = z.object({
  goal: Goal,
  persona: Persona,
  seed: Seed,
  maxSteps: MaxSteps,
}).strict();
export type EveSessionCreate = z.infer<typeof EveSessionCreate>;

export const EveSessionId = z.object({ sessionId: IdString }).strict();
export type EveSessionId = z.infer<typeof EveSessionId>;

export const EveVmId = z.object({ vmId: IdString }).strict();
export type EveVmId = z.infer<typeof EveVmId>;

export const EveTaskId = z.object({ taskId: IdString }).strict();
export type EveTaskId = z.infer<typeof EveTaskId>;

export const EveVmCreate = z.object({
  image: z.string().min(1).max(256).default("ubuntu-desktop-v1"),
  cpu: z.number().int().min(1).max(32).default(4),
  memoryMb: z.number().int().min(512).max(65536).default(8192),
}).strict();
export type EveVmCreate = z.infer<typeof EveVmCreate>;

export const EveVmSnapshot = z.object({
  vmId: IdString,
  label: z.string().min(1).max(64).optional(),
}).strict();
export type EveVmSnapshot = z.infer<typeof EveVmSnapshot>;

export const EveVmRestore = z.object({
  vmId: IdString,
  snapshot: z.string().min(1).max(64).optional(),
}).strict();
export type EveVmRestore = z.infer<typeof EveVmRestore>;

export const EveComputerAct = z.object({
  sessionId: IdString,
  // 17-action enum — unknown action types are rejected pre-fetch (invalid-params).
  type: ActionType,
  x: z.number().int().min(0).optional(),
  y: z.number().int().min(0).optional(),
  text: z.string().max(4096).optional(),
  keys: z.array(z.string().min(1).max(64)).max(8).optional(),
  ms: z.number().int().min(0).max(60000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  frameId: z.string().min(1).max(128).optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
}).strict();
export type EveComputerAct = z.infer<typeof EveComputerAct>;

export const EveHumanRequest = z.object({
  sessionId: IdString,
  reason: z.string().min(1).max(2048).optional(),
}).strict();
export type EveHumanRequest = z.infer<typeof EveHumanRequest>;

export const EveTaskStart = z.object({
  goal: Goal,
  persona: Persona,
  seed: Seed,
}).strict();
export type EveTaskStart = z.infer<typeof EveTaskStart>;

export const EveReplay = z.object({
  sessionId: IdString,
  seed: Seed,
}).strict();
export type EveReplay = z.infer<typeof EveReplay>;

export const EveBenchmark = z.object({
  name: z.string().min(1).max(128).default("evex-bench"),
  size: z.number().int().min(1).max(200).default(6),
}).strict();
export type EveBenchmark = z.infer<typeof EveBenchmark>;

export const EveEmpty = z.object({}).strict();
export type EveEmpty = z.infer<typeof EveEmpty>;

export const TOOL_SCHEMAS = {
  "eve_session_create": EveSessionCreate,
  "eve_session_status": EveSessionId,
  "eve_session_stop": EveSessionId,
  "eve_vm_create": EveVmCreate,
  "eve_vm_status": EveVmId,
  "eve_vm_snapshot": EveVmSnapshot,
  "eve_vm_restore": EveVmRestore,
  "eve_vm_fork": EveVmId,
  "eve_computer_observe": EveSessionId,
  "eve_computer_act": EveComputerAct,
  "eve_human_request": EveHumanRequest,
  "eve_human_takeover": EveSessionId,
  "eve_human_release": EveSessionId,
  "eve_task_start": EveTaskStart,
  "eve_task_status": EveTaskId,
  "eve_task_validate": EveTaskId,
  "eve_trace_get": EveSessionId,
  "eve_replay": EveReplay,
  "eve_report": EveSessionId,
  "eve_benchmark": EveBenchmark,
  "eve_model_status": EveEmpty,
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

// ── Control-plane request bodies (client-side validation before send) ──

export const SessionCreateBody = z.object({
  goal: Goal,
  taskId: z.string().min(1).max(128).optional(),
  vmId: IdString.optional(),
  vm: VmSpec.optional(),
  persona: z.string().min(1).max(128).default("first-time-user"),
  seed: Seed,
  maxSteps: MaxSteps,
});
export type SessionCreateBody = z.infer<typeof SessionCreateBody>;

export const VmCreateBody = VmSpec;
export type VmCreateBody = z.infer<typeof VmCreateBody>;

/** Flat act body for POST /v1/computer/:sessionId/act (sessionId stays in the path). */
export const ActBody = z.object({
  type: ActionType,
  text: z.string().max(4096).optional(),
  x: z.number().int().min(0).optional(),
  y: z.number().int().min(0).optional(),
  keys: z.array(z.string().min(1).max(64)).max(8).optional(),
  ms: z.number().int().min(0).max(60000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  frameId: z.string().min(1).max(128).optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});
export type ActBody = z.infer<typeof ActBody>;

export const TaskStartBody = z.object({
  goal: Goal,
  persona: z.string().min(1).max(128).default("first-time-user"),
  seed: Seed,
  maxSteps: MaxSteps,
  vm: VmSpec.optional(),
});
export type TaskStartBody = z.infer<typeof TaskStartBody>;

export const BenchmarkBody = z.object({
  name: z.string().min(1).max(128).default("evex-bench"),
  cases: z.array(z.string().min(1).max(128)).max(50).optional(),
  size: z.number().int().min(1).max(200).default(6),
  seed: Seed,
  agent: z.enum(["real", "mock-test-only"]).optional(),
  testOnly: z.boolean().optional(),
});
export type BenchmarkBody = z.infer<typeof BenchmarkBody>;

export const JudgmentBody = z.object({
  stepId: z.string().min(1).max(256),
  reviewer: z.string().min(1).max(128).default("reviewer"),
  reasonable: z.boolean(),
  targetCorrect: z.boolean(),
  understandable: z.boolean(),
  expected: z.boolean(),
  recoveryOk: z.boolean(),
  note: z.string().max(2048).optional(),
});
export type JudgmentBody = z.infer<typeof JudgmentBody>;

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

function enc(id: string): string {
  return encodeURIComponent(IdString.parse(id));
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

  private async raw(opts: RequestOptions): Promise<{ status: number; text: string }> {
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
      return { status: res.status, text: await res.text() };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new ControlPlaneError(0, "", `Control plane ${opts.method} ${opts.path} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async request<T>(opts: RequestOptions): Promise<T> {
    const { status, text } = await this.raw(opts);
    if (status >= 200 && status < 300) {
      if (text.length === 0) return undefined as unknown as T;
      const parsed: unknown = JSON.parse(text);
      return parsed as T;
    }
    throw new ControlPlaneError(status, text, `Control plane ${opts.method} ${opts.path} failed with ${status}`);
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

  /** Raw-text GET for non-JSON probes (GET /metrics is Prometheus text). */
  async getText(path: string, timeoutMs?: number): Promise<string> {
    const { status, text } = await this.raw({ method: "GET", path, timeoutMs });
    if (status >= 200 && status < 300) return text;
    throw new ControlPlaneError(status, text, `Control plane GET ${path} failed with ${status}`);
  }

  // ── root probes (no /v1 prefix) ──

  health(): Promise<{ ok: boolean; service: string; at: string }> {
    return this.get<{ ok: boolean; service: string; at: string }>("/health");
  }

  ready(): Promise<{ ready: boolean; sessions: number; vms: number; at: string }> {
    return this.get<{ ready: boolean; sessions: number; vms: number; at: string }>("/ready");
  }

  metricsText(): Promise<string> {
    return this.getText("/metrics");
  }

  // ── sessions ──

  async listSessions(): Promise<unknown> {
    return this.get<unknown>("/v1/sessions");
  }

  async createSession(input: z.input<typeof SessionCreateBody>): Promise<{ id: string; taskId: string; vmId: string; status: string }> {
    return this.post<{ id: string; taskId: string; vmId: string; status: string }>(
      "/v1/sessions",
      SessionCreateBody.parse(input),
    );
  }

  async getSession(sessionId: string): Promise<unknown> {
    return this.get<unknown>(`/v1/sessions/${enc(sessionId)}`);
  }

  async pauseSession(sessionId: string): Promise<unknown> {
    return this.post<unknown>(`/v1/sessions/${enc(sessionId)}/pause`, {});
  }

  async stepSession(sessionId: string): Promise<unknown> {
    return this.post<unknown>(`/v1/sessions/${enc(sessionId)}/step`, {});
  }

  async stopSession(sessionId: string): Promise<unknown> {
    return this.post<unknown>(`/v1/sessions/${enc(sessionId)}/stop`, {});
  }

  // ── vms ──

  async listVms(): Promise<unknown> {
    return this.get<unknown>("/v1/vms");
  }

  async createVm(input: z.input<typeof VmCreateBody>): Promise<{ id: string; state: string }> {
    return this.post<{ id: string; state: string }>("/v1/vms", VmCreateBody.parse(input));
  }

  async getVm(vmId: string): Promise<unknown> {
    return this.get<unknown>(`/v1/vms/${enc(vmId)}`);
  }

  async vmStatus(vmId: string): Promise<{ id: string; state: string }> {
    return this.get<{ id: string; state: string }>(`/v1/vms/${enc(vmId)}/status`);
  }

  async snapshotVm(vmId: string, label?: string): Promise<unknown> {
    return this.post<unknown>(`/v1/vms/${enc(vmId)}/snapshot`, label === undefined ? {} : { label });
  }

  async restoreVm(vmId: string, snapshot?: string): Promise<unknown> {
    return this.post<unknown>(`/v1/vms/${enc(vmId)}/restore`, snapshot === undefined ? {} : { snapshot });
  }

  async forkVm(vmId: string): Promise<unknown> {
    return this.post<unknown>(`/v1/vms/${enc(vmId)}/fork`, {});
  }

  async deleteVm(vmId: string): Promise<unknown> {
    return this.del<unknown>(`/v1/vms/${enc(vmId)}`);
  }

  // ── computer observe / act (session-scoped, flat act body) ──

  async observe(sessionId: string): Promise<unknown> {
    return this.get<unknown>(`/v1/computer/${enc(sessionId)}/observe`);
  }

  async act(
    sessionId: string,
    body: z.input<typeof ActBody>,
    opts?: { timeoutMs?: number; idempotencyKey?: string },
  ): Promise<unknown> {
    const parsed = ActBody.parse(body);
    return this.post<unknown>(`/v1/computer/${enc(sessionId)}/act`, parsed, {
      timeoutMs: opts?.timeoutMs,
      idempotencyKey: opts?.idempotencyKey ?? parsed.idempotencyKey,
    });
  }

  // ── human ──

  async requestHuman(sessionId: string, reason?: string): Promise<unknown> {
    return this.post<unknown>("/v1/human/request", { sessionId: IdString.parse(sessionId), reason });
  }

  async takeoverHuman(sessionId: string): Promise<unknown> {
    return this.post<unknown>("/v1/human/takeover", { sessionId: IdString.parse(sessionId) });
  }

  async releaseHuman(sessionId: string): Promise<unknown> {
    return this.post<unknown>("/v1/human/release", { sessionId: IdString.parse(sessionId) });
  }

  // ── tasks ──

  async startTask(input: z.input<typeof TaskStartBody>): Promise<{ id: string; status: string }> {
    return this.post<{ id: string; status: string }>("/v1/tasks/start", TaskStartBody.parse(input));
  }

  async taskStatus(taskId: string): Promise<unknown> {
    return this.get<unknown>(`/v1/tasks/${enc(taskId)}/status`);
  }

  async validateTask(taskId: string, evidence?: unknown): Promise<unknown> {
    return this.post<unknown>(`/v1/tasks/${enc(taskId)}/validate`, evidence ?? {});
  }

  // ── trace / replay / report ──

  async readTrace(sessionId: string): Promise<{ sessionId: string; steps: TraceStep[] }> {
    return this.get<{ sessionId: string; steps: TraceStep[] }>(`/v1/trace/${enc(sessionId)}`);
  }

  async replaySession(sessionId: string, seed?: number): Promise<unknown> {
    return this.post<unknown>(`/v1/replay/${enc(sessionId)}`, seed === undefined ? {} : { seed });
  }

  async sessionReport(sessionId: string): Promise<unknown> {
    return this.get<unknown>(`/v1/report/${enc(sessionId)}`);
  }

  async submitJudgment(input: z.input<typeof JudgmentBody>): Promise<unknown> {
    return this.post<unknown>("/v1/judgments", JudgmentBody.parse(input));
  }

  // ── benchmarks / models ──

  async runBenchmark(input: z.input<typeof BenchmarkBody>): Promise<unknown> {
    return this.post<unknown>("/v1/benchmarks", BenchmarkBody.parse(input));
  }

  async benchmarkStatus(benchmarkId: string): Promise<unknown> {
    return this.get<unknown>(`/v1/benchmarks/${enc(benchmarkId)}`);
  }

  async modelStatus(): Promise<unknown> {
    return this.get<unknown>("/v1/models/status");
  }

  /** WS live-frame path (upgrade to WebSocket; not a fetch route). */
  streamPath(sessionId: string): string {
    return `/v1/stream/${enc(sessionId)}`;
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
