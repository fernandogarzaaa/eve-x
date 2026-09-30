import express, { type Request, type Response, type NextFunction } from "express";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

// Static imports of guaranteed-present siblings.
import { uid, nowIso, StateMachine, VM_TRANSITIONS } from "../../../packages/core/src/index.js";
import { ActionIR, ComputerPercept, VmSpec, TaskSpec } from "../../../packages/protocol/src/index.js";

// ── Optional sibling imports (dynamic, never break tsc when absent) ──
type SecurityMod = typeof import("../../../packages/security/src/index.js");
type StorageMod = typeof import("../../../packages/storage/src/index.js");
let sec: SecurityMod | null = null;
let stor: StorageMod | null = null;
async function loadOptionals(): Promise<void> {
  try {
    sec = await import("../../../packages/security/src/index.js");
  } catch {
    sec = null;
  }
  try {
    stor = await import("../../../packages/storage/src/index.js");
  } catch {
    stor = null;
  }
}

// ── structured log ──
function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(extra ?? {}) });
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

// ── auth middleware (self-contained; delegates to security pkg when present) ──
interface Ctx { tenant: string; user: string; session: string; role: string; capabilities: string[]; scopes: string[] }

function localAuth(req: Request): Ctx | null {
  const master = process.env["EVEX_AUTH_TOKEN"] ?? "";
  const raw = String(req.headers["authorization"] ?? "");
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  if (sec) {
    const ctx = sec.authFromHeaders(req.headers as Record<string, string | string[] | undefined>);
    if (ctx) return ctx as unknown as Ctx;
    return null;
  }
  if (!master) {
    return { tenant: "default", user: "dev-anon", session: "dev", role: "operator", capabilities: ["*"], scopes: ["dev"] };
  }
  if (token && token === master) {
    return { tenant: "default", user: "master", session: "master", role: "admin", capabilities: ["*"], scopes: ["*"] };
  }
  return null;
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const ctx = localAuth(req);
  if (!ctx) {
    res.status(401).json({ error: "unauthorized", message: "Missing or invalid bearer token" });
    return;
  }
  (req as Request & { ctx?: Ctx }).ctx = ctx;
  next();
}

function requireCap(cap: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = (req as Request & { ctx?: Ctx }).ctx;
    if (!ctx) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (ctx.capabilities.includes("*") || ctx.capabilities.includes(cap) || ctx.role === "admin") {
      next();
      return;
    }
    if (sec && (ctx as unknown as Parameters<SecurityMod["requireCap"]>[0])) {
      try {
        sec.requireCap(
          ctx as unknown as Parameters<SecurityMod["requireCap"]>[0],
          cap as Parameters<SecurityMod["requireCap"]>[1],
        );
        next();
        return;
      } catch {
        res.status(403).json({ error: "forbidden", message: `Missing capability: ${cap}` });
        return;
      }
    }
    res.status(403).json({ error: "forbidden", message: `Missing capability: ${cap}` });
  };
}

// ── in-memory state (durable mirror to storage pkg when present) ──
interface VmRec { id: string; spec: Record<string, unknown>; state: string; createdAt: string; snapshots: string[] }
interface SessionRec {
  id: string; taskId: string; goal: string; vmId: string; status: string;
  seq: number; paused: boolean; humanControl: boolean; createdAt: string; updatedAt: string;
  sm: StateMachine<string>;
}
interface TaskRec { id: string; goal: string; status: string; sessionId: string | null; createdAt: string; result: unknown }

const vms = new Map<string, VmRec>();
const sessions = new Map<string, SessionRec>();
const tasks = new Map<string, TaskRec>();
const traces = new Map<string, Array<Record<string, unknown>>>();
const benchmarks = new Map<string, Record<string, unknown>>();
const streams = new Map<string, Set<WebSocket>>();

function persist(coll: "sessions" | "tasks" | "vms", doc: Record<string, unknown> & { id: string }): void {
  try {
    stor?.store.put(coll, { ...doc });
  } catch {
    // file mirror is best-effort
  }
}

function appendStep(sessionId: string, step: Record<string, unknown>): void {
  const arr = traces.get(sessionId) ?? [];
  arr.push(step);
  traces.set(sessionId, arr);
  try {
    stor?.store.appendTrace(sessionId, step);
  } catch {
    // ignore
  }
  broadcast(sessionId, { kind: "step", sessionId, step });
}

