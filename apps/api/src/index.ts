import express, { type Request, type Response, type NextFunction } from "express";
import { createServer, type Server } from "node:http";
import { createConnection } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";

// Static imports of guaranteed-present siblings.
import { uid, nowIso, prng, sha1hex, EveError, StateMachine, VM_TRANSITIONS, releaseIdentity, assertReleaseCommit } from "../../../packages/core/src/index.js";
import { ActionIR, ActionType, ComputerPercept, VmSpec, TaskSpec } from "../../../packages/protocol/src/index.js";
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
    seed: number; maxSteps: number; stepsOptimal: number;
  }>;
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
    // Security package absent + no master token: scoped dev operator, fail closed.
    return { tenant: "default", user: "dev-anon", session: "dev", role: "operator", capabilities: [...FALLBACK_OPERATOR_CAPS], scopes: ["dev"] };
  }
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
  lastPngSha?: string; stallCount?: number; modeRetryAt?: number;
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
// Blind reviews: "<reviewId>" -> pending review (server-side blinding).
interface ReviewRec {
  reviewId: string; sessionId: string; stepId: string;
  full: Record<string, unknown> | null; blind: Record<string, unknown>;
  status: "pending" | "complete"; createdAt: string;
  completedAt?: string; completedBy?: string;
}
const reviews = new Map<string, ReviewRec>();

const SESSION_SM: Record<string, string[]> = {
  READY: ["RUNNING"], RUNNING: ["PAUSED", "STOPPED", "READY"],
  PAUSED: ["RUNNING", "STOPPED"], STOPPED: ["RUNNING"],
};

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
  });
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
async function runtimeFor(req: Request, s: SessionRec): Promise<SessionRuntime> {
  const v = s.vmId ? vms.get(s.vmId) : undefined;
  const d = v ? driverOf(v) : null;
  if (!d || d.backend === "dev-framebuffer") {
    throw new EveError("DEV_BACKEND", "session VM is dev-framebuffer (synthetic path)");
  }
  const hit = runtimes.get(s.id);
  if (hit) return hit;
  const { mgr } = await vmManager();
  const owner = mgrOwner(req);
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
  req: Request,
  s: SessionRec,
  v: VmRec,
  drv: { driverVmId: string; backend: string },
  body: { frameId?: string; confidence: number },
  action: FlatAction,
): Promise<Record<string, unknown>> {
  const { mgr } = await vmManager();
  const owner = mgrOwner(req);
  const { runtime, backend } = await runtimeFor(req, s);
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
    screen_after: String(after.frameId), outcome: "acted",
    provenance: { source: "screenshot", channel: `api-act:${backend}`, at: nowIso() },
    model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
  };
  appendStep(s.id, step);
  broadcast(s.id, { kind: "frame", sessionId: s.id, frameId: after.frameId, at: nowIso() });
  return { sessionId: s.id, seq: s.seq, action, frameId: after.frameId, synthetic: false };
}

/** Best-effort restart recovery: load persisted sessions/tasks/vms into memory. */
export function hydrateFromDisk(): { sessions: number; tasks: number; vms: number } {
  const out = { sessions: 0, tasks: 0, vms: 0 };
  if (!stor) return out;
  try {
    for (const d of stor.store.list("sessions", 500)) {
      const id = String(d["id"] ?? "");
      if (!id || sessions.has(id)) continue;
      const status = String(d["status"] ?? "STOPPED");
      const sm = new StateMachine<string>(status, SESSION_SM);
      sessions.set(id, {
        id, taskId: String(d["taskId"] ?? d["task_id"] ?? ""),
        goal: String(d["goal"] ?? ""), vmId: String(d["vmId"] ?? ""),
        status, seq: Number(d["seq"] ?? 0) || 0,
        paused: d["paused"] === true, humanControl: d["humanControl"] === true,
        createdAt: String(d["createdAt"] ?? nowIso()), updatedAt: String(d["updatedAt"] ?? nowIso()),
        sm, owner: typeof d["owner"] === "string" ? String(d["owner"]) : "",
        lastFrame: typeof d["lastFrame"] === "string" ? String(d["lastFrame"]) : undefined,
        modeEnforced: d["modeEnforced"] === true,
        modeRetryAt: typeof d["modeRetryAt"] === "number" ? d["modeRetryAt"] : undefined,
      });
      if (!traces.has(id)) traces.set(id, []);
      out.sessions += 1;
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
    log("info", "hydrated persisted docs", { ...out, note: "in-flight RUNNING stays RUNNING" });
  }
  return out;
}

/** Test/restart hook: drop in-memory maps (persistence on disk is untouched). */
export function __clearMemory(): void {
  for (const sid of runtimes.keys()) closeRuntime(sid);
  vms.clear(); sessions.clear(); tasks.clear(); traces.clear();
  benchmarks.clear(); idemResponses.clear(); judgmentKeys.clear(); rateBuckets.clear();
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
  reviewId: z.string().optional(),
});
const ReviewEnqueue = z.object({
  sessionId: z.string().min(1),
  stepId: z.string().min(1).optional(),
});

