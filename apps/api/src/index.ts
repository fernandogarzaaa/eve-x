import express, { type Request, type Response, type NextFunction } from "express";
import { createServer, type Server } from "node:http";
import { createConnection } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

// Static imports of guaranteed-present siblings.
import { uid, nowIso, sha256hex, canonicalJson, EveError, StateMachine, VM_TRANSITIONS, RELEASE, releaseIdentity, assertReleaseCommit } from "../../../packages/core/src/index.js";
import { ActionIR, ActionType, ComputerPercept, VmSpec, TaskSpec } from "../../../packages/protocol/src/index.js";
import { validateEvidence, EvidenceBundleSchema } from "../../../packages/validation/src/index.js";
import {
  VmManager, selectDriver, QemuDriver, DockerDesktopDriver, DevFramebufferDriver,
} from "../../../packages/vm/src/index.js";
import { ComputerRuntime, QmpFrameSource, VncRfbInput } from "../../../packages/computer/src/index.js";

// ── Optional sibling imports (dynamic, never break tsc when absent) ──
type SecurityMod = typeof import("../../../packages/security/src/index.js");
type StorageMod = typeof import("../../../packages/storage/src/index.js");
type BenchMod = {
  buildRegistry: () => Array<{
    benchTaskId: string; category: string; goal: string; split: string;
    seed: number; maxSteps: number; stepsOptimal: number; successSignals: string[];
  }>;
  evaluateBenchTask: (input: unknown) => Record<string, unknown>;
  mockAgentAdapter: (seed: number, label?: string) => unknown;
  runBench: (registry: unknown, agentFn: unknown, opts: unknown) => Promise<Record<string, unknown>>;
};
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