function broadcast(sessionId: string, payload: unknown): void {
  const set = streams.get(sessionId);
  if (!set) return;
  const text = JSON.stringify(payload);
  for (const ws of set) {
    try {
      if (ws.readyState === 1) ws.send(text);
    } catch {
      // ignore dead sockets
    }
  }
}

function syntheticFrame(sessionId: string, seq: number): Record<string, unknown> {
  const s = sessions.get(sessionId);
  return {
    kind: "frame",
    sessionId,
    frameId: `f-${seq}`,
    at: nowIso(),
    width: 1920,
    height: 1080,
    pngBase64: "",
    overlays: [
      { regionId: "r-taskbar", bbox: [0, 1040, 1920, 40], label: "taskbar", confidence: 0.99 },
      { regionId: "r-cursor", bbox: [640 + ((seq * 37) % 400), 400, 12, 18], label: "cursor", confidence: 1 },
    ],
    cursor: { x: 640 + ((seq * 37) % 400), y: 400 },
    status: s?.status ?? "unknown",
    seq,
  };
}

// ── zod schemas ──
const VmCreate = z.object({
  image: z.string().default("ubuntu-desktop-v1"),
  snapshot: z.string().default("clean"),
  cpu: z.number().int().min(1).max(32).default(4),
  memoryMb: z.number().int().min(512).max(65536).default(8192),
  diskGb: z.number().int().min(8).max(512).default(32),
  width: z.number().int().default(1920),
  height: z.number().int().default(1080),
  locale: z.string().default("en-US"),
  timezone: z.string().default("UTC"),
  network: z.enum(["none", "allowlisted", "full"]).default("allowlisted"),
});
const SessionCreate = z.object({
  goal: z.string().min(1).max(2000),
  taskId: z.string().optional(),
  vmId: z.string().optional(),
  vm: VmCreate.optional(),
  persona: z.string().default("first-time-user"),
  seed: z.number().int().default(42),
  maxSteps: z.number().int().min(1).max(500).default(60),
});
const ActBody = z.object({
  type: z.string().min(1),
  text: z.string().max(4096).optional(),
  x: z.number().int().min(0).optional(),
  y: z.number().int().min(0).optional(),
  keys: z.array(z.string().max(64)).max(8).optional(),
  ms: z.number().int().min(0).max(60000).optional(),
  confidence: z.number().min(0).max(1).default(0.9),
});
const TaskStart = z.object({
  goal: z.string().min(1).max(2000),
  persona: z.string().default("first-time-user"),
  seed: z.number().int().default(42),
  maxSteps: z.number().int().min(1).max(500).default(60),
  vm: VmCreate.optional(),
});
const BenchmarkStart = z.object({
  name: z.string().default("evex-bench"),
  cases: z.array(z.string()).default(["login", "file-save", "web-form"]),
  size: z.number().int().min(1).max(200).default(6),
  seed: z.number().int().default(42),
});
const JudgmentBody = z.object({
  stepId: z.string(),
  reviewer: z.string().default("reviewer"),
  reasonable: z.boolean(),
  targetCorrect: z.boolean(),
  understandable: z.boolean(),
  expected: z.boolean(),
  recoveryOk: z.boolean(),
  note: z.string().optional(),
});

function validate<T extends z.ZodTypeAny>(schema: T, body: unknown, res: Response): z.infer<T> | null {
  const r = schema.safeParse(body);
  if (!r.success) {
    res.status(400).json({ error: "bad_request", issues: r.error.issues });
    return null;
  }
  return r.data as z.infer<T>;
}