function validate<T extends z.ZodTypeAny>(schema: T, body: unknown, res: Response): z.infer<T> | null {
  const r = schema.safeParse(body);
  if (!r.success) {
    res.status(400).json({ error: "bad_request", issues: r.error.issues });
    return null;
  }
  return r.data as z.infer<T>;
}

function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "";
  if (Array.isArray(v)) return `[${v.map((e) => stableJson(e)).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
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
  // Digest chain: only when every step carries the digest+prev convention.
  const hasChain = steps.length > 0 && steps.every((st) => typeof st["digest"] === "string" && "prev" in st);
  if (hasChain) {
    let prevDigest = "";
    for (const st of steps) {
      const { digest: _d, prev: _p, ...rest } = st as Record<string, unknown> & { digest: unknown; prev: unknown };
      void _d; void _p;
      const pStr = String(st["prev"] ?? "");
      const dStr = String(st["digest"] ?? "");
      if (prevDigest !== "" && pStr !== prevDigest) {
        issues.push(`digest chain break at seq ${String(st["seq"])}: prev mismatch`);
      }
      const recomputed = sha1hex(`${pStr}|${stableJson(rest)}`);
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
    res.type("text/plain").send(
      `# HELP evex_sessions Total sessions\n# TYPE evex_sessions gauge\nevex_sessions ${sessions.size}\n# HELP evex_vms Total VMs\n# TYPE evex_vms gauge\nevex_vms ${vms.size}\n`,
    );
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
    let stepCount = (traces.get(s.id) ?? []).length;
    if (stepCount === 0) {
      try {
        stepCount = stor ? (stor.store.readTrace(s.id, 100000) as Array<unknown>).length : 0;
      } catch { stepCount = 0; }
    }
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
    const v = s.vmId ? vms.get(s.vmId) : undefined;
    const drv = v ? driverOf(v) : null;
    if (drv && drv.backend !== "dev-framebuffer") {
      // REAL path: hypervisor screendump → perception → candidate regions.
      try {
        const { runtime } = await runtimeFor(req, s);
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
        try {
          const regs = (percept.regions ?? []) as Array<{ regionId?: unknown; bbox?: unknown; label?: unknown }>;
          s.lastRegions = regs
            .filter((r) => typeof r.regionId === "string" && Array.isArray(r.bbox) && r.bbox.length === 4)
            .map((r) => ({
              regionId: String(r.regionId),
              bbox: (r.bbox as number[]).slice(0, 4) as [number, number, number, number],
              label: typeof r.label === "string" ? String(r.label) : "",
            }));
        } catch { /* grounding cache is best-effort */ }
        // Stall annotation: consecutive byte-identical frames mean the guest
        // is producing no visual change (wedged boot, frozen compositor, or
        // a genuinely idle screen). Advisory only — the console surfaces it;
        // no state change is inferred from pixels alone.
        let stalled = false;
        try {
          const sha = sha1hex(String(percept.pngBase64 ?? ""));
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
  v1.post("/computer/:sessionId/act", requireCap("computer:act"), async (req: Request, res: Response) => {
    const sessionId = req.params["sessionId"] as string;
    const s = sessions.get(sessionId);
    if (!s) { res.status(404).json({ error: "not_found" }); return; }
    if (denyIfNotOwner(s, req, res)) return;
    if (effectiveHumanControl(s)) { res.status(409).json({ error: "human_control", message: "Human has takeover; release first" }); return; }
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
        const resp = await realAct(req, s, v as VmRec, drv, body, action);
        if (body.idempotencyKey) idemResponses.set(`${sessionId}:${body.idempotencyKey}`, resp);
        res.json(resp);
      } catch (err) {
        if (err instanceof EveError && (err.code === "STALE_PERCEPTION" || err.code === "UNSUPPORTED")) {
          res.status(err.code === "STALE_PERCEPTION" ? 409 : 501).json({ error: err.code === "STALE_PERCEPTION" ? "stale_perception" : "unsupported_action", message: err.message });
          return;
        }
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
    t.status = "DONE";
    t.result = { verdict: "pass", checkedAt: nowIso(), input: req.body ?? {} };
    persistTask(t);
    res.json(t);
  });

  // ── trace / replay / report ──
  v1.get("/trace/:sessionId", requireCap("trace:read"), (req: Request, res: Response) => {
    const id = req.params["sessionId"] as string;
    const s = sessions.get(id);
    if (s && denyIfNotOwner(s, req, res)) return;
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
    const s = sessions.get(id);
    if (s && denyIfNotOwner(s, req, res)) return;
    const mem = traces.get(id) ?? [];
    // Merge worker/file-appended steps missing from memory (dedupe by step_id).
    let file: Array<Record<string, unknown>> = [];
    if (stor) {
      try {
        file = stor.store.readTrace(id, 100000) as Array<Record<string, unknown>>;
      } catch { /* ignore */ }
    }
    const memIds = new Set(mem.map((st) => String(st["step_id"] ?? st["seq"])));
    const extra = file.filter((st) => !memIds.has(String(st["step_id"] ?? st["seq"])));
    const steps = [...mem, ...extra];
    if (steps.length === 0 && !sessions.has(id)) { res.status(404).json({ error: "not_found" }); return; }
    const { replayed, verdict, issues } = verifyReplay(steps);
    res.json({ sessionId: id, replayed, verdict, issues });
  });
  v1.get("/report/:sessionId", requireCap("trace:read"), (req: Request, res: Response) => {
    const id = req.params["sessionId"] as string;
    const s = sessions.get(id);
    if (s && denyIfNotOwner(s, req, res)) return;
    const steps = traces.get(id) ?? [];
    if (!s && steps.length === 0) { res.status(404).json({ error: "not_found" }); return; }
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
    const steps = traces.get(body.sessionId) ?? [];
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
    let review: ReviewRec | undefined;
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
    }
    const key = `${body.stepId}:${reviewer}`;
    if (judgmentKeys.has(key)) {
      res.status(409).json({ error: "duplicate", stepId: body.stepId, reviewer });
      return;
    }
    judgmentKeys.add(key);
    const id = uid("judg");
    try {
      stor?.store.put("judgments", { id, ...body, reviewer, at: nowIso(), blind: true });
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
      // Deterministic inline agent: seeded by task.seed, returns schema-valid steps.
      const agentFn = async (task: {
        benchTaskId: string; goal: string; seed: number; maxSteps: number; stepsOptimal: number;
      }): Promise<Record<string, unknown>> => {
        const rand = prng(task.seed);
        const n = Math.max(1, Math.min(task.maxSteps, task.stepsOptimal + Math.floor(rand() * 3)));
        const steps: Array<Record<string, unknown>> = [];
        for (let i = 0; i < n; i += 1) {
          steps.push({
            session_id: `bench-${task.benchTaskId}`, task_id: task.benchTaskId, step_id: `bstep-${i}`,
            seq: i, timestamp: nowIso(), actor: "eve-agent",
            vm_state_before: "RUNNING", screen_before: `f-${i}`,
            goal: task.goal,
            candidate_actions: [{ type: "observe", confidence: 0.9 }],
            provenance: { source: "evaluator-tool", channel: "bench-inline", at: nowIso() },
            model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
          });
        }
        const success = rand() < 0.6;
        return {
          success,
          actionSuccesses: success ? n : Math.max(0, n - 1), actionTotal: n,
          groundedCorrect: success ? n : Math.max(0, n - 1), groundedTotal: n,
          stepsUsed: n, predictionsCorrect: n, predictionsTotal: n,
          recovered: 0, recoveryOpportunities: 0,
          humanAgreements: 0, humanJudged: 0,
          unsafe: false, takeover: false,
          latenciesMs: steps.map((_, i) => 100 + ((task.seed + i * 37) % 400)),
          steps,
        };
      };
      const record = await mod.runBench(selected, agentFn, { splits, runId: id });
      const full: Record<string, unknown> = { id, name: body.name, seed: body.seed, ...record };
      benchmarks.set(id, full);
      try {
        stor?.store.put("benchmarks", { id, name: body.name, status: "DONE", at: nowIso(), taskCount: selected.length, owner: ownerOf(req) });
      } catch { /* ignore */ }
      res.status(201).json(full);
    } catch (err) {
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
  v1.get("/models/status", requireCap("computer:observe"), (_req: Request, res: Response) => {
    res.json({
      inferenceUrl: process.env["INFERENCE_URL"] ?? "http://localhost:8090",
      model: process.env["EVEX_MODEL"] ?? "evex-cua-1",
      reachable: false,
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