/** TCP reachability probe (driver-independent service presence check). */
function tcpReachable(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try { sock.destroy(); } catch { /* ignore */ }
      finish(false);
    }, timeoutMs);
    let sock: { destroy: () => void; on: (ev: string, fn: (e?: Error) => void) => void };
    try {
      sock = createConnection({ host, port });
    } catch {
      clearTimeout(timer);
      finish(false);
      return;
    }
    sock.on("connect", () => {
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* ignore */ }
      finish(true);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

function parseHostPort(url: string, dflt: number): { host: string; port: number } | null {
  try {
    const u = new URL(url.includes("://") ? url : `tcp://${url}`);
    const port = u.port ? Number(u.port) : dflt;
    if (!u.hostname || !Number.isInteger(port)) return null;
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

export interface ServiceProbe { reachable: boolean; detail: string; }

/** Gather reachability for the production gate. Prefers driver-level checks
 *  (pg/redis clients when installed) and falls back to TCP probes so a
 *  missing optional driver is reported honestly instead of as down. */
export async function probeServices(): Promise<Record<string, ServiceProbe>> {
  const out: Record<string, ServiceProbe> = {};
  const dbUrl = process.env["DATABASE_URL"] ?? "";
  if (dbUrl) {
    let via = "";
    if (stor) {
      try {
        const pg = await stor.pgStatus();
        if (pg.connected) {
          out["postgres"] = { reachable: true, detail: pg.detail };
          via = "driver";
        }
      } catch { /* fall through to TCP */ }
    }
    if (!via) {
      const hp = parseHostPort(dbUrl, 5432);
      const ok = hp ? await tcpReachable(hp.host, hp.port) : false;
      out["postgres"] = {
        reachable: ok,
        detail: ok ? `tcp-reachable ${dbUrl.split("@")[1] ?? dbUrl} (pg driver not installed; file store primary)` : `unreachable ${dbUrl.split("@")[1] ?? dbUrl}`,
      };
    }
  }
  const redisUrl = process.env["REDIS_URL"] ?? "";
  if (redisUrl) {
    let via = "";
    if (stor) {
      try {
        const rs = await stor.redisStatus();
        if (rs.connected) {
          out["redis"] = { reachable: true, detail: rs.detail };
          via = "driver";
        }
      } catch { /* fall through */ }
    }
    if (!via) {
      const hp = parseHostPort(redisUrl, 6379);
      const ok = hp ? await tcpReachable(hp.host, hp.port) : false;
      out["redis"] = {
        reachable: ok,
        detail: ok ? "tcp-reachable (redis driver not installed; coordination is file-lease based)" : `unreachable ${redisUrl}`,
      };
    }
  }
  const objUrl = process.env["OBJECT_ENDPOINT"] ?? "";
  if (objUrl) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch(objUrl, { method: "HEAD", signal: ctl.signal });
      clearTimeout(t);
      void res;
      out["object"] = { reachable: true, detail: `http-reachable ${objUrl}` };
    } catch (err) {
      out["object"] = { reachable: false, detail: `unreachable ${objUrl}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return out;
}

/** Required-services gate for production mode. With EVEX_REQUIRE_SERVICES
 *  set (e.g. "postgres,redis,object"), an unreachable required service
 *  refuses startup instead of silently falling back to dev storage. */
export async function enforceRequiredServices(): Promise<{ required: string[]; missing: string[] }> {
  const required = (process.env["EVEX_REQUIRE_SERVICES"] ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    .map((s) => (s === "minio" || s === "s3" || s === "garage" ? "object" : s));
  if (required.length === 0) return { required, missing: [] };
  const statuses = await probeServices();
  const missing = required.filter((s) => !statuses[s]?.reachable);
  if (missing.length > 0) {
    throw new Error(
      `EVEX_REQUIRE_SERVICES unmet: ${missing.join(", ")} unreachable ` +
      `(${missing.map((s) => statuses[s]?.detail ?? "no status").join("; ")}). ` +
      `Refusing production startup (no silent fallback).`,
    );
  }
  return { required, missing };
}

let prodGate: { required: string[]; missing: string[] } = { required: [], missing: [] };

/** Test/bootstrap hook: load security+storage singletons in-process. */
export async function ensureOptionals(): Promise<void> {
  if (!sec || !stor) await loadOptionals();
}

// ── structured log ──
function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(extra ?? {}) });
  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

// ── auth middleware (self-contained; delegates to security pkg when present) ──
interface Ctx { tenant: string; user: string; session: string; role: string; capabilities: string[]; scopes: string[] }
type ReqCtx = Request & { ctx?: Ctx; id?: string };

/** Scoped operator caps used when the security package is absent (fail closed: never ["*"]). */
const FALLBACK_OPERATOR_CAPS = [
  "vm:create", "vm:control", "computer:observe", "computer:act", "trace:read", "task:execute",
];

function safeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function executionMode(): "development" | "test" | "production" {
  const raw = (process.env["EVEX_MODE"] ?? "").trim().toLowerCase();
  if (raw === "production" || raw === "prod") return "production";
  if (raw === "test" || raw === "testing" || raw === "ci") return "test";
  return "development";
}

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
    // Security package absent + no master token: scoped dev operator ONLY
    // in development mode. Test/production fail closed (401 downstream).
    if (executionMode() !== "development") return null;
    return { tenant: "default", user: "dev-anon", session: "dev", role: "operator", capabilities: [...FALLBACK_OPERATOR_CAPS], scopes: ["dev"] };
  }
  if (token && safeEq(token, master)) {
    return { tenant: "default", user: "master", session: "master", role: "admin", capabilities: ["*"], scopes: ["*"] };
  }
  return null;
}

/** Verify a WebSocket upgrade request: bearer token via Authorization
 *  header or ?token= query (the WS path performs the same auth as HTTP —
 *  an HTTP 401 never becomes a WS hello). */
function upgradeAuth(req: { headers: Record<string, string | string[] | undefined>; url?: string }): Ctx | null {
  const fromQuery = (() => {
    try {
      const u = new URL(req.url ?? "/", "http://ws");
      const t = u.searchParams.get("token") ?? u.searchParams.get("access_token") ?? "";
      return t.trim();
    } catch {
      return "";
    }
  })();
  const headers = { ...(req.headers as Record<string, string | string[] | undefined>) };
  if (fromQuery && !headers["authorization"]) headers["authorization"] = `Bearer ${fromQuery}`;
  if (sec) {
    const ctx = sec.authFromHeaders(headers);
    if (ctx) return ctx as unknown as Ctx;
    return null;
  }
  const master = process.env["EVEX_AUTH_TOKEN"] ?? "";
  if (!master) {
    if (executionMode() !== "development") return null;
    return { tenant: "default", user: "dev-anon", session: "dev", role: "operator", capabilities: [...FALLBACK_OPERATOR_CAPS], scopes: ["dev"] };
  }
  const raw = String(headers["authorization"] ?? "");
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  if (token && safeEq(token, master)) {
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
  (req as ReqCtx).ctx = ctx;
  next();
}

function requireCap(cap: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = (req as ReqCtx).ctx;
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

// ── rate limiting: per-tenant + route-class fixed window (no deps) ──
interface Bucket { count: number; resetAt: number }
const rateBuckets = new Map<string, Bucket>();
const RATE_WINDOW_MS = 60_000;

function classifyRoute(fullPath: string, method: string): { cls: string; limit: number } {
  if (method === "POST" && /\/computer\/[^/]+\/act$/.test(fullPath)) return { cls: "act", limit: 120 };
  if (
    method === "POST" && (
      fullPath.endsWith("/sessions") || fullPath.endsWith("/vms") || fullPath.endsWith("/benchmarks") ||
      fullPath.endsWith("/tasks/start") || fullPath.endsWith("/snapshot") || fullPath.endsWith("/fork")
    )
  ) return { cls: "expensive", limit: 20 };
  return { cls: "default", limit: 600 };
}

function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const ctx = (req as ReqCtx).ctx;
  const tenant = ctx?.tenant ?? "anon";
  const full = `${(req.baseUrl ?? "")}${(req.path ?? "")}`;
  const { cls, limit } = classifyRoute(full, req.method);
  const key = `${tenant}:${cls}`;
  const nowMs = Date.now();
  let b = rateBuckets.get(key);
  if (!b || nowMs >= b.resetAt) b = { count: 0, resetAt: nowMs + RATE_WINDOW_MS };
  b.count += 1;
  rateBuckets.set(key, b);
  if (b.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((b.resetAt - nowMs) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: "rate_limited", retryAfter });
    return;
  }
  next();
}

// ── in-memory state (durable mirror to storage pkg when present) ──
interface VmRec {
  id: string; spec: Record<string, unknown>; state: string; createdAt: string; snapshots: string[];
  owner: string; driverVmId?: string; backend?: string;
}
interface SessionRec {
  id: string; taskId: string; goal: string; vmId: string; status: string;
  seq: number; paused: boolean; humanControl: boolean; createdAt: string; updatedAt: string;
  sm: StateMachine<string>; owner: string; lastFrame?: string; modeEnforced?: boolean;
  lastPngSha?: string; stallCount?: number; modeRetryAt?: number; vmLossReason?: string;
  lastRegions?: Array<{ regionId: string; bbox: [number, number, number, number]; label: string }>;
}
interface TaskRec { id: string; goal: string; status: string; sessionId: string | null; createdAt: string; result: unknown; owner: string }

const vms = new Map<string, VmRec>();
const sessions = new Map<string, SessionRec>();
const tasks = new Map<string, TaskRec>();
const traces = new Map<string, Array<Record<string, unknown>>>();
const benchmarks = new Map<string, Record<string, unknown>>();
const streams = new Map<string, Set<WebSocket>>();
// Act idempotency: "<sessionId>:<idempotencyKey>" -> original response body.
const idemResponses = new Map<string, unknown>();
// Judgment dedupe: "<stepId>:<reviewer>".
const judgmentKeys = new Set<string>();
interface JudgmentRec {
  id: string; stepId: string; sessionId: string; reviewer: string;
  reasonable: boolean; targetCorrect: boolean; at: string;
}
const judgmentRecs = new Map<string, JudgmentRec>();
// Blind reviews: "<reviewId>" -> pending review (server-side blinding).
interface ReviewRec {
  reviewId: string; sessionId: string; stepId: string;
  full: Record<string, unknown> | null; blind: Record<string, unknown>;
  status: "pending" | "complete"; createdAt: string;
  completedAt?: string; completedBy?: string;
}
const reviews = new Map<string, ReviewRec>();

const SESSION_SM: Record<string, string[]> = {
  READY: ["RUNNING"], RUNNING: ["PAUSED", "STOPPED", "READY", "FAILED"],
  PAUSED: ["RUNNING", "STOPPED"], STOPPED: ["RUNNING"], FAILED: ["STOPPED", "RUNNING"],
};
export { SESSION_SM };

const SNAP_LABEL_RE = /^[A-Za-z0-9_-]{1,64}$/;

function apiDataDir(): string {
  return process.env["DATA_DIR"] ?? "./data";
}

function persist(coll: "sessions" | "tasks" | "vms", doc: Record<string, unknown> & { id: string }): void {
  try {
    stor?.store.put(coll, { ...doc });
  } catch {
    // file mirror is best-effort
  }
}

function persistRemove(coll: "sessions" | "tasks" | "vms", id: string): void {
  try {
    stor?.store.remove(coll, id);
  } catch {
    // best-effort
  }
}

function persistSession(s: SessionRec): void {
  persist("sessions", {
    id: s.id, goal: s.goal, vmId: s.vmId, status: s.status, taskId: s.taskId,
    seq: s.seq, paused: s.paused, humanControl: s.humanControl, lastFrame: s.lastFrame,
    modeEnforced: s.modeEnforced, modeRetryAt: s.modeRetryAt, owner: s.owner, createdAt: s.createdAt, updatedAt: s.updatedAt,
    vmLossReason: s.vmLossReason,
  });
}

/**
 * Dead-VM truth: driver error codes that mean the guest is gone (not a
 * transient failure). Sessions whose VM dies must say FAILED with the
 * reason — never keep reporting RUNNING while observe/act cannot reach
 * any hypervisor channel.
 */
const VM_LOST_CODES = new Set(["QMP_CLOSED", "VM_NOT_RUNNING", "VM_NOT_FOUND"]);
export function isVmLostCode(code: unknown): boolean {
  return typeof code === "string" && VM_LOST_CODES.has(code);
}

function markSessionVmLost(s: SessionRec, reason: string): void {
  if (s.status === "FAILED") {
    s.vmLossReason = s.vmLossReason ?? reason;
    persistSession(s);
    return;
  }
  try { s.sm.transition("FAILED", "vm lost"); } catch { /* already there or map lag */ }
  s.status = "FAILED";
  s.vmLossReason = reason;
  s.updatedAt = nowIso();
  persistSession(s);
  closeRuntime(s.id);
  bump("vm_lost");
  s.seq += 1;
  appendStep(s.id, {
    session_id: s.id, task_id: s.taskId, step_id: uid("step"), seq: s.seq,
    timestamp: nowIso(), actor: "system", vm_state_before: "RUNNING", screen_before: s.lastFrame ?? "",
    goal: s.goal, candidate_actions: [], outcome: "vm-lost",
    vmLossReason: reason,
    provenance: { source: "system", channel: "api-vm-loss", at: nowIso() },
    model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
  });
  broadcast(s.id, { kind: "status", sessionId: s.id, status: s.status, vmLossReason: reason });
  log("warn", "session VM lost; session marked FAILED", { sessionId: s.id, vmId: s.vmId, reason });
}

function persistVm(v: VmRec): void {
  persist("vms", {
    id: v.id, spec: v.spec, state: v.state, snapshots: v.snapshots, owner: v.owner,
    createdAt: v.createdAt, driverVmId: v.driverVmId, backend: v.backend,
  });
}

function persistTask(t: TaskRec): void {
  persist("tasks", { id: t.id, goal: t.goal, status: t.status, sessionId: t.sessionId, result: t.result, owner: t.owner, createdAt: t.createdAt });
}

// ── control-plane ↔ worker takeover coherence ──
// API takeover/release writes data/control/<sessionId>.json {humanControl, paused, at}.
// The worker honors the same file (worker team implements their side); the act
// route denies when EITHER flag says humanControl, file winning when newer.
export interface ControlFlag { humanControl: boolean; paused: boolean; at: string }

function controlPath(sessionId: string): string {
  const safe = basename(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128) || "sess";
  return join(apiDataDir(), "control", `${safe}.json`);
}

function writeControlFlag(sessionId: string, humanControl: boolean, paused: boolean): void {
  try {
    mkdirSync(join(apiDataDir(), "control"), { recursive: true });
    writeFileSync(controlPath(sessionId), JSON.stringify({ humanControl, paused, at: nowIso() }), "utf8");
  } catch {
    // best-effort mirror
  }
}

function readControlFlag(sessionId: string): ControlFlag | null {
  try {
    const o = JSON.parse(readFileSync(controlPath(sessionId), "utf8")) as Partial<ControlFlag>;
    return { humanControl: o.humanControl === true, paused: o.paused === true, at: String(o.at ?? "") };
  } catch {
    return null;
  }
}

function effectiveHumanControl(s: SessionRec): boolean {
  const flag = readControlFlag(s.id);
  if (!flag) return s.humanControl;
  const memAt = Date.parse(s.updatedAt ?? "") || 0;
  const fileAt = Date.parse(flag.at ?? "") || 0;
  if (fileAt > memAt) return flag.humanControl; // file wins if newer
  return s.humanControl || flag.humanControl;
}

// ── owner / tenant isolation ──
function ownerOf(req: Request): string {
  const c = (req as ReqCtx).ctx;
  return `${c?.tenant ?? "unknown"}:${c?.user ?? "anon"}`;
}

/** 403 + true when the record is owned by another tenant/user. Unowned legacy docs stay readable. */
function denyIfNotOwner(rec: { owner?: string }, req: Request, res: Response): boolean {
  if (rec.owner && rec.owner !== ownerOf(req)) {
    res.status(403).json({ error: "forbidden", message: "cross-tenant access denied" });
    return true;
  }
  return false;
}

// ── driver-backed VMs + computer runtimes ────────────────────────────────
// Sessions/VMs are provisioned through VmManager (qemu/docker/dev per
// VM_BACKEND). The dev-framebuffer backend keeps the historical synthetic
// observe/act path, explicitly labeled synthetic:true — every other backend
// drives the REAL ComputerRuntime (screendump frames, VNC input, guest exec).

type VmManagerT = InstanceType<typeof VmManager>;
let manager: VmManagerT | null = null;
let managerBackend = "";

async function vmManager(): Promise<{ mgr: VmManagerT; backend: string }> {
  if (!manager) {
    const imagesDir = process.env["EVEX_IMAGES"] ?? "./images";
    const sel = await selectDriver({ imagesDir });
    const num = (v: string | undefined, dflt: number): number => {
      const n = v === undefined || v === "" ? NaN : Number(v);
      return Number.isFinite(n) ? n : dflt;
    };
    manager = new VmManager(sel.driver, [], {
      maxVmsPerTenant: num(process.env["EVEX_MAX_VMS_PER_TENANT"], 4),
      maxTotalVms: num(process.env["EVEX_MAX_TOTAL_VMS"], 32),
      maxCpuPerTenant: num(process.env["EVEX_MAX_CPU_PER_TENANT"], 16),
      maxMemMbPerTenant: num(process.env["EVEX_MAX_MEM_MB_PER_TENANT"], 32768),
    }) as VmManagerT;
    managerBackend = sel.backend;
    try {
      await manager.recover({ killOrphans: false });
    } catch { /* first boot: nothing to recover */ }
    log("info", "vm manager online", { backend: sel.backend, note: sel.note });
  }
  return { mgr: manager, backend: managerBackend };
}

interface SessionRuntime {
  runtime: ComputerRuntime;
  input: VncRfbInput | null;
  backend: string;
}
const runtimes = new Map<string, SessionRuntime>();

/** Driver VM id + backend for an API vm record (undefined for legacy bare records). */
function driverOf(v: VmRec): { driverVmId: string; backend: string } | null {
  if (!v.driverVmId || !v.backend) return null;
  return { driverVmId: v.driverVmId, backend: v.backend };
}

/** Owner string the manager uses for a request (must match creation owner). */
function mgrOwner(req: Request): string {
  return ownerOf(req);
}

/** Get-or-build the live computer runtime for a session (real backends only). */
async function runtimeForOwner(owner: string, s: SessionRec): Promise<SessionRuntime> {
  const v = s.vmId ? vms.get(s.vmId) : undefined;
  const d = v ? driverOf(v) : null;
  if (!d || d.backend === "dev-framebuffer") {
    throw new EveError("DEV_BACKEND", "session VM is dev-framebuffer (synthetic path)");
  }
  const hit = runtimes.get(s.id);
  if (hit) return hit;
  const { mgr } = await vmManager();
  // Force reattach for stale post-restart entries BEFORE resolving ports:
  // status() re-establishes QMP-proven control (or fails loudly), so the
  // VNC port below always belongs to this VM, never a recycled number.
  await mgr.status(d.driverVmId, owner);
  const frame = new QmpFrameSource(() => mgr.screendump(d.driverVmId, owner), 1000);
  let input: VncRfbInput | null = null;
  if (d.backend === "qemu") {
    const port = mgr.vncPort(d.driverVmId, owner);
    const vin = new VncRfbInput();
    await vin.connect("127.0.0.1", port);
    input = vin;
  }
  // Docker guests expose no host VNC port: pointer/key/type actions fail
  // closed with UNSUPPORTED at act time; observe + terminal/tool work. The
  // runtime still needs a VncInput object for construction, so an
  // unconnected instance is supplied and never used for those backends.
  const spec = (v?.spec ?? {}) as Record<string, unknown>;
  const runtime = new ComputerRuntime(frame, input ?? new VncRfbInput(), null, {
    width: Number(spec["width"] ?? 1920),
    height: Number(spec["height"] ?? 1080),
    channel: `api:${d.backend}`,
  });
  const rec: SessionRuntime = { runtime, input, backend: d.backend };
  runtimes.set(s.id, rec);
  return rec;
}

function closeRuntime(sessionId: string): void {
  const r = runtimes.get(sessionId);
  if (!r) return;
  runtimes.delete(sessionId);
  try {
    r.input?.disconnect();
  } catch { /* ignore */ }
  // Frame timers are never started server-side (observe() polls on demand),
  // so there is nothing else to release.
}

/** Cache perceived regions on the session for point→region grounding at act
 *  time. Best-effort: a cache failure never fails the observation. */
function cachePerceivedRegions(s: SessionRec, regions: unknown): void {
  try {
    const regs = (regions ?? []) as Array<{ regionId?: unknown; bbox?: unknown; label?: unknown }>;
    s.lastRegions = regs
      .filter((r) => typeof r.regionId === "string" && Array.isArray(r.bbox) && r.bbox.length === 4)
      .map((r) => ({
        regionId: String(r.regionId),
        bbox: (r.bbox as number[]).slice(0, 4) as [number, number, number, number],
        label: typeof r.label === "string" ? String(r.label) : "",
      }));
  } catch { /* grounding cache is best-effort */ }
}
/** Provision (create+boot) a driver VM for an API vm record. Throws loudly on failure. */
async function provisionDriverVm(owner: string, spec: Record<string, unknown>): Promise<{ driverVmId: string; backend: string }> {
  const { mgr, backend } = await vmManager();
  const baseImage = typeof process.env["EVEX_BASE_IMAGE"] === "string" && process.env["EVEX_BASE_IMAGE"] ? process.env["EVEX_BASE_IMAGE"] : undefined;
  const rec = await mgr.create(owner, spec, 3600000, baseImage ? { baseImage } : {});
  try {
    await mgr.boot(rec.vmId, owner);
  } catch (err) {
    try { await mgr.destroy(rec.vmId, owner); } catch { /* best effort */ }
    throw err;
  }
  return { driverVmId: rec.vmId, backend };
}

type FlatAction = {
  type: string; text?: string; keys?: string[];
  from?: { x: number; y: number }; ms?: number; confidence: number;
};

/**
 * REAL actuation path: verify against the runtime's last frame, actuate
 * through VNC/guest-exec, then re-observe the outcome. The trajectory only
 * advances on success; every failure leaves seq, frames, and trace
 * untouched. Throws EveError(STALE_PERCEPTION | UNSUPPORTED) for mapped
 * statuses, anything else becomes actuation_failed.
 */
async function realAct(
  owner: string,
  s: SessionRec,
  v: VmRec,
  drv: { driverVmId: string; backend: string },
  body: { frameId?: string; confidence: number },
  action: FlatAction,
): Promise<Record<string, unknown>> {
  const { mgr } = await vmManager();
  const { runtime, backend } = await runtimeForOwner(owner, s);
  const frameId = body.frameId ?? runtime.observedFrameId() ?? s.lastFrame;
  const type = action.type;
  if (type === "terminal" || type === "tool") {
    // CLI/tool actions ride the guest-exec channel, never the framebuffer.
    const argv = action.text ? ["sh", "-c", action.text] : ["true"];
    try {
      if (backend === "qemu") {
        await mgr.guestExecSync(drv.driverVmId, owner, argv, 60000);
      } else {
        const dd = mgr as unknown as {
          driverFor?: (id: string) => { driver: { exec?: (id: string, a: readonly string[]) => Promise<{ code: number }> } };
        };
        const entry = dd.driverFor?.(drv.driverVmId);
        if (!entry || typeof entry.driver.exec !== "function") {
          throw new EveError("UNSUPPORTED", `Backend ${backend} has no terminal channel`);
        }
        await entry.driver.exec(drv.driverVmId, argv);
      }
    } catch (err) {
      if (err instanceof EveError && (err.code === "UNSUPPORTED" || err.code === "QGA_ABSENT")) throw err;
      throw new EveError("ACTUATION_FAILED", `terminal action failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (type === "click" || type === "double_click" || type === "move" || type === "drag") {
    if (!action.from) throw new EveError("ACTUATION_FAILED", `${type} requires x/y coordinates`);
    if (backend !== "qemu") {
      throw new EveError("UNSUPPORTED", `Pointer actions unsupported on ${backend} guests (no host VNC channel)`);
    }
    if (type === "click") await runtime.click(action.from.x, action.from.y, "left", frameId);
    else if (type === "double_click") await runtime.doubleClick(action.from.x, action.from.y, frameId);
    else if (type === "move") await runtime.movePointer(action.from.x, action.from.y);
    else await runtime.drag(action.from, { x: action.from.x + 50, y: action.from.y + 50 }, frameId);
  } else if (type === "type") {
    if (backend !== "qemu") {
      throw new EveError("UNSUPPORTED", `Keyboard actions unsupported on ${backend} guests (no host VNC channel)`);
    }
    await runtime.type(action.text ?? "", frameId);
  } else if (type === "key") {
    if (backend !== "qemu") {
      throw new EveError("UNSUPPORTED", `Keyboard actions unsupported on ${backend} guests (no host VNC channel)`);
    }
    await runtime.key((action.keys ?? ["Return"])[0] as string, frameId);
  } else if (type === "hotkey") {
    if (backend !== "qemu") {
      throw new EveError("UNSUPPORTED", `Keyboard actions unsupported on ${backend} guests (no host VNC channel)`);
    }
    await runtime.hotkey(action.keys ?? ["Control_L", "Alt_L", "t"], frameId);
  } else if (type === "scroll") {
    if (backend !== "qemu") {
      throw new EveError("UNSUPPORTED", `Pointer actions unsupported on ${backend} guests (no host VNC channel)`);
    }
    await runtime.scroll(0, -3, frameId);
  } else if (type === "wait" || type === "observe") {
    await runtime.wait(action.ms ?? 500);
  } else if (type === "ask_human") {
    broadcast(s.id, { kind: "human-request", sessionId: s.id, reason: action.text ?? "agent requests help" });
  } else if (type === "terminate") {
    s.status = "STOPPED";
    s.updatedAt = nowIso();
    persistSession(s);
    closeRuntime(s.id);
    return { sessionId: s.id, seq: s.seq, action, terminated: true, synthetic: false };
  } else if (type === "zoom" || type === "crop" || type === "open_application") {
    await runtime.wait(300);
  } else {
    throw new EveError("UNSUPPORTED", `Action type ${type} has no real-backend implementation`);
  }
  // OBSERVE RESULT: re-perceive after every successful actuation.
  const after = await runtime.observe();
  s.seq += 1;
  s.lastFrame = String(after.frameId);
  s.updatedAt = nowIso();
  persistSession(s);
  // Point→region grounding: resolve the acted point against the regions from
  // the last perception. A contained point yields a verified visual-region
  // target + grounding record; otherwise the act is recorded unverified
  // (honest about ungrounded pointing, never invented).
  let target: Record<string, unknown> | undefined;
  let grounding: Record<string, unknown> | undefined;
  if (action.from && (type === "click" || type === "double_click" || type === "move" || type === "drag" || type === "scroll")) {
    // Bboxes are [x0, y0, x1, y1] corners everywhere (protocol, perception,
    // verifier IoU, contract examples).
    const regs = s.lastRegions ?? [];
    const hit = regs.find((r) =>
      action.from !== undefined &&
      action.from.x >= r.bbox[0] && action.from.y >= r.bbox[1] &&
      action.from.x <= r.bbox[2] && action.from.y <= r.bbox[3],
    );
    if (hit) {
      target = { kind: "visual-region", regionId: hit.regionId, bbox: hit.bbox, label: hit.label };
      grounding = { regionId: hit.regionId, bbox: hit.bbox, verified: true };
    } else {
      grounding = { verified: false, reason: "act point matched no perceived region" };
    }
  }
  const step = {
    session_id: s.id, task_id: s.taskId, step_id: uid("step"), seq: s.seq,
    timestamp: nowIso(), actor: "eve-agent", vm_state_before: "RUNNING", screen_before: frameId ?? "",
    goal: s.goal, candidate_actions: [action],
    selected_action: { ...action, confidence: body.confidence, ...(target ? { target } : {}) },
    ...(grounding ? { grounding } : {}),
    // Execution verification (NOT goal verification): the actuation ran
    // through the runtime and a post-action frame was captured. Whether the
    // goal advanced is decided by task oracles / human judgment, never here.
    verification: { passed: true, reason: `actuated via ${backend}; post-action frame ${String(after.frameId)} captured` },
    screen_after: String(after.frameId), outcome: "acted",
    provenance: { source: "screenshot", channel: `api-act:${backend}`, at: nowIso() },
    model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
  };
  appendStep(s.id, step);
  broadcast(s.id, { kind: "frame", sessionId: s.id, frameId: after.frameId, at: nowIso() });
  return { sessionId: s.id, seq: s.seq, action, frameId: after.frameId, synthetic: false };
}

// ── inference plane client ──────────────────────────────────────────────
// Shared by /suggest and the benchmark RealAgentAdapter. Every inference
// failure throws (callers map to an explicit 502 / inconclusive verdict) —
// the control plane never synthesizes an action when the model is down.
// When EVEX_INFERENCE_TOKEN is set it is forwarded as a bearer token so a
// hardened inference plane can authenticate callers.

export interface InferenceResult {
  action: Record<string, unknown>;
  modelId: string;
  modelVersion?: string;
  modelSha256?: string | null;
  degraded: boolean;
  latencyMs?: number;
}

export interface InferenceModelInfo {
  model_id: string;
  model_version?: string;
  model_sha256?: string | null;
  architecture?: string;
  device?: string;
  degraded: boolean;
}

function inferenceUrl(): string {
  return (process.env["INFERENCE_URL"] ?? "http://localhost:8090").replace(/\/$/, "");
}

function inferenceTimeoutMs(): number {
  return Math.max(100, Math.min(120000, Number(process.env["EVEX_INFERENCE_TIMEOUT_MS"] ?? 15000) || 15000));
}

function inferenceHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const tok = (process.env["EVEX_INFERENCE_TOKEN"] ?? "").trim();
  if (tok) h["authorization"] = `Bearer ${tok}`;
  return h;
}

export async function fetchInference(percept: {
  frameId: string; goal: string; width: number; height: number;
  pngBase64: string; regions: unknown;
}): Promise<InferenceResult> {
  const timeoutMs = inferenceTimeoutMs();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${inferenceUrl()}/infer`, {
      method: "POST",
      headers: inferenceHeaders(),
      body: JSON.stringify({
        frame_id: percept.frameId, goal: percept.goal,
        width: percept.width, height: percept.height,
        png_base64: percept.pngBase64, regions: percept.regions,
        timeout_ms: timeoutMs,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (r.status === 401 || r.status === 403) {
      throw new EveError("INFERENCE_AUTH", "inference plane refused credentials (set EVEX_INFERENCE_TOKEN)");
    }
    if (!r.ok) throw new EveError("INFERENCE_FAILED", `inference HTTP ${r.status}`);
    const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    const action = (j !== null && typeof j === "object" ? (j["action"] as unknown) : null) as Record<string, unknown> | null;
    if (!action || typeof action !== "object") {
      throw new EveError("INFERENCE_FAILED", "inference returned no action");
    }
    return {
      action,
      modelId: String((j as Record<string, unknown>)["model_id"] ?? "unknown"),
      modelVersion: typeof (j as Record<string, unknown>)["model_version"] === "string"
        ? ((j as Record<string, unknown>)["model_version"] as string)
        : undefined,
      modelSha256: typeof (j as Record<string, unknown>)["model_sha256"] === "string"
        ? ((j as Record<string, unknown>)["model_sha256"] as string)
        : null,
      degraded: ((j as Record<string, unknown>)["degraded"] as boolean) !== false,
      latencyMs: typeof (j as Record<string, unknown>)["latency_ms"] === "number"
        ? ((j as Record<string, unknown>)["latency_ms"] as number)
        : undefined,
    };
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof EveError) throw err;
    const reason = err instanceof Error && err.name === "AbortError" ? "inference timeout" : (err instanceof Error ? err.message : String(err));
    throw new EveError("INFERENCE_FAILED", reason.slice(0, 200));
  }
}

/** Best-effort model identity for benchmark provenance. Null when the plane
 *  is unreachable — recorded as null with reason, never invented. */
export async function fetchModelInfo(): Promise<InferenceModelInfo | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(`${inferenceUrl()}/model-info`, { headers: inferenceHeaders(), signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const j = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    if (!j || typeof j["model_id"] !== "string") return null;
    return {
      model_id: j["model_id"] as string,
      model_version: typeof j["model_version"] === "string" ? (j["model_version"] as string) : undefined,
      model_sha256: typeof j["model_sha256"] === "string" ? (j["model_sha256"] as string) : null,
      architecture: typeof j["architecture"] === "string" ? (j["architecture"] as string) : undefined,
      device: typeof j["device"] === "string" ? (j["device"] as string) : undefined,
      degraded: (j["degraded"] as boolean) === true,
    };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/** Best-effort restart recovery: load persisted sessions/tasks/vms into memory. */
export function hydrateFromDisk(): { sessions: number; tasks: number; vms: number; demoted?: number } {
  const out: { sessions: number; tasks: number; vms: number; demoted?: number } = { sessions: 0, tasks: 0, vms: 0 };
  if (!stor) return out;
  try {
    for (const d of stor.store.list("sessions", 500)) {
      const id = String(d["id"] ?? "");
      if (!id || sessions.has(id)) continue;
      // Recovery honesty: a session that was RUNNING when the process died
      // is NOT resurrected as RUNNING — its VM, runtime, and lease state
      // are unproven after a restart. It demotes to PAUSED with an explicit
      // reason and requires POST /v1/sessions/:id/resume to continue.
      // Nothing auto-executes on boot, ever.
      let status = String(d["status"] ?? "STOPPED");
      let paused = d["paused"] === true;
      let demoted = 0;
      if (status === "RUNNING") {
        status = "PAUSED";
        paused = true;
        demoted = 1;
      }
      const sm = new StateMachine<string>(status, SESSION_SM);
      const rec: SessionRec = {
        id, taskId: String(d["taskId"] ?? d["task_id"] ?? ""),
        goal: String(d["goal"] ?? ""), vmId: String(d["vmId"] ?? ""),
        status, seq: Number(d["seq"] ?? 0) || 0,
        paused, humanControl: d["humanControl"] === true,
        createdAt: String(d["createdAt"] ?? nowIso()), updatedAt: nowIso(),
        sm, owner: typeof d["owner"] === "string" ? String(d["owner"]) : "",
        lastFrame: typeof d["lastFrame"] === "string" ? String(d["lastFrame"]) : undefined,
        modeEnforced: d["modeEnforced"] === true,
        modeRetryAt: typeof d["modeRetryAt"] === "number" ? d["modeRetryAt"] : undefined,
        vmLossReason: typeof d["vmLossReason"] === "string" ? String(d["vmLossReason"]) : undefined,
      };
      sessions.set(id, rec);
      if (demoted === 1) {
        try {
          stor.store.put("sessions", {
            id, goal: rec.goal, vmId: rec.vmId, status: rec.status, taskId: rec.taskId,
            seq: rec.seq, paused: rec.paused, humanControl: rec.humanControl,
            lastFrame: rec.lastFrame, owner: rec.owner,
            createdAt: rec.createdAt, updatedAt: rec.updatedAt,
            recoveryNote: "demoted RUNNING->PAUSED on restart (unproven state; resume explicitly)",
          });
        } catch { /* best effort */ }
        try {
          writeControlFlag(id, rec.humanControl, true);
        } catch { /* best effort */ }
      }
      if (!traces.has(id)) traces.set(id, []);
      out.sessions += 1;
      out.demoted = (out.demoted ?? 0) + demoted;
    }
    for (const d of stor.store.list("tasks", 500)) {
      const id = String(d["id"] ?? "");
      if (!id || tasks.has(id)) continue;
      tasks.set(id, {
        id, goal: String(d["goal"] ?? ""), status: String(d["status"] ?? "QUEUED"),
        sessionId: (d["sessionId"] as string | null) ?? null,
        createdAt: String(d["createdAt"] ?? nowIso()), result: d["result"] ?? null,
        owner: typeof d["owner"] === "string" ? String(d["owner"]) : "",
      });
      out.tasks += 1;
    }
    for (const d of stor.store.list("vms", 500)) {
      const id = String(d["id"] ?? "");
      if (!id || vms.has(id)) continue;
      vms.set(id, {
        id, spec: (d["spec"] as Record<string, unknown>) ?? {},
        state: String(d["state"] ?? "READY"),
        createdAt: String(d["createdAt"] ?? nowIso()),
        snapshots: Array.isArray(d["snapshots"]) ? (d["snapshots"] as string[]) : [],
        owner: typeof d["owner"] === "string" ? String(d["owner"]) : "",
        driverVmId: typeof d["driverVmId"] === "string" ? String(d["driverVmId"]) : undefined,
        backend: typeof d["backend"] === "string" ? String(d["backend"]) : undefined,
      });
      out.vms += 1;
    }
    for (const d of stor.store.list("judgments", 2000)) {
      const kind = String(d["kind"] ?? "");
      if (!kind.startsWith("review")) {
        const k = `${String(d["stepId"] ?? "")}:${String(d["reviewer"] ?? "")}`;
        if (k !== ":") judgmentKeys.add(k);
        // Rehydrate judgment verdicts so task validation keeps its human
        // evidence across restarts (unknown ids stay unknown — no forging).
        if (typeof d["id"] === "string" && typeof d["stepId"] === "string") {
          const jid = String(d["id"]);
          if (!judgmentRecs.has(jid)) {
            judgmentRecs.set(jid, {
              id: jid, stepId: String(d["stepId"]),
              sessionId: typeof d["sessionId"] === "string" ? String(d["sessionId"]) : "",
              reviewer: String(d["reviewer"] ?? ""),
              reasonable: d["reasonable"] === true, targetCorrect: d["targetCorrect"] === true,
              at: String(d["at"] ?? nowIso()),
            });
          }
        }
      }
      // Rehydrate pending blind reviews (full step re-resolved at unlock).
      if (String(d["kind"] ?? "") === "review-pending" && typeof d["id"] === "string") {
        const reviewId = String(d["id"]);
        if (!reviews.has(reviewId)) {
          reviews.set(reviewId, {
            reviewId,
            sessionId: String(d["sessionId"] ?? ""),
            stepId: String(d["stepId"] ?? ""),
            full: null,
            blind: (d["blind"] as Record<string, unknown>) ?? {},
            status: "pending",
            createdAt: String(d["at"] ?? nowIso()),
          });
        }
      }
    }
  } catch {
    // hydration is best-effort
  }
  if (out.sessions + out.tasks + out.vms > 0) {
    log("info", "hydrated persisted docs", { ...out, note: "in-flight RUNNING demoted to PAUSED (resume explicitly; nothing auto-runs)" });
  }
  return out;
}

/** Test/restart hook: drop in-memory maps (persistence on disk is untouched). */
export function __clearMemory(): void {
  for (const sid of runtimes.keys()) closeRuntime(sid);
  vms.clear(); sessions.clear(); tasks.clear(); traces.clear();
  benchmarks.clear(); idemResponses.clear(); judgmentKeys.clear(); judgmentRecs.clear(); rateBuckets.clear();
  reviews.clear();
  manager = null;
  managerBackend = "";
}

// ── server-side blind review (§34): the API strips model-revealing fields ──
// The blind artifact keeps screen/timeline/regions (what the human judges)
// and drops everything that reveals the model's internals.
const BLIND_DROP_EXACT = new Set([
  "confidence", "rationale", "prediction", "verification",
  "evaluation", "evaluations", "score", "scores",
  "candidate-confidences", "candidate_confidences", "model_version",
]);

function stripBlindValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((e) => stripBlindValue(e));
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const low = k.toLowerCase();
      if (BLIND_DROP_EXACT.has(low)) continue;
      if (low.includes("confiden")) continue; // confidence + variants
      out[k] = stripBlindValue(val);
    }
    return out;
  }
  return v;
}

/** Resolve a full step for unlock: memory first, then the on-disk trace file. */
function resolveFullStep(sessionId: string, stepId: string): Record<string, unknown> | undefined {
  const mem = traces.get(sessionId) ?? [];
  const hit = mem.find((st) => String(st["step_id"] ?? "") === stepId);
  if (hit) return hit;
  if (stor) {
    try {
      const file = stor.store.readTrace(sessionId, 100000) as Array<Record<string, unknown>>;
      return file.find((st) => String(st["step_id"] ?? "") === stepId);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Locate the owning session for a step id across live sessions. Returns
 *  undefined when no session holds the step — callers must fail closed. */
function findSessionForStep(stepId: string): string | undefined {
  for (const [sid] of sessions) {
    try {
      const steps = mergedTraceSteps(sid, 2000);
      if (steps.some((st) => String(st["step_id"] ?? "") === stepId)) return sid;
    } catch { /* ignore unreadable sessions */ }
  }
  return undefined;
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

const CHAIN_GENESIS_DIGEST = "0".repeat(64);
const traceHeads = new Map<string, string>();

/** Chain-stamp a step with the session's SHA-256 append-only digest before
 *  it is stored or broadcast. Replayed/validated later by verifyReplay:
 *  any post-hoc mutation, reorder, deletion, or duplication of a chained
 *  step breaks verification. Heads survive in memory; after a restart the
 *  head is rebuilt from the persisted tail so the chain never forks. */
function chainStamp(sessionId: string, step: Record<string, unknown>): Record<string, unknown> {
  let head = traceHeads.get(sessionId);
  if (head === undefined) {
    head = CHAIN_GENESIS_DIGEST;
    if (stor) {
      try {
        const tail = stor.store.readTrace(sessionId, 1) as Array<Record<string, unknown>>;
        const last = tail.length > 0 ? tail[tail.length - 1] : undefined;
        const d = last !== undefined ? String(last["digest"] ?? "") : "";
        if (/^[0-9a-f]{64}$/.test(d)) head = d;
      } catch { /* no history: genesis head */ }
    }
  }
  const { digest: _d, prevDigest: _p, prev: _pv, ...body } = step;
  void _d; void _p; void _pv;
  const digest = sha256hex(`${head}.${canonicalJson(body)}`);
  traceHeads.set(sessionId, digest);
  return { ...step, prevDigest: head, digest };
}

function appendStep(sessionId: string, step: Record<string, unknown>): void {
  const stamped = chainStamp(sessionId, step);
  const arr = traces.get(sessionId) ?? [];
  arr.push(stamped);
  traces.set(sessionId, arr);
  try {
    stor?.store.appendTrace(sessionId, stamped);
  } catch {
    bump("trace_write_failed");
  }
  broadcast(sessionId, { kind: "step", sessionId, step: stamped });
}

/**
 * Full trace across restarts: in-memory steps plus any file-appended steps
 * missing from memory (deduped by step_id). Memory alone is incomplete
 * after a restart (it holds only post-restart appends); the file alone
 * misses nothing but costs a bounded tail read. Every trace consumer must
 * use this — never `traces.get()` directly.
 */
function mergedTraceSteps(sessionId: string, limit = 100000): Array<Record<string, unknown>> {
  const mem = traces.get(sessionId) ?? [];
  let file: Array<Record<string, unknown>> = [];
  if (stor) {
    try {
      file = stor.store.readTrace(sessionId, limit) as Array<Record<string, unknown>>;
    } catch { /* ignore */ }
  }
  if (file.length === 0) return mem;
  const memIds = new Set(mem.map((st) => String(st["step_id"] ?? st["seq"])));
  const extra = file.filter((st) => !memIds.has(String(st["step_id"] ?? st["seq"])));
  if (extra.length === 0) return mem;
  // Extras are pre-restart file history missing from this process's memory,
  // so they come FIRST; the merged stream is ordered by seq so replay's
  // physical-order check sees the true append order, not a restart artifact.
  return [...extra, ...mem].sort((a, b) => Number(a["seq"] ?? 0) - Number(b["seq"] ?? 0));
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
      // Corners [x0, y0, x1, y1], matching ActionIR throughout the system.
      { regionId: "r-taskbar", bbox: [0, 1040, 1919, 1079], label: "taskbar", confidence: 0.99 },
      { regionId: "r-cursor", bbox: [640 + ((seq * 37) % 400), 400, 640 + ((seq * 37) % 400) + 12, 418], label: "cursor", confidence: 1 },
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
  frameId: z.string().max(128).optional(),
  idempotencyKey: z.string().max(128).optional(),
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
  /** Execution agent. "real" drives real sessions/VMs through the control
   *  plane. "mock-test-only" is the explicit harness double: it requires
   *  testOnly:true and the record is stamped synthetic/test_only. */
  agent: z.enum(["real", "mock-test-only"]).default("real"),
  testOnly: z.boolean().default(false),
});
const JudgmentBody = z.object({
  stepId: z.string(),
  sessionId: z.string().min(1).max(128).optional(),
  reviewer: z.string().default("reviewer"),
  reasonable: z.boolean(),
  targetCorrect: z.boolean(),
  understandable: z.boolean(),
  expected: z.boolean(),
  recoveryOk: z.boolean(),
  note: z.string().optional(),
  reviewId: z.string().optional(),
});
const ReviewEnqueue = z.object({
  sessionId: z.string().min(1),
  stepId: z.string().min(1).optional(),
});
const ValidateRequest = z.object({
  evidence: EvidenceBundleSchema,
});

function validate<T extends z.ZodTypeAny>(schema: T, body: unknown, res: Response): z.infer<T> | null {
  const r = schema.safeParse(body);
  if (!r.success) {
    res.status(400).json({ error: "bad_request", issues: r.error.issues });
    return null;
  }
  return r.data as z.infer<T>;
}

type ReplayVerdict = "deterministic-replay-ok" | "replay-divergent";

export function verifyReplay(
  steps: Array<Record<string, unknown>>,
): { replayed: number; verdict: ReplayVerdict; issues: string[] } {
  const issues: string[] = [];
  const seen = new Map<number, number>();
  const LITE = ["session_id", "task_id", "step_id", "seq", "timestamp", "actor"];
  steps.forEach((st, idx) => {
    for (const f of LITE) {
      const val = st[f];
      if (val === undefined || val === null || val === "") issues.push(`step ${idx}: missing required field ${f}`);
    }
    const q = st["seq"];
    if (typeof q !== "number" || !Number.isInteger(q) || q < 0) {
      issues.push(`step ${idx}: invalid seq`);
      return;
    }
    seen.set(q, (seen.get(q) ?? 0) + 1);
  });
  for (const [q, n] of seen) {
    if (n > 1) issues.push(`duplicate seq ${q} (x${n})`);
  }
  const uniq = [...seen.keys()].sort((a, b) => a - b);
  if (uniq.length > 0) {
    const first = uniq[0] as number;
    if (first !== 0) issues.push(`trace starts at seq ${first} (expected 0)`);
    for (let i = 1; i < uniq.length; i += 1) {
      const prev = uniq[i - 1] as number;
      const cur = uniq[i] as number;
      if (cur !== prev + 1) issues.push(`seq gap: ${prev} -> ${cur} (missing ${cur - prev - 1})`);
    }
  }
  // Physical order: an append-only log must read 0,1,2,... in file order.
  // Set continuity alone would bless a reordered (tampered) log.
  steps.forEach((st, idx) => {
    if (st["seq"] !== idx) issues.push(`out-of-order seq at position ${idx} (seq ${String(st["seq"])})`);
  });
  // Digest chain: only when every step carries the SHA-256 digest+prevDigest
  // convention stamped by appendStep. Legacy 40-hex digests (pre-SHA-256
  // toy hash) are flagged, never trusted: they cannot verify tampering.
  const hasChain = steps.length > 0 && steps.every((st) => typeof st["digest"] === "string" && (typeof st["prevDigest"] === "string" || "prev" in st));
  if (hasChain) {
    let prevDigest = "";
    for (const st of steps) {
      const { digest: _d, prev: _p, prevDigest: _pd, ...rest } = st as Record<string, unknown> & { digest: unknown; prev: unknown; prevDigest: unknown };
      void _d; void _p; void _pd;
      const pStr = String(st["prevDigest"] ?? st["prev"] ?? "");
      const dStr = String(st["digest"] ?? "");
      if (!/^[0-9a-f]{64}$/.test(dStr) || (pStr !== "" && !/^[0-9a-f]{64}$/.test(pStr))) {
        issues.push(`weak legacy digest at seq ${String(st["seq"])} (not SHA-256 — cannot verify tampering)`);
        continue;
      }
      if (prevDigest !== "" && pStr !== prevDigest) {
        issues.push(`digest chain break at seq ${String(st["seq"])}: prev mismatch`);
      }
      const recomputed = sha256hex(`${pStr}.${canonicalJson(rest)}`);
      if (recomputed !== dStr) issues.push(`digest mismatch at seq ${String(st["seq"])}`);
      prevDigest = dStr;
    }
    void prevDigest;
  }
  return { replayed: steps.length, verdict: issues.length === 0 ? "deterministic-replay-ok" : "replay-divergent", issues };
}

function corsOrigins(): string[] {
  return (process.env["EVEX_CORS_ORIGINS"] ?? "http://localhost:3000,http://localhost:3001")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

// ── observability counters (in-memory; reset on restart, documented) ──
// verbs: _failed/_rejected count deterministic failure behavior, never
// hidden. Correlation: every counter event carries requestId in the
// structured log line emitted at the same site.
const metricsCounters: Record<string, number> = {
  actuation_failed: 0, stale_rejected: 0, unsupported_action: 0,
  human_takeover: 0, human_release: 0, benchmark_runs: 0, benchmark_failures: 0,
  inference_failed: 0, vm_lost: 0, vm_provision_failed: 0, trace_write_failed: 0,
  validation_pass: 0, validation_failed: 0, validation_inconclusive: 0, validation_invalid: 0,
};
function bump(name: string): void {
  metricsCounters[name] = (metricsCounters[name] ?? 0) + 1;
}

export function metricsSnapshot(): { gauges: Record<string, number>; counters: Record<string, number> } {
  let wsConnections = 0;
  for (const set of streams.values()) wsConnections += set.size;
  return {
    gauges: { sessions_active: sessions.size, vms_active: vms.size, queue_depth: 0, ws_connections: wsConnections },
    counters: { ...metricsCounters },
  };
}

export function buildApp(): express.Express {
  const app = express();
  // Request IDs first: every response carries x-request-id; 500s echo it.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const id = randomUUID();
    (req as ReqCtx).id = id;
    res.setHeader("x-request-id", id);
    next();
  });
  // Minimal CORS: reflect Origin only when allowlisted; handle OPTIONS. Never "*".
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = String(req.headers.origin ?? "");
    const allowed = corsOrigins();
    if (origin && allowed.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      if (origin && allowed.includes(origin)) {
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,Idempotency-Key,x-request-id");
      }
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    log("info", `${req.method} ${req.path}`, { requestId: (req as ReqCtx).id ?? "-" });
    next();
  });

  // public
  app.get("/health", (_req: Request, res: Response) => res.json({ ok: true, service: "evex-api", at: nowIso(), ...releaseIdentity() }));
  // Release identity endpoint (§3): exact build revision for release
  // qualification, mismatch detection, and incident attribution.
  app.get("/version", (_req: Request, res: Response) => res.json(releaseIdentity()));
  app.get("/ready", (_req: Request, res: Response) => {
    res.json({
      ready: true, sessions: sessions.size, vms: vms.size, at: nowIso(),
      persistence: {
        mode: prodGate.required.length === 0 ? "file-primary (no required services)" : "production",
        required: prodGate.required,
        missing: prodGate.missing,
      },
    });
  });
  app.get("/metrics", (_req: Request, res: Response) => {
    const snap = metricsSnapshot();
    const lines = [
      "# HELP evex_sessions Total sessions",
      "# TYPE evex_sessions gauge",
      `evex_sessions ${sessions.size}`,
      "# HELP evex_vms Total VMs",
      "# TYPE evex_vms gauge",
      `evex_vms ${vms.size}`,
    ];
    for (const [k, v] of Object.entries(snap.counters)) {
      lines.push(`# HELP evex_${k} Total ${k.replace(/_/g, " ")}`, `# TYPE evex_${k} counter`, `evex_${k} ${v}`);
    }
    res.type("text/plain").send(lines.join("\n") + "\n");
  });

  const v1 = express.Router();
  v1.use(requireAuth);
  v1.use(rateLimit);

  // ── sessions ──
  v1.get("/sessions", requireCap("computer:observe"), (req: Request, res: Response) => {
    const me = ownerOf(req);
    res.json({ sessions: [...sessions.values()].filter((s) => !s.owner || s.owner === me).map((s) => ({ ...s, sm: undefined })) });
  });
  v1.post("/sessions", requireCap("task:execute"), async (req: Request, res: Response) => {
    const body = validate(SessionCreate, req.body, res);
    if (!body) return;
    const owner = ownerOf(req);
    let vmId = body.vmId ?? "";
    let rec = vmId ? vms.get(vmId) : undefined;
    if (!rec) {
      vmId = uid("vm");
      // Every session VM is provisioned through the driver layer
      // (qemu/docker/dev per VM_BACKEND) — never a bare record. The dev
      // backend is record-only, so unit/dev flows stay side-effect free.
      const spec = { ...(body.vm ?? {}), image: (body.vm as { image?: string } | undefined)?.image ?? "ubuntu-desktop-v1" };
      let provisioned: { driverVmId: string; backend: string };
      try {
        provisioned = await provisionDriverVm(owner, spec as Record<string, unknown>);
      } catch (err) {
        bump("vm_provision_failed");
        res.status(500).json({ error: "vm_provision_failed", message: err instanceof Error ? err.message : String(err) });
        return;
      }
      rec = {
        id: vmId, spec: spec as Record<string, unknown>, state: "READY", createdAt: nowIso(),
        snapshots: [], owner, driverVmId: provisioned.driverVmId, backend: provisioned.backend,
      } satisfies VmRec;
      vms.set(vmId, rec);
      persistVm(rec);
    }
    const id = uid("sess");
    const sm = new StateMachine<string>("READY", SESSION_SM);
    const srec: SessionRec = {
      id, taskId: body.taskId ?? uid("task"), goal: body.goal, vmId,
      status: "RUNNING", seq: 0, paused: false, humanControl: false,
      createdAt: nowIso(), updatedAt: nowIso(), sm, owner,
    };
    try { sm.transition("RUNNING", "session start"); } catch { /* already */ }
    sessions.set(id, srec);
    traces.set(id, []);
    persistSession(srec);
    appendStep(id, {
      session_id: id, task_id: srec.taskId, step_id: uid("step"), seq: 0,
      timestamp: nowIso(), actor: "system", vm_state_before: "READY", screen_before: "",
      goal: srec.goal, candidate_actions: [],
      provenance: { source: "system", channel: "api", at: nowIso() },
      model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
    });
    log("info", "session created", { sessionId: id, requestId: (req as ReqCtx).id ?? "-" });
    res.status(201).json({ id, taskId: srec.taskId, vmId, status: srec.status, backend: rec?.backend ?? "unknown" });
  });
  v1.get("/sessions/:id", requireCap("computer:observe"), (req: Request, res: Response) => {
    const s = sessions.get(req.params["id"] as string);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(s, req, res)) return;
    const { sm: _sm, ...rest } = s;
    void _sm;
    const stepCount = mergedTraceSteps(s.id).length;
    res.json({ ...rest, steps: stepCount });
  });
  v1.post("/sessions/:id/stop", requireCap("computer:act"), (req: Request, res: Response) => {
    const s = sessions.get(req.params["id"] as string);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(s, req, res)) return;
    s.status = "STOPPED";
    s.updatedAt = nowIso();
    persistSession(s);
    closeRuntime(s.id);
    broadcast(s.id, { kind: "status", sessionId: s.id, status: s.status });
    res.json({ id: s.id, status: s.status });
  });
  v1.post("/sessions/:id/pause", requireCap("computer:act"), (req: Request, res: Response) => {
    const s = sessions.get(req.params["id"] as string);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(s, req, res)) return;
    s.paused = true; s.status = "PAUSED"; s.updatedAt = nowIso();
    persistSession(s);
    broadcast(s.id, { kind: "status", sessionId: s.id, status: s.status });
    res.json({ id: s.id, status: s.status });
  });
  // Explicit resume after pause OR restart-demotion. Resuming re-arms the
  // session for workers; it never backfills execution. Only PAUSED sessions
  // resume (FAILED/STOPPED/DONE are terminal; RUNNING needs no resume).
  v1.post("/sessions/:id/resume", requireCap("computer:act"), (req: Request, res: Response) => {
    const s = sessions.get(req.params["id"] as string);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(s, req, res)) return;
    if (s.status !== "PAUSED") {
      res.status(409).json({ error: "illegal_transition", message: `only PAUSED sessions resume (status ${s.status})` });
      return;
    }
    try {
      s.sm.transition("RUNNING", "explicit resume");
    } catch (err) {
      res.status(409).json({ error: "illegal_transition", message: err instanceof Error ? err.message : String(err) });
      return;
    }
    s.paused = false; s.status = "RUNNING"; s.updatedAt = nowIso();
    persistSession(s);
    try {
      writeControlFlag(s.id, s.humanControl, false);
    } catch { /* best effort */ }
    broadcast(s.id, { kind: "status", sessionId: s.id, status: s.status });
    res.json({ id: s.id, status: s.status });
  });
  v1.post("/sessions/:id/step", requireCap("computer:act"), (req: Request, res: Response) => {
    const s = sessions.get(req.params["id"] as string);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(s, req, res)) return;
    s.seq += 1;
    s.updatedAt = nowIso();
    persistSession(s);
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

  // ── vms (delegated to VmManager; API records mirror driver state) ──
  v1.post("/vms", requireCap("vm:create"), async (req: Request, res: Response) => {
    const body = validate(VmCreate, req.body ?? {}, res);
    if (!body) return;
    const parsed = VmSpec.safeParse(body);
    void parsed;
    const owner = ownerOf(req);
    let provisioned: { driverVmId: string; backend: string };
    try {
      provisioned = await provisionDriverVm(owner, body as Record<string, unknown>);
    } catch (err) {
      bump("vm_provision_failed");
      res.status(500).json({ error: "vm_provision_failed", message: err instanceof Error ? err.message : String(err) });
      return;
    }
    const id = uid("vm");
    const rec: VmRec = {
      id, spec: body as Record<string, unknown>, state: "READY", createdAt: nowIso(),
      snapshots: [], owner, driverVmId: provisioned.driverVmId, backend: provisioned.backend,
    };
    vms.set(id, rec);
    persistVm(rec);
    res.status(201).json({ id, state: "READY", backend: provisioned.backend, driverVmId: provisioned.driverVmId });
  });
  v1.get("/vms", requireCap("computer:observe"), (req: Request, res: Response) => {
    const me = ownerOf(req);
    res.json({ vms: [...vms.values()].filter((v) => !v.owner || v.owner === me) });
  });
  v1.get("/vms/:id", requireCap("computer:observe"), (req: Request, res: Response) => {
    const v = vms.get(req.params["id"] as string);
    if (!v) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(v, req, res)) return;
    res.json(v);
  });
  v1.get("/vms/:id/status", requireCap("computer:observe"), async (req: Request, res: Response) => {
    const v = vms.get(req.params["id"] as string);
    if (!v) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(v, req, res)) return;
    const drv = driverOf(v);
    if (drv && drv.backend !== "dev-framebuffer") {
      try {
        const { mgr } = await vmManager();
        const st = await mgr.status(drv.driverVmId, mgrOwner(req));
        v.state = String(st.state);
        persistVm(v);
        res.json({ id: v.id, state: v.state, backend: drv.backend });
        return;
      } catch (err) {
        res.status(502).json({ error: "driver_failed", message: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
    res.json({ id: v.id, state: v.state, backend: drv?.backend ?? "dev-framebuffer" });
  });
  v1.get("/vms/:id/audit", requireCap("trace:read"), async (req: Request, res: Response) => {
    // Driver audit trail: every lifecycle transition with reason + timestamp.
    // Invaluable when the cell state disagrees with expectations.
    const v = vms.get(req.params["id"] as string);
    if (!v) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(v, req, res)) return;
    const drv = driverOf(v);
    if (!drv || drv.backend === "dev-framebuffer") {
      res.json({ id: v.id, backend: drv?.backend ?? "dev-framebuffer", audit: [] });
      return;
    }
    try {
      const { mgr } = await vmManager();
      const entries = await mgr.auditLog(drv.driverVmId, mgrOwner(req));
      res.json({ id: v.id, backend: drv.backend, audit: entries });
    } catch (err) {
      res.status(502).json({ error: "driver_failed", message: err instanceof Error ? err.message : String(err) });
    }
  });
  v1.delete("/vms/:id", requireCap("vm:destroy"), async (req: Request, res: Response) => {
    const id = req.params["id"] as string;
    const v = vms.get(id);
    if (!v) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(v, req, res)) return;
    const drv = driverOf(v);
    if (drv && drv.backend !== "dev-framebuffer") {
      try {
        const { mgr } = await vmManager();
        await mgr.destroy(drv.driverVmId, mgrOwner(req));
      } catch (err) {
        res.status(502).json({ error: "driver_failed", message: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
    for (const [sid, s] of sessions) {
      if (s.vmId === id) closeRuntime(sid);
    }
    vms.delete(id);
    persistRemove("vms", id);
    res.json({ id, state: "DESTROYED" });
  });
  v1.post("/vms/:id/snapshot", requireCap("vm:control"), async (req: Request, res: Response) => {
    const v = vms.get(req.params["id"] as string);
    if (!v) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(v, req, res)) return;
    const label = String(req.body?.["label"] ?? `snap-${Date.now()}`);
    if (!SNAP_LABEL_RE.test(label)) {
      res.status(400).json({ error: "bad_request", message: "invalid snapshot label (alphanumeric, _, -; max 64)" });
      return;
    }
    const drv = driverOf(v);
    if (drv && drv.backend !== "dev-framebuffer") {
      try {
        const { mgr } = await vmManager();
        const snapId = await mgr.snapshot(drv.driverVmId, mgrOwner(req), label);
        const tag = snapId.includes("@") ? String(snapId.split("@")[1]) : label;
        if (!v.snapshots.includes(tag)) v.snapshots.push(tag);
        v.state = "RUNNING";
        persistVm(v);
        res.json({ id: v.id, state: v.state, snapshots: v.snapshots });
      } catch (err) {
        res.status(502).json({ error: "driver_failed", message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    const sm = new StateMachine<string>(v.state, VM_TRANSITIONS as unknown as Record<string, string[]>);
    if (!sm.can("RUNNING")) {
      res.status(409).json({ error: "illegal_transition", from: v.state, to: "RUNNING" });
      return;
    }
    sm.transition("RUNNING", "api:snapshot");
    v.state = "RUNNING";
    v.snapshots.push(label);
    persistVm(v);
    res.json({ id: v.id, state: v.state, snapshots: v.snapshots });
  });
  v1.post("/vms/:id/restore", requireCap("vm:control"), async (req: Request, res: Response) => {
    const v = vms.get(req.params["id"] as string);
    if (!v) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(v, req, res)) return;
    const label = String(req.body?.["snapshot"] ?? req.body?.["label"] ?? "clean");
    if (!SNAP_LABEL_RE.test(label)) {
      res.status(400).json({ error: "bad_request", message: "invalid snapshot label (alphanumeric, _, -; max 64)" });
      return;
    }
    if (!v.snapshots.includes(label)) {
      // Failed restore: never touch state.
      res.status(404).json({ error: "snapshot_not_found", snapshot: label });
      return;
    }
    const drv = driverOf(v);
    if (drv && drv.backend !== "dev-framebuffer") {
      try {
        const { mgr } = await vmManager();
        await mgr.restore(drv.driverVmId, mgrOwner(req), label);
        v.state = "RUNNING";
        persistVm(v);
        res.json({ id: v.id, state: v.state, restored: label });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof EveError && err.code === "SNAPSHOT_NOT_FOUND") {
          res.status(404).json({ error: "snapshot_not_found", snapshot: label });
          return;
        }
        if (err instanceof EveError && err.code === "INVALID_TRANSITION") {
          res.status(409).json({ error: "illegal_transition", message: msg });
          return;
        }
        v.state = "FAILED";
        persistVm(v);
        res.status(502).json({ error: "driver_failed", message: msg });
      }
      return;
    }
    v.state = "RUNNING";
    persistVm(v);
    res.json({ id: v.id, state: v.state, restored: label });
  });
  const vmLifecycle = (op: "pause" | "resume" | "reboot") => async (req: Request, res: Response) => {
    const v = vms.get(req.params["id"] as string);
    if (!v) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(v, req, res)) return;
    const drv = driverOf(v);
    if (!drv || drv.backend === "dev-framebuffer") {
      bump("unsupported_action");
      res.status(501).json({ error: "unsupported_action", message: `${op} requires a driver-backed VM` });
      return;
    }
    try {
      const { mgr } = await vmManager();
      await mgr[op](drv.driverVmId, mgrOwner(req));
      const st = await mgr.status(drv.driverVmId, mgrOwner(req));
      v.state = String(st.state);
      persistVm(v);
      res.json({ id: v.id, state: v.state });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof EveError && err.code === "INVALID_TRANSITION") {
        res.status(409).json({ error: "illegal_transition", message: msg });
        return;
      }
      res.status(502).json({ error: "driver_failed", message: msg });
    }
  };
  v1.post("/vms/:id/pause", requireCap("vm:control"), vmLifecycle("pause"));
  v1.post("/vms/:id/resume", requireCap("vm:control"), vmLifecycle("resume"));
  v1.post("/vms/:id/reboot", requireCap("vm:control"), vmLifecycle("reboot"));
  v1.post("/vms/:id/fork", requireCap("vm:create"), async (req: Request, res: Response) => {
    const v = vms.get(req.params["id"] as string);
    if (!v) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(v, req, res)) return;
    const owner = ownerOf(req);
    const drv = driverOf(v);
    if (drv && drv.backend !== "dev-framebuffer") {
      try {
        const { mgr } = await vmManager();
        const child = await mgr.fork(drv.driverVmId, owner, owner);
        const id = uid("vm");
        const rec: VmRec = {
          id, spec: v.spec, state: "READY", createdAt: nowIso(),
          snapshots: [], owner, driverVmId: child.vmId, backend: drv.backend,
        };
        vms.set(id, rec);
        persistVm(rec);
        res.status(201).json({ id, from: v.id, state: "READY", driverVmId: child.vmId });
      } catch (err) {
        res.status(502).json({ error: "driver_failed", message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    const id = uid("vm");
    const rec: VmRec = { id, spec: v.spec, state: "READY", createdAt: nowIso(), snapshots: [], owner };
    vms.set(id, rec);
    persistVm(rec);
    res.status(201).json({ id, from: v.id, state: "READY" });
  });
  v1.get("/computer/:sessionId/observe", requireCap("computer:observe"), async (req: Request, res: Response) => {
    const s = sessions.get(req.params["sessionId"] as string);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(s, req, res)) return;
    // A session whose VM died reports FAILED, never a stale RUNNING frame.
    if (s.status === "FAILED") {
      res.status(503).json({ error: "vm_unreachable", reason: s.vmLossReason ?? "vm lost" });
      return;
    }
    const v = s.vmId ? vms.get(s.vmId) : undefined;
    const drv = v ? driverOf(v) : null;
    if (drv && drv.backend !== "dev-framebuffer") {
      // REAL path: hypervisor screendump → perception → candidate regions.
      try {
        const { runtime } = await runtimeForOwner(mgrOwner(req), s);
        let percept = await runtime.observe();
        // Lazy resolution enforcement: the guest negotiates its own initial
        // mode (GDM/Xorg) and may drift later (idle resets); whenever the
        // frame dims mismatch the session spec, set the mode once via xrandr
        // through the guest-exec channel and re-observe. Failures back off
        // (cooldown) so a headless/warming guest costs one slow observe per
        // two minutes, not every poll.
        const wantW = Number((v?.spec as Record<string, unknown> | undefined)?.["width"] ?? 0) || 0;
        const wantH = Number((v?.spec as Record<string, unknown> | undefined)?.["height"] ?? 0) || 0;
        if (wantW > 0 && wantH > 0 && (percept.width !== wantW || percept.height !== wantH) && Date.now() >= (s.modeRetryAt ?? 0)) {
          try {
            const { mgr } = await vmManager();
            const cookieCmd = "for C in /run/user/*/gdm/Xauthority /var/lib/gdm3/.Xauthority; do " +
              `if [ -f "$C" ]; then XAUTHORITY=$C DISPLAY=:0 xrandr --output default --mode ${wantW}x${wantH} && break; fi; done`;
            await mgr.guestExecSync(drv.driverVmId, mgrOwner(req), ["/bin/sh", "-c", cookieCmd], 15000);
            percept = await runtime.observe();
            if (percept.width === wantW && percept.height === wantH) {
              s.modeEnforced = true;
            } else {
              s.modeRetryAt = Date.now() + 120000;
            }
          } catch {
            s.modeRetryAt = Date.now() + 120000;
          }
        }
        s.lastFrame = String(percept.frameId);
        s.updatedAt = nowIso();
        persistSession(s);
        // Cache perceived regions for point→region grounding at act time.
        cachePerceivedRegions(s, percept.regions);
        // Stall annotation: consecutive byte-identical frames mean the guest
        // is producing no visual change (wedged boot, frozen compositor, or
        // a genuinely idle screen). Advisory only — the console surfaces it;
        // no state change is inferred from pixels alone.
        let stalled = false;
        try {
          const sha = sha256hex(String(percept.pngBase64 ?? ""));
          if (s.lastPngSha !== undefined && s.lastPngSha === sha) {
            s.stallCount = (s.stallCount ?? 0) + 1;
          } else {
            s.lastPngSha = sha;
            s.stallCount = 0;
          }
          if ((s.stallCount ?? 0) >= 3) {
            stalled = true;
            log("warn", "guest visually stalled", { sessionId: s.id, vmId: s.vmId, consecutive: s.stallCount });
          }
        } catch { /* annotation is best-effort */ }
        broadcast(s.id, { kind: "frame", sessionId: s.id, frameId: percept.frameId, at: nowIso(), stalled });
        res.json({ ...percept, backend: drv.backend, synthetic: false, stalled });
      } catch (err) {
        const code = err instanceof EveError ? err.code : "observe_failed";
        // The guest is gone: mark the session FAILED (with reason) instead
        // of letting it claim RUNNING while no channel can reach the VM.
        if (err instanceof EveError && isVmLostCode(err.code)) {
          markSessionVmLost(s, `${err.code}: ${err.message}`);
          res.status(503).json({ error: "vm_unreachable", reason: s.vmLossReason ?? err.code });
          return;
        }
        res.status(code === "DEV_BACKEND" ? 500 : 502).json({
          error: code === "DEV_BACKEND" ? "internal" : "observe_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    const percept = {
      frameId: `f-${s.seq}`, width: 1920, height: 1080, pngBase64: "",
      // Corners [x0, y0, x1, y1] like every other producer in the system.
      regions: [{ regionId: "r-taskbar", bbox: [0, 1040, 1919, 1079], label: "taskbar", confidence: 0.99 }],
      cursor: { x: 640, y: 400 }, windows: ["desktop"], dialogs: [], loading: false,
      provenance: { source: "screenshot", channel: "api", at: nowIso() },
      backend: drv?.backend ?? "dev-framebuffer", synthetic: true,
    };
    s.lastFrame = `f-${s.seq}`;
    const parsed = ComputerPercept.safeParse({ ...percept });
    void parsed;
    res.json(percept);
  });
  // ── inference suggestion (§model-loop): ask the inference plane what to
  // do about the CURRENT percept. Advisory only: nothing is actuated, the
  // trace is untouched, and every inference failure maps to an explicit
  // 502 (the caller falls back to heuristic/manual action). The response
  // carries model_id + degraded so callers never mistake a heuristic
  // suggestion for a model one.
  v1.post("/computer/:sessionId/suggest", requireCap("computer:observe"), async (req: Request, res: Response) => {
    const sessionId = req.params["sessionId"] as string;
    const s = sessions.get(sessionId);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(s, req, res)) return;
    if (s.status === "FAILED") {
      res.status(503).json({ error: "vm_unreachable", reason: s.vmLossReason ?? "vm lost" });
      return;
    }
    const v = s.vmId ? vms.get(s.vmId) : undefined;
    const drv = v ? driverOf(v) : null;
    let percept: { frameId: string; width: number; height: number; pngBase64: string; regions: unknown[] };
    try {
      if (drv && drv.backend !== "dev-framebuffer") {
        const { runtime } = await runtimeForOwner(mgrOwner(req), s);
        const p = await runtime.observe();
        percept = {
          frameId: String((p as { frameId?: unknown }).frameId ?? s.lastFrame ?? `f-${s.seq}`),
          width: Number((p as { width?: unknown }).width ?? 1920),
          height: Number((p as { height?: unknown }).height ?? 1080),
          pngBase64: String((p as { pngBase64?: unknown }).pngBase64 ?? ""),
          regions: Array.isArray((p as { regions?: unknown }).regions)
            ? (p as { regions: unknown[] }).regions : [],
        };
        s.lastFrame = percept.frameId;
        s.updatedAt = nowIso();
        persistSession(s);
      } else {
        // Dev backend: synthetic percept (empty pixels). Product inference
        // servers reject empty png_base64; that 400 surfaces as 502 below.
        percept = {
          frameId: `f-${s.seq}`, width: 1920, height: 1080, pngBase64: "",
          regions: [{ regionId: "r-taskbar", bbox: [0, 1040, 1919, 1079], label: "taskbar", confidence: 0.99 }],
        };
      }
    } catch (err) {
      if (err instanceof EveError && isVmLostCode(err.code)) {
        markSessionVmLost(s, `${err.code}: ${err.message}`);
        res.status(503).json({ error: "vm_unreachable", reason: s.vmLossReason ?? err.code });
        return;
      }
      res.status(502).json({ error: "observe_failed", message: err instanceof Error ? err.message : String(err) });
      return;
    }
    const inferUrl = (process.env["INFERENCE_URL"] ?? "http://localhost:8090").replace(/\/$/, "");
    const timeoutMs = Math.max(100, Math.min(120000,
      Number(process.env["EVEX_INFERENCE_TIMEOUT_MS"] ?? 15000) || 15000));
    try {
      const out = await fetchInference({
        frameId: percept.frameId, goal: s.goal,
        width: percept.width, height: percept.height,
        pngBase64: percept.pngBase64, regions: percept.regions,
      });
      res.json({
        sessionId: s.id, frameId: percept.frameId, suggestion: out.action,
        model_id: out.modelId, model_version: out.modelVersion ?? null,
        model_sha256: out.modelSha256 ?? null, latency_ms: out.latencyMs,
        degraded: out.degraded, inference: inferUrl,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      bump("inference_failed");
      res.status(502).json({ error: "inference_unavailable", detail: reason.slice(0, 200) });
    }
  });
  v1.post("/computer/:sessionId/act", requireCap("computer:act"), async (req: Request, res: Response) => {
    const sessionId = req.params["sessionId"] as string;
    const s = sessions.get(sessionId);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(s, req, res)) return;
    if (effectiveHumanControl(s)) { res.status(409).json({ error: "human_control", message: "Human has takeover; release first" }); return; }
    if (s.status === "FAILED") {
      res.status(503).json({ error: "vm_unreachable", reason: s.vmLossReason ?? "vm lost" });
      return;
    }
    const body = validate(ActBody, req.body, res);
    if (!body) return;
    // A5: action type must be a known ActionIR enum member.
    if (!ActionType.safeParse(body.type).success) {
      res.status(400).json({ error: "bad_request", message: `unknown action type: ${body.type}` });
      return;
    }
    // A4: idempotency — repeat keys return the ORIGINAL response with no new step.
    if (body.idempotencyKey) {
      const prev = idemResponses.get(`${sessionId}:${body.idempotencyKey}`);
      if (prev !== undefined) {
        res.json(prev);
        return;
      }
    }
    // A4: stale perception guard. Real sessions compare against the last
    // observed frame id; synthetic sessions against f-seq.
    const v = s.vmId ? vms.get(s.vmId) : undefined;
    const drv = v ? driverOf(v) : null;
    const realPath = Boolean(drv && drv.backend !== "dev-framebuffer");
    const current = realPath ? (s.lastFrame ?? `f-${s.seq}`) : `f-${s.seq}`;
    if (body.frameId !== undefined && body.frameId !== current) {
      bump("stale_rejected");
      res.status(409).json({ error: "stale_perception", current });
      return;
    }
    const action = {
      type: body.type, text: body.text, keys: body.keys,
      from: body.x !== undefined && body.y !== undefined ? { x: body.x, y: body.y } : undefined,
      ms: body.ms, confidence: body.confidence,
    };
    const parsed = ActionIR.safeParse({ ...action, confidence: body.confidence });
    if (!parsed.success) {
      res.status(400).json({ error: "bad_request", issues: parsed.error.issues });
      return;
    }
    if (realPath && drv) {
      // REAL path: verify → actuate through the computer runtime →
      // re-observe the outcome. Failures never advance the trajectory.
      try {
        const resp = await realAct(mgrOwner(req), s, v as VmRec, drv, body, action);
        if (body.idempotencyKey) idemResponses.set(`${sessionId}:${body.idempotencyKey}`, resp);
        res.json(resp);
      } catch (err) {
        if (err instanceof EveError && isVmLostCode(err.code)) {
          markSessionVmLost(s, `${err.code}: ${err.message}`);
          res.status(503).json({ error: "vm_unreachable", reason: s.vmLossReason ?? err.code });
          return;
        }
        if (err instanceof EveError && (err.code === "STALE_PERCEPTION" || err.code === "UNSUPPORTED")) {
          bump(err.code === "STALE_PERCEPTION" ? "stale_rejected" : "unsupported_action");
          res.status(err.code === "STALE_PERCEPTION" ? 409 : 501).json({ error: err.code === "STALE_PERCEPTION" ? "stale_perception" : "unsupported_action", message: err.message });
          return;
        }
        bump("actuation_failed");
        res.status(502).json({ error: "actuation_failed", message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    s.seq += 1;
    s.updatedAt = nowIso();
    s.lastFrame = `f-${s.seq}`;
    persistSession(s);
    const step = {
      session_id: s.id, task_id: s.taskId, step_id: uid("step"), seq: s.seq,
      timestamp: nowIso(), actor: "eve-agent", vm_state_before: "RUNNING", screen_before: body.frameId ?? `f-${s.seq - 1}`,
      goal: s.goal, candidate_actions: [action], selected_action: { ...action, confidence: body.confidence },
      screen_after: `f-${s.seq}`, outcome: "acted",
      provenance: { source: "evaluator-tool", channel: "api-act", at: nowIso() },
      model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
    };
    appendStep(s.id, step);
    broadcast(s.id, syntheticFrame(s.id, s.seq));
    const resp = { sessionId: s.id, seq: s.seq, action, synthetic: true };
    if (body.idempotencyKey) idemResponses.set(`${sessionId}:${body.idempotencyKey}`, resp);
    res.json(resp);
  });

  // ── human ──
  v1.post("/human/request", requireCap("computer:act"), (req: Request, res: Response) => {
    const { sessionId, reason } = (req.body ?? {}) as { sessionId?: string; reason?: string };
    if (!sessionId || !sessions.has(sessionId)) { res.status(404).json({ error: "session_not_found" }); return; }
    const s = sessions.get(sessionId);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(s, req, res)) return;
    broadcast(sessionId, { kind: "human-request", sessionId, reason: reason ?? "help" });
    res.json({ sessionId, queued: true });
  });
  v1.post("/human/takeover", requireCap("human:takeover"), (req: Request, res: Response) => {
    const { sessionId } = (req.body ?? {}) as { sessionId?: string };
    if (!sessionId || !sessions.has(sessionId)) { res.status(404).json({ error: "session_not_found" }); return; }
    const s = sessions.get(sessionId);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(s, req, res)) return;
    s.humanControl = true; s.updatedAt = nowIso();
    persistSession(s);
    writeControlFlag(sessionId, true, s.paused);
    bump("human_takeover");
    broadcast(sessionId, { kind: "takeover", sessionId });
    res.json({ sessionId, humanControl: true });
  });
  v1.post("/human/release", requireCap("human:takeover"), (req: Request, res: Response) => {
    const { sessionId } = (req.body ?? {}) as { sessionId?: string };
    if (!sessionId || !sessions.has(sessionId)) { res.status(404).json({ error: "session_not_found" }); return; }
    const s = sessions.get(sessionId);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(s, req, res)) return;
    s.humanControl = false; s.updatedAt = nowIso();
    persistSession(s);
    writeControlFlag(sessionId, false, s.paused);
    bump("human_release");
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
    const rec: TaskRec = { id, goal: body.goal, status: "QUEUED", sessionId: null, createdAt: nowIso(), result: null, owner: ownerOf(req) };
    tasks.set(id, rec);
    persistTask(rec);
    res.status(201).json({ id, status: rec.status });
  });
  v1.get("/tasks/:id/status", requireCap("computer:observe"), (req: Request, res: Response) => {
    const t = tasks.get(req.params["id"] as string);
    if (!t) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(t, req, res)) return;
    res.json(t);
  });
  v1.post("/tasks/:id/validate", requireCap("task:execute"), (req: Request, res: Response) => {
    const t = tasks.get(req.params["id"] as string);
    if (!t) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(t, req, res)) return;
    // Independent validation: a verdict is DERIVED from server-resolved
    // trace evidence + oracle assertions + human judgments. Calling this
    // endpoint never manufactures success — without evidence the result is
    // INCONCLUSIVE or INVALID_EVIDENCE, never PASS.
    const parsed = ValidateRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "evidence_required", message: "validation requires an evidence bundle", issues: parsed.error.issues });
      return;
    }
    const ev = parsed.data.evidence;
    const s = sessions.get(ev.sessionId);
    if (!s) { res.status(404).json({ error: "not_found", message: "evidence session unknown" }); return; }
    if (denyIfNotOwner(s, req, res)) return;
    const steps = mergedTraceSteps(ev.sessionId);
    const replay = verifyReplay(steps);
    const chained = steps.length > 0 && steps.every(
      (st) => /^[0-9a-f]{64}$/.test(String(st["digest"] ?? "")) &&
        (/^[0-9a-f]{64}$/.test(String(st["prevDigest"] ?? "")) || /^[0-9a-f]{64}$/.test(String(st["prev"] ?? ""))),
    );
    const byId = new Map(steps.map((st) => [String(st["step_id"] ?? ""), st]));
    const resolvedSteps = ev.stepIds
      .map((id) => byId.get(id))
      .filter((st): st is Record<string, unknown> => st !== undefined)
      .map((st) => ({
        step_id: String(st["step_id"] ?? ""),
        seq: Number(st["seq"] ?? 0),
        outcome: typeof st["outcome"] === "string" ? (st["outcome"] as string) : undefined,
        grounding: (st["grounding"] ?? undefined) as { verified?: boolean } | undefined,
        verification: (st["verification"] ?? undefined) as { passed?: boolean } | undefined,
        raw: st,
      }));
    const judgments = ev.judgmentIds
      .map((id) => judgmentRecs.get(id))
      .filter((j): j is JudgmentRec => j !== undefined)
      .map((j) => ({ id: j.id, stepId: j.stepId, reviewer: j.reviewer, reasonable: j.reasonable, targetCorrect: j.targetCorrect }));
    const result = validateEvidence({
      taskId: t.id, evidence: ev, resolvedSteps,
      replay: { verdict: replay.verdict, issues: replay.issues, chained },
      judgments, traceChained: chained,
    });
    t.result = result;
    if (result.verdict === "PASS" || result.verdict === "FAILED") t.status = "DONE";
    bump(result.verdict === "PASS" ? "validation_pass" : result.verdict === "FAILED" ? "validation_failed" : result.verdict === "INCONCLUSIVE" ? "validation_inconclusive" : "validation_invalid");
    persistTask(t);
    res.json({ task: { id: t.id, status: t.status }, validation: result });
  });

  // ── trace / replay / report ──
  // Owner enforcement is unconditional: an unknown session fails closed
  // (404) even when file-backed steps exist — legacy/unowned records never
  // become a cross-tenant read path (including post-restart, when memory
  // may lag the files).
  v1.get("/trace/:sessionId", requireCap("trace:read"), (req: Request, res: Response) => {
    const id = req.params["sessionId"] as string;
    const s = sessions.get(id);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(s, req, res)) return;
    const steps = mergedTraceSteps(id, 2000);
    res.json({ sessionId: id, steps });
  });
  v1.post("/replay/:sessionId", requireCap("trace:read"), (req: Request, res: Response) => {
    const id = req.params["sessionId"] as string;
    const s = sessions.get(id);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(s, req, res)) return;
    // Merge worker/file-appended steps missing from memory (dedupe by step_id).
    const steps = mergedTraceSteps(id);
    const { replayed, verdict, issues } = verifyReplay(steps);
    res.json({ sessionId: id, replayed, verdict, issues });
  });
  v1.get("/report/:sessionId", requireCap("trace:read"), (req: Request, res: Response) => {
    const id = req.params["sessionId"] as string;
    const s = sessions.get(id);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(s, req, res)) return;
    const steps = mergedTraceSteps(id);
    res.json({
      sessionId: id, goal: s?.goal ?? "", status: s?.status ?? "UNKNOWN",
      steps: steps.length, success: (s?.status ?? "") !== "FAILED",
      generatedAt: nowIso(), findings: [],
    });
  });
  // ── server-side blind review (§34) ──
  // POST /v1/reviews enqueues a blind review: the server strips
  // confidence/rationale/prediction/verification/score fields and returns only
  // the blind artifact. The full step is unlocked by submitting a judgment
  // with the returned reviewId.
  v1.post("/reviews", requireCap("trace:read"), (req: Request, res: Response) => {
    const body = validate(ReviewEnqueue, req.body, res);
    if (!body) return;
    const s = sessions.get(body.sessionId);
    if (!s) { res.status(404).json({ error: "not_found", message: "no such session" }); return; }
    if (denyIfNotOwner(s, req, res)) return;
    const steps = mergedTraceSteps(body.sessionId);
    if (steps.length === 0) {
      res.status(404).json({ error: "not_found", message: "session has no steps yet" });
      return;
    }
    let full: Record<string, unknown> | undefined;
    if (body.stepId) {
      full = steps.find((st) => String(st["step_id"] ?? "") === body.stepId);
      if (!full) { res.status(404).json({ error: "not_found", message: "no such step in session" }); return; }
    } else {
      full = steps[steps.length - 1];
    }
    if (!full) { res.status(404).json({ error: "not_found" }); return; }
    const stepId = String(full["step_id"] ?? "");
    const reviewId = uid("review");
    const blind = stripBlindValue(full) as Record<string, unknown>;
    const rec: ReviewRec = {
      reviewId, sessionId: body.sessionId, stepId,
      full, blind, status: "pending", createdAt: nowIso(),
    };
    reviews.set(reviewId, rec);
    try {
      stor?.store.put("judgments", {
        id: reviewId, kind: "review-pending",
        sessionId: rec.sessionId, stepId: rec.stepId,
        at: rec.createdAt, blind: true,
      });
    } catch { /* ignore */ }
    res.status(201).json({ reviewId, blind: { ...blind, reviewId, sessionId: rec.sessionId, stepId } });
  });
  v1.post("/judgments", requireCap("trace:export"), (req: Request, res: Response) => {
    const body = validate(JudgmentBody, req.body, res);
    if (!body) return;
    const reviewer = String(body.reviewer ?? "").trim();
    if (!reviewer) {
      res.status(400).json({ error: "bad_request", message: "reviewer identity is required" });
      return;
    }
    // Blind-review unlock path: a reviewId pins this judgment to a pending
    // server-side blind review. Double-submit of the same reviewId → 409.
    // Owner enforcement: the owning session must exist and belong to the
    // caller. Review-bound judgments inherit the review's session; direct
    // judgments carry sessionId or are resolved by step scan. Unknown
    // sessions/steps fail closed (404) — no orphan or cross-tenant judgments.
    let review: ReviewRec | undefined;
    let judgmentSessionId: string | undefined;
    if (body.reviewId) {
      review = reviews.get(body.reviewId);
      if (!review) { res.status(404).json({ error: "not_found", message: "no such review" }); return; }
      if (review.status === "complete") {
        res.status(409).json({ error: "duplicate", reviewId: review.reviewId });
        return;
      }
      if (body.stepId !== review.stepId) {
        res.status(400).json({ error: "bad_request", message: "stepId does not match the blind review" });
        return;
      }
      judgmentSessionId = review.sessionId;
    } else if (body.sessionId) {
      judgmentSessionId = body.sessionId;
    } else {
      judgmentSessionId = findSessionForStep(body.stepId);
      if (!judgmentSessionId) {
        res.status(404).json({ error: "not_found", message: "step is unknown to every live session" });
        return;
      }
    }
    const js = sessions.get(judgmentSessionId);
    if (!js) { res.status(404).json({ error: "not_found", message: "owning session unknown" }); return; }
    if (denyIfNotOwner(js, req, res)) return;
    // The judged step must exist in the owning session's trace: judgments
    // on phantom steps are evidence failure, not verdicts.
    try {
      const steps = mergedTraceSteps(judgmentSessionId, 2000);
      if (!steps.some((st) => String(st["step_id"] ?? "") === body.stepId)) {
        res.status(404).json({ error: "not_found", message: "step is unknown to the owning session" });
        return;
      }
    } catch {
      res.status(404).json({ error: "not_found", message: "owning session trace unreadable" });
      return;
    }
    const key = `${body.stepId}:${reviewer}`;
    if (judgmentKeys.has(key)) {
      res.status(409).json({ error: "duplicate", stepId: body.stepId, reviewer });
      return;
    }
    judgmentKeys.add(key);
    const id = uid("judg");
    const rec: JudgmentRec = {
      id, stepId: body.stepId, sessionId: judgmentSessionId,
      reviewer, reasonable: body.reasonable === true, targetCorrect: body.targetCorrect === true,
      at: nowIso(),
    };
    judgmentRecs.set(id, rec);
    try {
      stor?.store.put("judgments", { id, ...body, reviewer, sessionId: judgmentSessionId, at: rec.at, blind: true });
    } catch { /* ignore */ }
    if (review) {
      review.status = "complete";
      review.completedAt = nowIso();
      review.completedBy = reviewer;
      try {
        stor?.store.put("judgments", {
          id: review.reviewId, kind: "review-complete",
          sessionId: review.sessionId, stepId: review.stepId,
          at: review.completedAt, blind: true, judgmentId: id,
        });
      } catch { /* ignore */ }
      const full = review.full ?? resolveFullStep(review.sessionId, review.stepId);
      res.status(201).json({ id, ...body, reviewer, reviewId: review.reviewId, full: full ?? null });
      return;
    }
    res.status(201).json({ id, ...body, reviewer });
  });

  // ── benchmarks / models ──
  // RealAgentAdapter: every benchmark task executes against a REAL
  // session/VM through the same observe → infer → act path as production
  // traffic (observe via ComputerRuntime, action from the inference plane,
  // actuation via realAct with grounding + stale enforcement + evidence
  // steps). There is no synthetic inline agent: benchmark numbers come
  // from executed trajectories scored by the IndependentEvaluator, or the
  // run reports invalid/inconclusive counts instead of numbers.
  async function runRealBenchTask(
    owner: string,
    mod: BenchMod,
    task: {
      benchTaskId: string; category: string; goal: string; split: string;
      seed: number; maxSteps: number; stepsOptimal: number; successSignals: string[];
    },
    modelInfo: InferenceModelInfo | null,
  ): Promise<Record<string, unknown>> {
    const modelIdentity = modelInfo
      ? {
        model_id: modelInfo.model_id,
        ...(modelInfo.model_version !== undefined ? { model_version: modelInfo.model_version } : {}),
        model_sha256: modelInfo.model_sha256 ?? null,
        degraded: modelInfo.degraded,
      }
      : null;
    const invalid = (): Record<string, unknown> => mod.evaluateBenchTask({
      task, steps: [], evidenceDigests: [],
      agentIdentity: "evex-real-agent", modelIdentity, backendSynthetic: true,
    }) as Record<string, unknown>;
    const spec = { image: "ubuntu-desktop-v1", width: 1280, height: 800 };
    let provisioned: { driverVmId: string; backend: string };
    try {
      provisioned = await provisionDriverVm(owner, spec as Record<string, unknown>);
    } catch {
      return invalid();
    }
    const sid = uid("sess");
    const vmId = uid("vm");
    const rec: VmRec = {
      id: vmId, spec: spec as Record<string, unknown>, state: "READY", createdAt: nowIso(),
      snapshots: [], owner, driverVmId: provisioned.driverVmId, backend: provisioned.backend,
    };
    vms.set(vmId, rec);
    persistVm(rec);
    const sm = new StateMachine<string>("READY", SESSION_SM);
    const srec: SessionRec = {
      id: sid, taskId: task.benchTaskId, goal: task.goal, vmId,
      status: "RUNNING", seq: 0, paused: false, humanControl: false,
      createdAt: nowIso(), updatedAt: nowIso(), sm, owner,
    };
    try { sm.transition("RUNNING", "benchmark task start"); } catch { /* already */ }
    sessions.set(sid, srec);
    traces.set(sid, []);
    persistSession(srec);
    appendStep(sid, {
      session_id: sid, task_id: task.benchTaskId, step_id: uid("step"), seq: 0,
      timestamp: nowIso(), actor: "system", vm_state_before: "READY", screen_before: "",
      goal: task.goal, candidate_actions: [],
      provenance: { source: "system", channel: "api-bench", at: nowIso() },
      model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
    });
    const realPath = provisioned.backend !== "dev-framebuffer";
    const drv = { driverVmId: provisioned.driverVmId, backend: provisioned.backend };
    let lastModel = modelIdentity;
    let terminated = false;
    try {
      const maxSteps = Math.min(Math.max(task.maxSteps, 1), 200);
      for (let i = 0; i < maxSteps && !terminated; i += 1) {
        if (effectiveHumanControl(srec)) break;
        if (!realPath) {
          // Dev backend: no pixels exist. Advance with an explicitly
          // synthetic step so the loop shape is exercised; the evaluator
          // scores the trajectory invalid (counted, never scored).
          srec.seq += 1;
          srec.lastFrame = `f-${srec.seq}`;
          srec.updatedAt = nowIso();
          persistSession(srec);
          appendStep(sid, {
            session_id: sid, task_id: task.benchTaskId, step_id: uid("step"), seq: srec.seq,
            timestamp: nowIso(), actor: "eve-agent", vm_state_before: "RUNNING", screen_before: `f-${srec.seq - 1}`,
            goal: task.goal, candidate_actions: [{ type: "observe", confidence: 0.5 }],
            screen_after: `f-${srec.seq}`, outcome: "acted", synthetic: true,
            provenance: { source: "evaluator-tool", channel: "api-bench:dev-synthetic", at: nowIso() },
            model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
          });
          continue;
        }
        let frameId: string;
        let percept: { frameId: string; width: number; height: number; pngBase64: string; regions: unknown };
        try {
          const { runtime } = await runtimeForOwner(owner, srec);
          const p = await runtime.observe();
          frameId = String((p as { frameId?: unknown }).frameId ?? "");
          if (!frameId) throw new EveError("OBSERVE_FAILED", "runtime returned no frame");
          percept = {
            frameId,
            width: Number((p as { width?: unknown }).width ?? 0) || 0,
            height: Number((p as { height?: unknown }).height ?? 0) || 0,
            pngBase64: String((p as { pngBase64?: unknown }).pngBase64 ?? ""),
            regions: (p as { regions?: unknown }).regions ?? [],
          };
          srec.lastFrame = frameId;
          srec.updatedAt = nowIso();
          persistSession(srec);
          cachePerceivedRegions(srec, percept.regions);
        } catch (err) {
          if (err instanceof EveError && isVmLostCode(err.code)) {
            markSessionVmLost(srec, `${err.code}: ${err.message}`);
          } else {
            srec.seq += 1;
            appendStep(sid, {
              session_id: sid, task_id: task.benchTaskId, step_id: uid("step"), seq: srec.seq,
              timestamp: nowIso(), actor: "system", vm_state_before: "RUNNING", screen_before: srec.lastFrame ?? "",
              goal: task.goal, candidate_actions: [], outcome: "observe-failed",
              provenance: { source: "system", channel: "api-bench", at: nowIso() },
              model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
            });
          }
          break;
        }
        let inf: InferenceResult;
        try {
          inf = await fetchInference({ ...percept, goal: task.goal });
        } catch {
          srec.seq += 1;
          appendStep(sid, {
            session_id: sid, task_id: task.benchTaskId, step_id: uid("step"), seq: srec.seq,
            timestamp: nowIso(), actor: "system", vm_state_before: "RUNNING", screen_before: frameId,
            goal: task.goal, candidate_actions: [], outcome: "inference-failed",
            provenance: { source: "system", channel: "api-bench", at: nowIso() },
            model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
          });
          break;
        }
        lastModel = {
          model_id: inf.modelId,
          ...(inf.modelVersion !== undefined ? { model_version: inf.modelVersion } : {}),
          model_sha256: inf.modelSha256 ?? null,
          degraded: inf.degraded,
        };
        const a = inf.action;
        const pt = (a["to"] ?? a["from"]) as { x?: unknown; y?: unknown } | undefined;
        const action = {
          type: String(a["type"] ?? "observe"),
          text: typeof a["text"] === "string" ? (a["text"] as string) : undefined,
          keys: Array.isArray(a["keys"]) ? (a["keys"] as string[]) : undefined,
          from: pt !== undefined && typeof pt.x === "number" && typeof pt.y === "number"
            ? { x: pt.x as number, y: pt.y as number }
            : undefined,
          ms: typeof a["ms"] === "number" ? (a["ms"] as number) : undefined,
          confidence: typeof a["confidence"] === "number" ? (a["confidence"] as number) : 0.5,
        };
        try {
          const resp = await realAct(owner, srec, rec, drv, { frameId, confidence: action.confidence }, action) as Record<string, unknown>;
          if (resp["terminated"] === true) terminated = true;
        } catch (err) {
          if (err instanceof EveError && err.code === "STALE_PERCEPTION") continue;
          if (err instanceof EveError && isVmLostCode(err.code)) {
            markSessionVmLost(srec, `${err.code}: ${err.message}`);
            break;
          }
          srec.seq += 1;
          appendStep(sid, {
            session_id: sid, task_id: task.benchTaskId, step_id: uid("step"), seq: srec.seq,
            timestamp: nowIso(), actor: "system", vm_state_before: "RUNNING", screen_before: frameId,
            goal: task.goal, candidate_actions: [], outcome: "actuation-failed",
            provenance: { source: "system", channel: "api-bench", at: nowIso() },
            model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
          });
          break;
        }
      }
    } finally {
      // Bound benchmark resources: destroy the driver VM, stop the session.
      try {
        const { mgr } = await vmManager();
        await mgr.destroy(drv.driverVmId, owner);
      } catch { /* best effort */ }
      closeRuntime(sid);
      try { srec.sm.transition("STOPPED", "benchmark task complete"); } catch { /* already terminal */ }
      srec.status = "STOPPED";
      srec.updatedAt = nowIso();
      persistSession(srec);
    }
    const steps = mergedTraceSteps(sid);
    const last = steps.length > 0 ? steps[steps.length - 1] : undefined;
    const headDigest = last !== undefined ? String(last["digest"] ?? "") : "";
    return mod.evaluateBenchTask({
      task,
      steps,
      evidenceDigests: /^[0-9a-f]{64}$/.test(headDigest) ? [headDigest] : [],
      agentIdentity: "evex-real-agent",
      modelIdentity: lastModel,
      backendSynthetic: !realPath,
    }) as Record<string, unknown>;
  }

  v1.post("/benchmarks", requireCap("task:execute"), async (req: Request, res: Response) => {
    const body = validate(BenchmarkStart, req.body, res);
    if (!body) return;
    const requestId = (req as ReqCtx).id ?? "-";
    let mod: BenchMod | null = null;
    try {
      const loaded = await import("../../../packages/benchmarks/src/index.js") as unknown as BenchMod;
      if (loaded && typeof loaded.buildRegistry === "function" && typeof loaded.runBench === "function") mod = loaded;
    } catch {
      mod = null;
    }
    if (!mod) {
      res.status(503).json({ error: "benchmark-unavailable" });
      return;
    }
    try {
      const id = uid("bench");
      const registry = mod.buildRegistry();
      const pool = registry.filter((t) => t.split !== "heldout");
      const wanted = (body.cases as string[]).map((c) => String(c).toLowerCase());
      const picked: Array<(typeof pool)[number]> = [];
      for (const w of wanted) {
        const hit = pool.find((t) =>
          !picked.includes(t) && (
            t.category.toLowerCase().includes(w) ||
            t.goal.toLowerCase().includes(w) ||
            t.benchTaskId.toLowerCase().includes(w)
          ),
        );
        if (hit) picked.push(hit);
      }
      if (picked.length === 0) picked.push(...pool.filter((t) => t.split === "test"));
      for (const t of pool) {
        if (picked.length >= body.size) break;
        if (!picked.includes(t)) picked.push(t);
      }
      const selected = picked.slice(0, Math.min(Math.max(body.size, 1), 200));
      const splits = [...new Set(selected.map((t) => t.split))];
      const owner = ownerOf(req);
      let agentFn: (task: unknown) => Promise<Record<string, unknown>>;
      let agentIdentity = "evex-real-agent";
      let testOnly = false;
      let modelIdentity: InferenceModelInfo | null = null;
      if (body.agent === "mock-test-only") {
        // Explicit harness double: requires testOnly:true, and the record
        // is stamped so production consumers refuse it.
        if (body.testOnly !== true) {
          res.status(400).json({
            error: "mock_agent_requires_test_only",
            message: "mock-test-only agent requires testOnly:true — production benchmarks refuse mock evidence",
          });
          return;
        }
        if (typeof mod.mockAgentAdapter !== "function") {
          res.status(503).json({ error: "benchmark-unavailable" });
          return;
        }
        testOnly = true;
        agentIdentity = "mock-test-only";
        agentFn = mod.mockAgentAdapter(body.seed, "mock-test-only") as (task: unknown) => Promise<Record<string, unknown>>;
      } else {
        if (body.testOnly === true) {
          res.status(400).json({
            error: "contradictory_request",
            message: "testOnly:true is only meaningful with agent mock-test-only",
          });
          return;
        }
        if (typeof mod.evaluateBenchTask !== "function") {
          res.status(503).json({ error: "benchmark-unavailable" });
          return;
        }
        modelIdentity = await fetchModelInfo();
        const vmImageDigest = typeof process.env["EVEX_BASE_IMAGE_SHA256"] === "string" && process.env["EVEX_BASE_IMAGE_SHA256"]
          ? String(process.env["EVEX_BASE_IMAGE_SHA256"])
          : null;
        agentFn = async (task: unknown): Promise<Record<string, unknown>> =>
          runRealBenchTask(owner, mod, task as Parameters<typeof runRealBenchTask>[2], modelIdentity);
      }
      const record = await mod.runBench(selected, agentFn, {
        splits, runId: id, testOnly, agentIdentity,
        modelIdentity: modelIdentity
          ? {
            model_id: modelIdentity.model_id,
            ...(modelIdentity.model_version !== undefined ? { model_version: modelIdentity.model_version } : {}),
            model_sha256: modelIdentity.model_sha256 ?? null,
            degraded: modelIdentity.degraded,
          }
          : null,
        environmentIdentity: `backend:${process.env["VM_BACKEND"] ?? "auto"} node:${process.version}`,
        vmImageDigest: typeof process.env["EVEX_BASE_IMAGE_SHA256"] === "string" && process.env["EVEX_BASE_IMAGE_SHA256"]
          ? String(process.env["EVEX_BASE_IMAGE_SHA256"])
          : null,
        sourceCommit: String(RELEASE.commit ?? ""),
        sourceTree: String(RELEASE.tree ?? ""),
      });
      const full: Record<string, unknown> = { id, name: body.name, seed: body.seed, owner, ...record };
      benchmarks.set(id, full);
      bump("benchmark_runs");
      try {
        stor?.store.put("benchmarks", { id, name: body.name, status: "DONE", at: nowIso(), taskCount: selected.length, owner });
      } catch { /* ignore */ }
      res.status(201).json(full);
    } catch (err) {
      bump("benchmark_failures");
      log("error", "benchmark run failed", { requestId, msg: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "internal", requestId });
    }
  });
  v1.get("/benchmarks/:id", requireCap("trace:read"), (req: Request, res: Response) => {
    const b = benchmarks.get(req.params["id"] as string);
    if (!b) { res.status(404).json({ error: "not_found" }); return; }
    if (b["owner"] !== undefined && typeof b["owner"] === "string" && (b["owner"] as string) !== ownerOf(req)) {
      res.status(403).json({ error: "forbidden", message: "cross-tenant access denied" });
      return;
    }
    res.json(b);
  });
  v1.get("/models/status", requireCap("computer:observe"), async (_req: Request, res: Response) => {
    // Live probe: reachable reflects an actual /ready round-trip, and the
    // model identity is read from the plane — never asserted by config.
    const url = inferenceUrl();
    let reachable = false;
    let ready: Record<string, unknown> | null = null;
    let model: InferenceModelInfo | null = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const r = await fetch(`${url}/ready`, { signal: ctrl.signal });
        reachable = r.ok;
        ready = (await r.json().catch(() => null)) as Record<string, unknown> | null;
      } finally {
        clearTimeout(timer);
      }
    } catch { /* unreachable: reported, not thrown */ }
    if (reachable) model = await fetchModelInfo();
    res.json({
      inferenceUrl: url,
      model: model?.model_id ?? process.env["EVEX_MODEL"] ?? "evex-cua-1",
      reachable,
      ready: ready?.["ready"] ?? false,
      degraded: ready?.["degraded"] ?? model?.degraded ?? true,
      modelIdentity: model,
      at: nowIso(),
    });
  });

  app.use("/v1", v1);
  // Best-effort restart recovery when the store is already loaded.
  hydrateFromDisk();
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const msg = err instanceof Error ? err.message : String(err);
    const requestId = (req as ReqCtx).id ?? "unknown";
    log("error", "unhandled", { requestId, msg });
    // Never leak raw error detail to the client.
    res.status(500).json({ error: "internal", requestId });
  });
  return app;
}