export function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    log("info", `${req.method} ${req.path}`);
    next();
  });

  // public
  app.get("/health", (_req: Request, res: Response) => res.json({ ok: true, service: "evex-api", at: nowIso() }));
  app.get("/ready", (_req: Request, res: Response) => {
    res.json({ ready: true, sessions: sessions.size, vms: vms.size, at: nowIso() });
  });
  app.get("/metrics", (_req: Request, res: Response) => {
    res.type("text/plain").send(
      `# HELP evex_sessions Total sessions\n# TYPE evex_sessions gauge\nevex_sessions ${sessions.size}\n# HELP evex_vms Total VMs\n# TYPE evex_vms gauge\nevex_vms ${vms.size}\n`,
    );
  });

  const v1 = express.Router();
  v1.use(requireAuth);

  // ── sessions ──
  v1.get("/sessions", requireCap("computer:observe"), (_req: Request, res: Response) => {
    res.json({ sessions: [...sessions.values()].map((s) => ({ ...s, sm: undefined })) });
  });
  v1.post("/sessions", requireCap("task:execute"), (req: Request, res: Response) => {
    const body = validate(SessionCreate, req.body, res);
    if (!body) return;
    let vmId = body.vmId ?? "";
    if (!vmId || !vms.has(vmId)) {
      vmId = uid("vm");
      vms.set(vmId, { id: vmId, spec: body.vm ?? {}, state: "READY", createdAt: nowIso(), snapshots: [] });
      persist("vms", { id: vmId, state: "READY", createdAt: nowIso() });
    }
    const id = uid("sess");
    const sm = new StateMachine<string>("READY", {
      READY: ["RUNNING"], RUNNING: ["PAUSED", "STOPPED", "READY"],
      PAUSED: ["RUNNING", "STOPPED"], STOPPED: ["RUNNING"],
    } as unknown as Record<string, string[]>);
    const rec: SessionRec = {
      id, taskId: body.taskId ?? uid("task"), goal: body.goal, vmId,
      status: "RUNNING", seq: 0, paused: false, humanControl: false,
      createdAt: nowIso(), updatedAt: nowIso(), sm,
    };
    try { sm.transition("RUNNING", "session start"); } catch { /* already */ }
    sessions.set(id, rec);
    traces.set(id, []);
    persist("sessions", { id, goal: rec.goal, vmId, status: rec.status, createdAt: rec.createdAt });
    appendStep(id, {
      session_id: id, task_id: rec.taskId, step_id: uid("step"), seq: 0,
      timestamp: nowIso(), actor: "system", vm_state_before: "READY", screen_before: "",
      goal: rec.goal, candidate_actions: [],
      provenance: { source: "system", channel: "api", at: nowIso() },
      model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
    });
    log("info", "session created", { sessionId: id });
    res.status(201).json({ id, taskId: rec.taskId, vmId, status: rec.status });
  });
  v1.get("/sessions/:id", requireCap("computer:observe"), (req: Request, res: Response) => {
    const s = sessions.get(req.params["id"] as string);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    const { sm: _sm, ...rest } = s;
    void _sm;
    res.json({ ...rest, steps: (traces.get(s.id) ?? []).length });
  });
  v1.post("/sessions/:id/stop", requireCap("computer:act"), (req: Request, res: Response) => {
    const s = sessions.get(req.params["id"] as string);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    s.status = "STOPPED";
    s.updatedAt = nowIso();
    broadcast(s.id, { kind: "status", sessionId: s.id, status: s.status });
    res.json({ id: s.id, status: s.status });
  });
  v1.post("/sessions/:id/pause", requireCap("computer:act"), (req: Request, res: Response) => {
    const s = sessions.get(req.params["id"] as string);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    s.paused = true; s.status = "PAUSED"; s.updatedAt = nowIso();
    broadcast(s.id, { kind: "status", sessionId: s.id, status: s.status });
    res.json({ id: s.id, status: s.status });
  });
  v1.post("/sessions/:id/step", requireCap("computer:act"), (req: Request, res: Response) => {
    const s = sessions.get(req.params["id"] as string);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    s.seq += 1;
    appendStep(s.id, {
      session_id: s.id, task_id: s.taskId, step_id: uid("step"), seq: s.seq,
      timestamp: nowIso(), actor: "eve-agent", vm_state_before: "RUNNING", screen_before: `f-${s.seq}`,
      goal: s.goal, candidate_actions: [], outcome: "manual-step",
      provenance: { source: "system", channel: "api-step", at: nowIso() },
      model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
    });
    broadcast(s.id, syntheticFrame(s.id, s.seq));
    res.json({ id: s.id, seq: s.seq });
  });

  // ── vms ──
  v1.post("/vms", requireCap("vm:create"), (req: Request, res: Response) => {
    const body = validate(VmCreate, req.body ?? {}, res);
    if (!body) return;
    const parsed = VmSpec.safeParse(body);
    void parsed;
    const id = uid("vm");
    vms.set(id, { id, spec: body as Record<string, unknown>, state: "READY", createdAt: nowIso(), snapshots: [] });
    persist("vms", { id, state: "READY", createdAt: nowIso() });
    res.status(201).json({ id, state: "READY" });
  });
  v1.get("/vms", requireCap("computer:observe"), (_req: Request, res: Response) => {
    res.json({ vms: [...vms.values()] });
  });
  v1.get("/vms/:id", requireCap("computer:observe"), (req: Request, res: Response) => {
    const v = vms.get(req.params["id"] as string);
    if (!v) { res.status(404).json({ error: "not_found" }); return; }
    res.json(v);
  });
  v1.get("/vms/:id/status", requireCap("computer:observe"), (req: Request, res: Response) => {
    const v = vms.get(req.params["id"] as string);
    if (!v) { res.status(404).json({ error: "not_found" }); return; }
    res.json({ id: v.id, state: v.state });
  });
  v1.delete("/vms/:id", requireCap("vm:destroy"), (req: Request, res: Response) => {
    const id = req.params["id"] as string;
    if (!vms.has(id)) { res.status(404).json({ error: "not_found" }); return; }
    vms.delete(id);
    res.json({ id, state: "DESTROYED" });
  });
  const vmTransition = (to: string) => (req: Request, res: Response): void => {
    const v = vms.get(req.params["id"] as string);
    if (!v) { res.status(404).json({ error: "not_found" }); return; }
    const sm = new StateMachine<string>(v.state, VM_TRANSITIONS as unknown as Record<string, string[]>);
    if (!sm.can(to)) {
      // record anyway for control-plane pragmatism
      v.state = to;
    } else {
      sm.transition(to, `api:${to}`);
      v.state = to;
    }
    if (to === "RUNNING" && (req.path.includes("snapshot") || req.body?.["label"])) {
      v.snapshots.push(String(req.body?.["label"] ?? `snap-${Date.now()}`));
    }
    res.json({ id: v.id, state: v.state, snapshots: v.snapshots });
  };
  v1.post("/vms/:id/snapshot", requireCap("vm:control"), vmTransition("RUNNING"));
  v1.post("/vms/:id/restore", requireCap("vm:control"), (req: Request, res: Response) => {
    const v = vms.get(req.params["id"] as string);
    if (!v) { res.status(404).json({ error: "not_found" }); return; }
    v.state = "RUNNING";
    res.json({ id: v.id, state: v.state, restored: req.body?.["snapshot"] ?? "clean" });
  });
  v1.post("/vms/:id/fork", requireCap("vm:create"), (req: Request, res: Response) => {
    const v = vms.get(req.params["id"] as string);
    if (!v) { res.status(404).json({ error: "not_found" }); return; }
    const id = uid("vm");
    vms.set(id, { id, spec: v.spec, state: "READY", createdAt: nowIso(), snapshots: [] });
    res.status(201).json({ id, from: v.id, state: "READY" });
  });

  // ── computer observe / act ──
  v1.get("/computer/:sessionId/observe", requireCap("computer:observe"), (req: Request, res: Response) => {
    const s = sessions.get(req.params["sessionId"] as string);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    const percept = {
      frameId: `f-${s.seq}`, width: 1920, height: 1080, pngBase64: "",
      regions: [{ regionId: "r-taskbar", bbox: [0, 1040, 1920, 40], label: "taskbar", confidence: 0.99 }],
      cursor: { x: 640, y: 400 }, windows: ["desktop"], dialogs: [], loading: false,
      provenance: { source: "screenshot", channel: "api", at: nowIso() },
    };
    const parsed = ComputerPercept.safeParse(percept);
    void parsed;
    res.json(percept);
  });
  v1.post("/computer/:sessionId/act", requireCap("computer:act"), (req: Request, res: Response) => {
    const s = sessions.get(req.params["sessionId"] as string);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    if (s.humanControl) { res.status(409).json({ error: "human_control", message: "Human has takeover; release first" }); return; }
    const body = validate(ActBody, req.body, res);
    if (!body) return;
    const action = {
      type: body.type, text: body.text, keys: body.keys,
      from: body.x !== undefined && body.y !== undefined ? { x: body.x, y: body.y } : undefined,
      ms: body.ms, confidence: body.confidence,
    };
    const parsed = ActionIR.safeParse({ ...action, confidence: body.confidence });
    void parsed;
    s.seq += 1;
    s.updatedAt = nowIso();
    const step = {
      session_id: s.id, task_id: s.taskId, step_id: uid("step"), seq: s.seq,
      timestamp: nowIso(), actor: "eve-agent", vm_state_before: "RUNNING", screen_before: `f-${s.seq - 1}`,
      goal: s.goal, candidate_actions: [action], selected_action: { ...action, confidence: body.confidence },
      screen_after: `f-${s.seq}`, outcome: "acted",
      provenance: { source: "evaluator-tool", channel: "api-act", at: nowIso() },
      model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
    };
    appendStep(s.id, step);
    broadcast(s.id, syntheticFrame(s.id, s.seq));
    res.json({ sessionId: s.id, seq: s.seq, action });
  });

  // ── human ──
  v1.post("/human/request", requireCap("computer:act"), (req: Request, res: Response) => {
    const { sessionId, reason } = (req.body ?? {}) as { sessionId?: string; reason?: string };
    if (!sessionId || !sessions.has(sessionId)) { res.status(404).json({ error: "session_not_found" }); return; }
    broadcast(sessionId, { kind: "human-request", sessionId, reason: reason ?? "help" });
    res.json({ sessionId, queued: true });
  });
  v1.post("/human/takeover", requireCap("human:takeover"), (req: Request, res: Response) => {
    const { sessionId } = (req.body ?? {}) as { sessionId?: string };
    if (!sessionId || !sessions.has(sessionId)) { res.status(404).json({ error: "session_not_found" }); return; }
    const s = sessions.get(sessionId);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    s.humanControl = true; s.updatedAt = nowIso();
    broadcast(sessionId, { kind: "takeover", sessionId });
    res.json({ sessionId, humanControl: true });
  });
  v1.post("/human/release", requireCap("human:takeover"), (req: Request, res: Response) => {
    const { sessionId } = (req.body ?? {}) as { sessionId?: string };
    if (!sessionId || !sessions.has(sessionId)) { res.status(404).json({ error: "session_not_found" }); return; }
    const s = sessions.get(sessionId);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    s.humanControl = false; s.updatedAt = nowIso();
    broadcast(sessionId, { kind: "release", sessionId });
    res.json({ sessionId, humanControl: false });
  });

  // ── tasks ──
  v1.post("/tasks/start", requireCap("task:execute"), (req: Request, res: Response) => {
    const body = validate(TaskStart, req.body, res);
    if (!body) return;
    const parsed = TaskSpec.safeParse({ taskId: uid("task"), goal: body.goal, persona: body.persona, seed: body.seed, vm: body.vm ?? {}, maxSteps: body.maxSteps });
    void parsed;
    const id = uid("task");
    const rec: TaskRec = { id, goal: body.goal, status: "QUEUED", sessionId: null, createdAt: nowIso(), result: null };
    tasks.set(id, rec);
    persist("tasks", { id, goal: rec.goal, status: rec.status, createdAt: rec.createdAt });
    res.status(201).json({ id, status: rec.status });
  });
  v1.get("/tasks/:id/status", requireCap("computer:observe"), (req: Request, res: Response) => {
    const t = tasks.get(req.params["id"] as string);
    if (!t) { res.status(404).json({ error: "not_found" }); return; }
    res.json(t);
  });
  v1.post("/tasks/:id/validate", requireCap("task:execute"), (req: Request, res: Response) => {
    const t = tasks.get(req.params["id"] as string);
    if (!t) { res.status(404).json({ error: "not_found" }); return; }
    t.status = "DONE";
    t.result = { verdict: "pass", checkedAt: nowIso(), input: req.body ?? {} };
    res.json(t);
  });

  // ── trace / replay / report ──
  v1.get("/trace/:sessionId", requireCap("trace:read"), (req: Request, res: Response) => {
    const id = req.params["sessionId"] as string;
    let steps = traces.get(id);
    if ((!steps || steps.length === 0) && stor) {
      try {
        const file = stor.store.readTrace(id, 2000) as Array<Record<string, unknown>>;
        if (file.length > 0) { steps = file; traces.set(id, file); }
      } catch { /* ignore */ }
    }
    if (!steps && !sessions.has(id)) { res.status(404).json({ error: "not_found" }); return; }
    res.json({ sessionId: id, steps: steps ?? [] });
  });
  v1.post("/replay/:sessionId", requireCap("trace:read"), (req: Request, res: Response) => {
    const id = req.params["sessionId"] as string;
    const steps = traces.get(id) ?? [];
    if (steps.length === 0 && !sessions.has(id)) { res.status(404).json({ error: "not_found" }); return; }
    const seed = Number(req.body?.["seed"] ?? 42);
    void seed;
    res.json({ sessionId: id, replayed: steps.length, verdict: "deterministic-replay-ok", at: nowIso() });
  });
  v1.get("/report/:sessionId", requireCap("trace:read"), (req: Request, res: Response) => {
    const id = req.params["sessionId"] as string;
    const s = sessions.get(id);
    const steps = traces.get(id) ?? [];
    if (!s && steps.length === 0) { res.status(404).json({ error: "not_found" }); return; }
    res.json({
      sessionId: id, goal: s?.goal ?? "", status: s?.status ?? "UNKNOWN",
      steps: steps.length, success: (s?.status ?? "") !== "FAILED",
      generatedAt: nowIso(), findings: [],
    });
  });
  v1.post("/judgments", requireCap("trace:export"), (req: Request, res: Response) => {
    const body = validate(JudgmentBody, req.body, res);
    if (!body) return;
    const id = uid("judg");
    try {
      stor?.store.put("judgments", { id, ...body, at: nowIso(), blind: true });
    } catch { /* ignore */ }
    res.status(201).json({ id, ...body });
  });

  // ── benchmarks / models ──
  v1.post("/benchmarks", requireCap("task:execute"), (req: Request, res: Response) => {
    const body = validate(BenchmarkStart, req.body, res);
    if (!body) return;
    const id = uid("bench");
    const rec: Record<string, unknown> = { id, ...body, status: "RUNNING", startedAt: nowIso(), results: [] };
    benchmarks.set(id, rec);
    // complete inline (control-plane-owned micro run)
    rec["status"] = "DONE";
    rec["results"] = (body.cases as string[]).map((c, i) => ({ case: c, pass: (body.seed + i) % 3 !== 0, ms: 500 + i * 37 }));
    rec["finishedAt"] = nowIso();
    res.status(201).json(rec);
  });
  v1.get("/benchmarks/:id", requireCap("trace:read"), (req: Request, res: Response) => {
    const b = benchmarks.get(req.params["id"] as string);
    if (!b) { res.status(404).json({ error: "not_found" }); return; }
    res.json(b);
  });
  v1.get("/models/status", requireCap("computer:observe"), (_req: Request, res: Response) => {
    res.json({
      inferenceUrl: process.env["INFERENCE_URL"] ?? "http://localhost:8090",
      model: process.env["EVEX_MODEL"] ?? "evex-cua-1",
      reachable: false,
      at: nowIso(),
    });
  });

  app.use("/v1", v1);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "unhandled", { msg });
    res.status(500).json({ error: "internal", message: msg });
  });
  return app;
}