export async function startApi(port?: number): Promise<Server> {
  await loadOptionals();
  // Release/commit gate first: refuse to serve a build that does not match
  // the expected release revision (§21). Then the production gate.
  try {
    assertReleaseCommit();
  } catch (err) {
    log("error", "release-commit mismatch refuses startup", { msg: err instanceof Error ? err.message : String(err) });
    throw err;
  }
  prodGate = await enforceRequiredServices();
  if (prodGate.required.length > 0) {
    log("info", "production persistence gate passed", { required: prodGate.required });
  } else {
    log("info", "persistence: file-primary (EVEX_REQUIRE_SERVICES unset)");
  }
  // Production boot gate (fail closed): EVEX_MODE=production refuses to
  // serve unless the full production posture evaluates production-safe
  // (strong token, services reachable, quotas, safe backend, TLS sense).
  // No silent dev fallback, no known default credentials, ever.
  if (executionMode() === "production") {
    if (!sec) {
      throw new Error("production startup refused: security package unavailable (no fail-open dev auth)");
    }
    const statuses = await probeServices();
    const required = (process.env["EVEX_REQUIRE_SERVICES"] ?? "")
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
      .map((s) => (s === "minio" || s === "s3" || s === "garage" ? "object" : s));
    const maxSessions = process.env["EVEX_MAX_SESSIONS"] !== undefined ? Number(process.env["EVEX_MAX_SESSIONS"]) : undefined;
    const verdict = sec.evaluateProduction({
      authToken: process.env["EVEX_AUTH_TOKEN"] ?? "",
      corsOrigins: process.env["EVEX_CORS_ORIGINS"] ?? "",
      requireServices: required,
      serviceStatus: statuses,
      maxSessions: Number.isFinite(maxSessions) ? maxSessions : undefined,
      vmBackend: process.env["VM_BACKEND"] ?? "auto",
      publicUrl: process.env["EVEX_PUBLIC_URL"] ?? "",
      objectEndpoint: process.env["OBJECT_ENDPOINT"] ?? "",
    });
    for (const f of verdict.findings) {
      log(f.status === "fail" ? "error" : "info", `production gate: ${f.name}=${f.status}`, { detail: f.detail });
    }
    if (verdict.verdict !== "production-safe") {
      throw new Error("production startup refused: configuration is development-only (see production gate findings above)");
    }
    log("info", "production gate passed: production-safe posture");
  }
  const app = buildApp();
  const srv = createServer(app);
  srv.headersTimeout = 60_000;
  srv.requestTimeout = 120_000;
  srv.keepAliveTimeout = 30_000;
  // Single upgrade router (noServer): an earlier design attached both a
  // path-filtered WebSocketServer AND a manual upgrade listener, which raced
  // and destroyed /v1/stream/:sessionId upgrades with a 400.
  const wss = new WebSocketServer({ noServer: true });
  srv.on("upgrade", (req, socket, head) => {
    const url = String(req.url ?? "");
    if (url === "/v1/stream" || url.startsWith("/v1/stream?")) {
      const ctx = upgradeAuth(req as unknown as { headers: Record<string, string | string[] | undefined>; url?: string });
      if (!ctx) {
        try { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); } catch { /* ignore */ }
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ kind: "hello", at: nowIso(), hint: "connect to /v1/stream/:sessionId" }));
      });
      return;
    }
    const m = url.match(/^\/v1\/stream\/([\w-]+)(\?.*)?$/);
    if (!m) {
      try { socket.destroy(); } catch { /* ignore */ }
      return;
    }
    // Session streams require the same auth as HTTP + ownership of the
    // session. Unknown sessions fail closed before the upgrade completes.
    const ctx = upgradeAuth(req as unknown as { headers: Record<string, string | string[] | undefined>; url?: string });
    if (!ctx) {
      try { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); } catch { /* ignore */ }
      return;
    }
    const sessionId = m[1] as string;
    const s = sessions.get(sessionId);
    if (!s) {
      try { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); } catch { /* ignore */ }
      return;
    }
    if (s.owner && s.owner !== `${ctx.tenant}:${ctx.user}` && ctx.role !== "admin" && !(ctx.capabilities.includes("*"))) {
      try { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); } catch { /* ignore */ }
      return;
    }
    // Resource bound: per-session and global WS caps fail predictably (429)
    // instead of accumulating unbounded sockets (flood discipline).
    const maxPerSession = Number(process.env["EVEX_MAX_WS_PER_SESSION"] ?? 32);
    const maxTotal = Number(process.env["EVEX_MAX_WS_CONNECTIONS"] ?? 1024);
    let totalWs = 0;
    for (const set of streams.values()) totalWs += set.size;
    const sessionWs = streams.get(sessionId)?.size ?? 0;
    if (sessionWs >= maxPerSession || totalWs >= maxTotal) {
      try { socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 5\r\n\r\n"); socket.destroy(); } catch { /* ignore */ }
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let set = streams.get(sessionId);
      if (!set) { set = new Set(); streams.set(sessionId, set); }
      set.add(ws);
      ws.send(JSON.stringify({ kind: "hello", sessionId, at: nowIso() }));
      const cur0 = sessions.get(sessionId);
      if (cur0) ws.send(JSON.stringify(syntheticFrame(sessionId, cur0.seq)));
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