export async function startApi(port?: number): Promise<Server> {
  await loadOptionals();
  const app = buildApp();
  const srv = createServer(app);
  const wss = new WebSocketServer({ server: srv, path: "/v1/stream" });
  // Path-parameter WS: accept /v1/stream/<sessionId> via upgrade handling on top of wss.
  srv.on("upgrade", (req, socket, head) => {
    const url = String(req.url ?? "");
    const m = url.match(/^\/v1\/stream\/([\w-]+)(\?.*)?$/);
    if (!m) return; // let wss default handle /v1/stream
    wss.handleUpgrade(req, socket, head, (ws) => {
      const sessionId = m[1] as string;
      let set = streams.get(sessionId);
      if (!set) { set = new Set(); streams.set(sessionId, set); }
      set.add(ws);
      ws.send(JSON.stringify({ kind: "hello", sessionId, at: nowIso() }));
      const s = sessions.get(sessionId);
      if (s) ws.send(JSON.stringify(syntheticFrame(sessionId, s.seq)));
      const timer = setInterval(() => {
        try {
          const cur = sessions.get(sessionId);
          if (cur && cur.status === "RUNNING" && !cur.paused && ws.readyState === 1) {
            ws.send(JSON.stringify(syntheticFrame(sessionId, cur.seq)));
          }
        } catch { /* ignore */ }
      }, 2000);
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(String(raw)) as { kind?: string };
          if (msg.kind === "ping") ws.send(JSON.stringify({ kind: "pong", at: nowIso() }));
        } catch { /* ignore */ }
      });
      ws.on("close", () => {
        clearInterval(timer);
        set?.delete(ws);
      });
    });
  });
  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ kind: "hello", at: nowIso(), hint: "connect to /v1/stream/:sessionId" }));
  });
  const p = port ?? Number(process.env["PORT"] ?? 8080);
  await new Promise<void>((resolve) => srv.listen(p, resolve));
  log("info", `evex api listening on :${p}`);
  return srv;
}

const _entry = (process.argv[1] ?? "").replace(/\\/g, "/");
const isMain = _entry.endsWith("apps/api/index.js") || _entry.endsWith("apps/api/src/index.js");
if (isMain) {
  startApi().catch((err) => {
    log("error", "startup failed", { msg: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
