import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ── EVE-X session worker: control-plane orchestrator ──
// No static imports of api/security/storage: everything runs against DATA_DIR
// files + authenticated control-plane HTTP, so tsc never breaks on sibling
// refactors.
//
// Production execution model (verification over agent self-report):
//  1. acquire session lease (W1 atomic O_EXCL + epoch fencing)
//  2. prove ownership/fencing before every step
//  3. obtain a fresh REAL percept via GET /v1/computer/:id/observe
//  4. invoke the model policy via POST /v1/computer/:id/suggest
//  5. actuate via POST /v1/computer/:id/act (server enforces ActionIR,
//     safety policy, point→region grounding, stale-frame rejection,
//     post-action re-observation, and appends the evidence-bearing step)
//  6. enforce stop conditions; release lease
//
// The worker NEVER synthesizes perception, grounding, verification, or
// success. There is no synthetic backend in this module — not behind a flag,
// not behind an env var. If the control plane reports synthetic:true, the
// run refuses (SYNTHETIC_BACKEND_REFUSED) instead of acting on fake pixels.
// If a real percept cannot be obtained, the step FAILS; after a bounded run
// of consecutive infrastructure failures the session is marked FAILED with
// an explicit reason. Trace steps are written ONLY by the control plane,
// which owns the VM drivers and the SHA-256 evidence chain.
//
// Safety invariants:
// - W1: lease acquire is an atomic O_EXCL ("wx") create; heartbeat never
//   clobbers a lease owned by another worker.
// - W2: human takeover / pause (data/control/<session>.json) is honored
//   before every ACT step.
// - W3: the worker NEVER declares goal success. Loops end on maxSteps
//   (BUDGET_EXHAUSTED), an external completion marker (ROLLOUT_COMPLETE),
//   or an explicit infrastructure failure (FAILED + reason). Success
//   verdicts belong to tasks/validate + Genesis (control-plane side).
// - W7: single-writer-per-session via lease; ownership re-asserted often.

function dataDir(): string {
  return process.env["DATA_DIR"] ?? "./data";
}
function objectDir(): string {
  return process.env["OBJECT_DIR"] ?? join(dataDir(), "objects");
}
function nowIso(): string {
  return new Date().toISOString();
}
function uid(p: string): string {
  return `${p}-${randomUUID().slice(0, 8)}`;
}
function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Lease { worker: string; at: string; ttlMs: number; epoch?: number }
export interface SessionDoc {
  id: string; goal: string; status: string; vmId?: string;
  seed?: number; maxSteps?: number; updatedAt?: string;
}
interface ControlDoc { humanControl?: boolean; paused?: boolean; complete?: boolean }

export const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`;
const HEARTBEAT_MS = 5000;
const LEASE_TTL_MS = 20000;
const CRASH_LIMIT = 3;

// Currently-held session for sync lease release on shutdown (W6).
let heldSessionId: string | null = null;

function ensureDirs(): void {
  mkdirSync(dataDir(), { recursive: true });
  mkdirSync(join(dataDir(), "sessions"), { recursive: true });
  mkdirSync(join(dataDir(), "leases"), { recursive: true });
  mkdirSync(join(dataDir(), "control"), { recursive: true });
  mkdirSync(join(dataDir(), "crashes"), { recursive: true });
  mkdirSync(join(objectDir(), "traces"), { recursive: true });
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function listSessions(): SessionDoc[] {
  const dir = join(dataDir(), "sessions");
  if (!existsSync(dir)) return [];
  const out: SessionDoc[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const d = readJson(join(dir, f)) as SessionDoc | null;
    if (d && d.id) out.push(d);
  }
  return out;
}

function sanitize(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Trace path for a session. The worker READS nothing here and WRITES
 *  nothing here — the control plane owns trace files. Exported so tests
 *  and operators can assert the worker left the evidence store untouched. */
export function tracePath(sessionId: string): string {
  return join(objectDir(), "traces", `${sanitize(sessionId)}.jsonl`);
}

export function leasePath(sessionId: string): string {
  return join(dataDir(), "leases", `${sanitize(sessionId)}.json`);
}

export function controlPath(sessionId: string): string {
  return join(dataDir(), "control", `${sanitize(sessionId)}.json`);
}

export function crashPath(sessionId: string): string {
  return join(dataDir(), "crashes", `${sanitize(sessionId)}.json`);
}

function isLive(l: Lease | null): boolean {
  if (!l || !l.worker) return false;
  const at = Date.parse(l.at);
  if (!Number.isFinite(at)) return false;
  const ttl = Number(l.ttlMs);
  if (!Number.isFinite(ttl) || ttl <= 0) return false;
  return Date.now() - at < ttl;
}

function freshLeasePayload(epoch = 0): string {
  return JSON.stringify({ worker: WORKER_ID, at: nowIso(), ttlMs: LEASE_TTL_MS, epoch });
}

// W1: atomic acquire via O_EXCL create. No check-then-act: the create itself
// is the claim. On EEXIST, a live foreign lease is left untouched; a stale /
// released / corrupt / vanished entry is unlinked and claimed with ONE retry.
// Takeover bumps the epoch: the previous holder observes the epoch change on
// its next ownership check and aborts (clock-independent fencing — safe even
// when worker clocks disagree about TTL expiry).
export function tryAcquire(sessionId: string): boolean {
  ensureDirs();
  const p = leasePath(sessionId);
  try {
    writeFileSync(p, freshLeasePayload(0), { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return false;
  }
  const cur = readJson(p) as Lease | null;
  if (cur && cur.worker === WORKER_ID) {
    try {
      const epoch = Number.isFinite(Number(cur.epoch)) ? Number(cur.epoch) : 0;
      writeFileSync(p, freshLeasePayload(epoch), "utf8");
    } catch { /* ignore refresh failure; we already hold it */ }
    return true;
  }
  if (cur && cur.worker !== WORKER_ID && isLive(cur)) return false;
  const nextEpoch = Number.isFinite(Number(cur?.epoch)) ? Number(cur?.epoch) + 1 : 1;
  try {
    unlinkSync(p);
  } catch { /* ignore: proceed to the single retry either way */ }
  try {
    writeFileSync(p, freshLeasePayload(nextEpoch), { encoding: "utf8", flag: "wx" });
    return true;
  } catch {
    return false; // second EEXIST (or other error) → give up
  }
}

// Current epoch held by this worker, or null when not the holder.
export function heldEpoch(sessionId: string): number | null {
  const cur = readJson(leasePath(sessionId)) as Lease | null;
  if (!cur || cur.worker !== WORKER_ID) return null;
  return Number.isFinite(Number(cur.epoch)) ? Number(cur.epoch) : 0;
}

// W1: read-first heartbeat — only refreshes our own lease, never another
// worker's. Missing/released entries are re-created atomically (best-effort).
export function heartbeat(sessionId: string): void {
  ensureDirs();
  const p = leasePath(sessionId);
  try {
    const cur = readJson(p) as Lease | null;
    if (cur && cur.worker === WORKER_ID) {
      const epoch = Number.isFinite(Number(cur.epoch)) ? Number(cur.epoch) : 0;
      writeFileSync(p, freshLeasePayload(epoch), "utf8");
      return;
    }
    if (cur && cur.worker && cur.worker !== WORKER_ID) return; // foreign: never clobber
    if (cur && cur.worker === "") {
      try {
        writeFileSync(p, freshLeasePayload(), { encoding: "utf8", flag: "wx" });
      } catch { /* lost a race: leave the winner alone */ }
      return;
    }
    if (!cur) {
      try {
        writeFileSync(p, freshLeasePayload(), { encoding: "utf8", flag: "wx" });
      } catch { /* lost a race: leave the winner alone */ }
    }
    // Stale foreign lease: leave it for tryAcquire/recoverStale to resolve.
  } catch { /* ignore */ }
}

export function releaseLease(sessionId: string): void {
  try {
    const cur = readJson(leasePath(sessionId)) as Lease | null;
    if (cur && cur.worker === WORKER_ID) {
      writeFileSync(leasePath(sessionId), JSON.stringify({ worker: "", at: nowIso(), ttlMs: 0 }), "utf8");
    }
  } catch { /* ignore */ }
}

// W7: single-writer-per-session via lease is the invariant — re-read the lease
// before each control-plane call and abort if it is live-held by another worker.
// Absent/released/stale leases are writable (direct calls, tests, recovery).
function leaseUsable(sessionId: string): boolean {
  const cur = readJson(leasePath(sessionId)) as Lease | null;
  if (!isLive(cur)) return true;
  return cur?.worker === WORKER_ID;
}

function readControl(sessionId: string): ControlDoc {
  const d = readJson(controlPath(sessionId));
  if (!d) return {};
  return {
    humanControl: d["humanControl"] === true,
    paused: d["paused"] === true,
    complete: d["complete"] === true,
  };
}

// W5: crash counting. Incremented on every worker catch; at CRASH_LIMIT the
// session doc is marked FAILED (reason crash-loop) so no worker retries it
// further (tick only picks up RUNNING/QUEUED/READY).
export function recordCrash(sessionId: string): { count: number; failed: boolean } {
  ensureDirs();
  const p = crashPath(sessionId);
  const cur = readJson(p) as { count?: unknown } | null;
  const prev = typeof cur?.count === "number" && Number.isFinite(cur.count)
    ? Math.max(0, Math.floor(cur.count))
    : 0;
  const count = prev + 1;
  try {
    writeFileSync(p, JSON.stringify({ count, lastAt: nowIso() }), "utf8");
  } catch { /* ignore persistence failure; still report the count */ }
  if (count >= CRASH_LIMIT) {
    const docPath = join(dataDir(), "sessions", `${sessionId}.json`);
    const doc = ((readJson(docPath) ?? {}) as Record<string, unknown>);
    if (doc["id"] == null) doc["id"] = sessionId;
    doc["status"] = "FAILED";
    doc["reason"] = "crash-loop";
    doc["updatedAt"] = nowIso();
    try {
      writeFileSync(docPath, JSON.stringify(doc, null, 2), "utf8");
    } catch { /* ignore */ }
    return { count, failed: true };
  }
  return { count, failed: false };
}

export function resetCrashes(sessionId: string): void {
  try {
    if (existsSync(crashPath(sessionId))) unlinkSync(crashPath(sessionId));
  } catch { /* ignore */ }
}

function quotaCheck(): { ok: boolean; reason: string } {
  const maxSessions = Number(process.env["EVEX_QUOTA_SESSIONS"] ?? process.env["EVEX_MAX_SESSIONS"] ?? 8);
  const active = new Set<string>();
  const dir = join(dataDir(), "leases");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const l = readJson(join(dir, f)) as Lease | null;
      if (l && l.worker && Date.now() - Date.parse(l.at) < l.ttlMs) active.add(f);
    }
  }
  if (active.size >= maxSessions) return { ok: false, reason: `session quota reached (${active.size}/${maxSessions})` };
  return { ok: true, reason: "quota ok" };
}

// ── control-plane backend ─────────────────────────────────────────────────
// The ONLY execution backend the production worker can use: authenticated
// HTTP against the EVE-X control plane, which owns the VM drivers, the
// ComputerRuntime, the inference plane, and the evidence chain. Every
// response is screened for synthetic:true — a control plane that answers
// with synthetic evidence is refused, never acted on.

export class WorkerStepError extends Error {
  readonly code: string;
  constructor(code: string, msg: string) {
    super(msg);
    this.code = code;
  }
}

export interface ObservedFrame {
  frameId: string;
  width: number;
  height: number;
  regions: Array<{ regionId: string; bbox: [number, number, number, number]; label: string; confidence?: number }>;
  synthetic: boolean;
  backend?: string;
}

export interface ModelSuggestion {
  action: Record<string, unknown>;
  frameId: string;
  modelId: string;
  degraded: boolean;
  latencyMs?: number;
}

export interface ActuationReceipt {
  seq: number;
  frameId: string;
  terminated: boolean;
  grounding?: Record<string, unknown>;
  synthetic: boolean;
}

export interface ControlPlaneDeps {
  readonly kind: "control-plane";
  observe(sessionId: string): Promise<ObservedFrame>;
  suggest(sessionId: string, frame: ObservedFrame, goal: string): Promise<ModelSuggestion>;
  act(sessionId: string, action: Record<string, unknown>, frameId: string, idempotencyKey: string): Promise<ActuationReceipt>;
}

function apiBase(explicit?: string): string {
  return (explicit ?? process.env["EVEX_API_URL"] ?? "http://localhost:8080").replace(/\/$/, "");
}

function apiToken(explicit?: string): string {
  return (explicit ?? process.env["EVEX_AUTH_TOKEN"] ?? "").trim();
}

async function readJsonResponse(res: Response, what: string): Promise<Record<string, unknown>> {
  let j: unknown = null;
  try {
    j = (await res.json()) as unknown;
  } catch {
    throw new WorkerStepError("TRANSPORT_ERROR", `${what}: control plane returned unreadable body (HTTP ${res.status})`);
  }
  if (!j || typeof j !== "object") throw new WorkerStepError("TRANSPORT_ERROR", `${what}: control plane returned no object (HTTP ${res.status})`);
  return j as Record<string, unknown>;
}

function refuseSynthetic(what: string, body: Record<string, unknown>): void {
  if (body["synthetic"] === true) {
    throw new WorkerStepError(
      "SYNTHETIC_BACKEND_REFUSED",
      `${what}: control plane answered synthetic:true — refusing to act on manufactured evidence`,
    );
  }
}

/** Production backend constructor. Takes no mode flags: there is no
 *  synthetic mode to select. Test doubles are built inline in test files
 *  and can only reach the injectable driveSession(), never this path. */
export function controlPlaneDeps(apiUrl?: string, token?: string): ControlPlaneDeps {
  const base = apiBase(apiUrl);
  const tok = apiToken(token);
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(tok ? { authorization: `Bearer ${tok}` } : {}),
  });
  const enc = (s: string): string => encodeURIComponent(s);
  return {
    kind: "control-plane",
    async observe(sessionId: string): Promise<ObservedFrame> {
      let res: Response;
      try {
        res = await fetch(`${base}/v1/computer/${enc(sessionId)}/observe`, {
          headers: headers(), signal: AbortSignal.timeout(30000),
        });
      } catch (err) {
        throw new WorkerStepError("TRANSPORT_ERROR", `observe: control plane unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.status === 503) throw new WorkerStepError("VM_LOST", "observe: control plane reports the VM unreachable");
      if (res.status === 404) throw new WorkerStepError("PERCEPT_FAILED", "observe: session unknown to the control plane");
      if (!res.ok) throw new WorkerStepError("PERCEPT_FAILED", `observe: control plane HTTP ${res.status}`);
      const j = await readJsonResponse(res, "observe");
      refuseSynthetic("observe", j);
      const frameId = String(j["frameId"] ?? "");
      if (!frameId) throw new WorkerStepError("PERCEPT_FAILED", "observe: control plane returned no frameId");
      return {
        frameId,
        width: Number(j["width"] ?? 0) || 0,
        height: Number(j["height"] ?? 0) || 0,
        regions: Array.isArray(j["regions"]) ? (j["regions"] as ObservedFrame["regions"]) : [],
        synthetic: false,
        backend: typeof j["backend"] === "string" ? (j["backend"] as string) : undefined,
      };
    },
    async suggest(sessionId: string, _frame: ObservedFrame, _goal: string): Promise<ModelSuggestion> {
      void _frame; void _goal;
      let res: Response;
      try {
        res = await fetch(`${base}/v1/computer/${enc(sessionId)}/suggest`, {
          method: "POST", headers: headers(), body: "{}",
          signal: AbortSignal.timeout(60000),
        });
      } catch (err) {
        throw new WorkerStepError("TRANSPORT_ERROR", `suggest: control plane unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.status === 503) throw new WorkerStepError("VM_LOST", "suggest: control plane reports the VM unreachable");
      if (!res.ok) throw new WorkerStepError("INFERENCE_FAILED", `suggest: inference plane unavailable (HTTP ${res.status})`);
      const j = await readJsonResponse(res, "suggest");
      refuseSynthetic("suggest", j);
      const action = j["suggestion"] as Record<string, unknown> | undefined;
      const frameId = String(j["frameId"] ?? "");
      if (!action || typeof action !== "object" || !frameId) {
        throw new WorkerStepError("INFERENCE_FAILED", "suggest: inference returned no action for the observed frame");
      }
      return {
        action, frameId,
        modelId: String(j["model_id"] ?? "unknown"),
        degraded: j["degraded"] !== false,
        latencyMs: typeof j["latency_ms"] === "number" ? (j["latency_ms"] as number) : undefined,
      };
    },
    async act(sessionId: string, action: Record<string, unknown>, frameId: string, idempotencyKey: string): Promise<ActuationReceipt> {
      const type = String(action["type"] ?? "");
      const to = action["to"] as { x?: unknown; y?: unknown } | undefined;
      const from = action["from"] as { x?: unknown; y?: unknown } | undefined;
      const pt = to ?? from;
      const body: Record<string, unknown> = {
        type: type || "observe",
        confidence: typeof action["confidence"] === "number" ? action["confidence"] : 0.5,
        frameId, idempotencyKey,
      };
      if (pt && typeof pt.x === "number" && typeof pt.y === "number") { body["x"] = pt.x; body["y"] = pt.y; }
      if (typeof action["text"] === "string") body["text"] = (action["text"] as string).slice(0, 4096);
      if (Array.isArray(action["keys"])) body["keys"] = (action["keys"] as unknown[]).slice(0, 8);
      if (typeof action["ms"] === "number") body["ms"] = action["ms"];
      let res: Response;
      try {
        res = await fetch(`${base}/v1/computer/${enc(sessionId)}/act`, {
          method: "POST", headers: headers(), body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        });
      } catch (err) {
        throw new WorkerStepError("TRANSPORT_ERROR", `act: control plane unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res.status === 409) {
        const j = await readJsonResponse(res, "act").catch(() => ({} as Record<string, unknown>));
        if (j["error"] === "human_control") throw new WorkerStepError("HUMAN_CONTROL", "act: human holds control");
        throw new WorkerStepError("STALE_PERCEPTION", `act: stale perception (current ${String(j["current"] ?? "unknown")})`);
      }
      if (res.status === 503) throw new WorkerStepError("VM_LOST", "act: control plane reports the VM unreachable");
      if (res.status === 501) throw new WorkerStepError("UNSUPPORTED_ACTION", "act: action unsupported on this backend");
      if (!res.ok) throw new WorkerStepError("ACT_FAILED", `act: control plane HTTP ${res.status}`);
      const j = await readJsonResponse(res, "act");
      refuseSynthetic("act", j);
      return {
        seq: typeof j["seq"] === "number" ? (j["seq"] as number) : -1,
        frameId: String(j["frameId"] ?? frameId),
        terminated: j["terminated"] === true,
        grounding: (j["action"] as Record<string, unknown> | undefined) as Record<string, unknown> | undefined,
        synthetic: false,
      };
    },
  };
}

// ── orchestration ─────────────────────────────────────────────────────────
// W3: the agent NEVER declares itself successful. Outcomes:
// - BUDGET_EXHAUSTED on maxSteps (success is never inferred from acting);
// - ROLLOUT_COMPLETE only on an explicit external marker
//   (data/control/<session>.json {complete:true}); session doc status DONE;
// - HUMAN_CONTROL / PAUSED on takeover markers (no act calls issued,
//   lease released);
// - LEASE_LOST when the lease is live-held by another worker (abort without
//   touching the session doc or the trace store);
// - FAILED + explicit reason when the VM is lost, the backend answers
//   synthetic, or perception/inference/actuation fails consecutively
//   beyond budget (fail loudly, never synthesize a step to fill the gap).
// W8: seed/maxSteps/taskId/vmId are read tolerantly and the session doc is
// updated by merge, never clobbering unknown fields. The worker writes
// orchestration state ONLY — trace steps belong to the control plane.

export type WorkerOutcome =
  | "BUDGET_EXHAUSTED" | "ROLLOUT_COMPLETE" | "HUMAN_CONTROL" | "PAUSED"
  | "LEASE_LOST" | "VM_LOST" | "SYNTHETIC_REFUSED" | "PERCEPT_FAILED"
  | "INFERENCE_FAILED" | "ACT_FAILED" | "UNSUPPORTED_ACTION" | "TERMINATED";

function maxConsecutiveFailures(): number {
  const n = Number(process.env["EVEX_WORKER_MAX_CONSECUTIVE_FAILURES"] ?? 5);
  return Number.isFinite(n) && n >= 1 ? Math.min(50, Math.floor(n)) : 5;
}

function maxStaleRetries(): number {
  const n = Number(process.env["EVEX_WORKER_MAX_STALE"] ?? 25);
  return Number.isFinite(n) && n >= 1 ? Math.min(500, Math.floor(n)) : 25;
}

const TERMINAL_DOC_STATUS = new Set(["STOPPED", "DONE", "FAILED"]);

export async function driveSession(sess: SessionDoc, deps: ControlPlaneDeps): Promise<{ steps: number; outcome: WorkerOutcome }> {
  ensureDirs();
  if (!deps || deps.kind !== "control-plane") {
    throw new WorkerStepError(
      "SYNTHETIC_BACKEND_REJECTED",
      "production orchestration requires the control-plane backend — test doubles are not routable here",
    );
  }
  const raw = sess as unknown as Record<string, unknown>;
  const maxRaw = Number(raw["maxSteps"] ?? 60);
  const maxEnv = Number(process.env["EVEX_MAX_STEPS"] ?? 200);
  const maxSteps = Math.min(
    Number.isFinite(maxRaw) ? Math.max(0, Math.floor(maxRaw)) : 60,
    Number.isFinite(maxEnv) ? Math.max(0, Math.floor(maxEnv)) : 200,
  );
  const failBudget = maxConsecutiveFailures();
  const staleBudget = maxStaleRetries();
  let acted = 0;
  let consecFail = 0;
  let staleRetries = 0;
  let lastModel: Record<string, unknown> | null = null;
  let lastFrame: string | null = null;
  // Epoch fencing: another worker may take over a lease it considers stale
  // (especially under clock skew). Any epoch change aborts this run even if
  // our own clock still considers the lease live.
  const myEpoch = heldEpoch(sess.id);
  const epochOk = (): boolean => {
    if (myEpoch === null) return leaseUsable(sess.id);
    const cur = heldEpoch(sess.id);
    return cur !== null && cur === myEpoch && leaseUsable(sess.id);
  };
  const goal = String(sess.goal ?? "complete the task");

  const finish = (outcome: WorkerOutcome): { steps: number; outcome: WorkerOutcome } => {
    if (outcome === "ROLLOUT_COMPLETE") resetCrashes(sess.id);
    releaseLease(sess.id);
    // W8: merge — unknown control-plane fields survive the write-back. A
    // terminal status already set by the server (STOPPED/DONE/FAILED) is
    // never overwritten by the worker's orchestration outcome.
    const docPath = join(dataDir(), "sessions", `${sess.id}.json`);
    const cur = (readJson(docPath) ?? {}) as Record<string, unknown>;
    const failedReason: Record<string, string> = {
      VM_LOST: "vm-lost", SYNTHETIC_REFUSED: "synthetic-backend-refused",
      PERCEPT_FAILED: "percept-unavailable", INFERENCE_FAILED: "inference-unavailable",
      ACT_FAILED: "actuation-failed", UNSUPPORTED_ACTION: "unsupported-action",
    };
    let status: string;
    let reason: string | undefined;
    if (outcome === "ROLLOUT_COMPLETE") status = "DONE";
    else if (outcome === "TERMINATED") status = TERMINAL_DOC_STATUS.has(String(cur["status"] ?? "")) ? String(cur["status"]) : "STOPPED";
    else if (failedReason[outcome] !== undefined) { status = "FAILED"; reason = failedReason[outcome] as string; }
    else status = outcome;
    const next: Record<string, unknown> = {
      ...cur, id: sess.id, status, updatedAt: nowIso(),
      workerSteps: acted, workerOutcome: outcome, workerId: WORKER_ID,
    };
    if (reason !== undefined) next["reason"] = reason;
    if (lastFrame !== null) next["lastFrame"] = lastFrame;
    if (lastModel !== null) next["workerModel"] = lastModel;
    try {
      writeFileSync(docPath, JSON.stringify(next, null, 2), "utf8");
    } catch { /* ignore write-back failure; the run outcome is still returned */ }
    return { steps: acted, outcome };
  };

  const noteFailure = (outcome: WorkerOutcome): { steps: number; outcome: WorkerOutcome } | null => {
    consecFail += 1;
    if (consecFail >= failBudget) return finish(outcome);
    return null;
  };

  while (true) {
    // W2: checked at the top of every loop iteration, before any ACT call.
    // Epoch fencing rides along: a takeover (or a clock-skew split-brain
    // rival) bumps the epoch, and this run aborts even when its own clock
    // still calls the lease live.
    if (!epochOk()) return { steps: acted, outcome: "LEASE_LOST" };
    const ctl = readControl(sess.id);
    if (ctl.humanControl) return finish("HUMAN_CONTROL");
    if (ctl.paused) return finish("PAUSED");
    if (ctl.complete) return finish("ROLLOUT_COMPLETE");
    if (acted >= maxSteps) return finish("BUDGET_EXHAUSTED");

    let frame: ObservedFrame;
    try {
      frame = await deps.observe(sess.id);
    } catch (err) {
      const code = err instanceof WorkerStepError ? err.code : "TRANSPORT_ERROR";
      if (code === "SYNTHETIC_BACKEND_REFUSED") return finish("SYNTHETIC_REFUSED");
      if (code === "VM_LOST") return finish("VM_LOST");
      const done = noteFailure("PERCEPT_FAILED");
      if (done) return done;
      await sleepMs(1000);
      continue;
    }
    // Defense in depth: the kind gate proves which backend family answered,
    // but only this check proves WHAT it answered. A percept flagged
    // synthetic is refused even when it arrives through the control-plane
    // interface (misconfiguration, compromised plane, bad stub).
    if (frame.synthetic === true) return finish("SYNTHETIC_REFUSED");

    let sugg: ModelSuggestion;
    try {
      sugg = await deps.suggest(sess.id, frame, goal);
    } catch (err) {
      const code = err instanceof WorkerStepError ? err.code : "TRANSPORT_ERROR";
      if (code === "SYNTHETIC_BACKEND_REFUSED") return finish("SYNTHETIC_REFUSED");
      if (code === "VM_LOST") return finish("VM_LOST");
      const done = noteFailure("INFERENCE_FAILED");
      if (done) return done;
      await sleepMs(1000);
      continue;
    }
    // Honest model provenance for this run: what the inference plane
    // CLAIMED, recorded verbatim — including degraded:true. Never upgraded.
    lastModel = {
      model_id: sugg.modelId, degraded: sugg.degraded,
      frameId: sugg.frameId,
      ...(sugg.latencyMs !== undefined ? { latency_ms: sugg.latencyMs } : {}),
      at: nowIso(),
    };

    if (!epochOk()) return { steps: acted, outcome: "LEASE_LOST" };
    let receipt: ActuationReceipt;
    try {
      receipt = await deps.act(sess.id, sugg.action, sugg.frameId, `${sess.id}:${sugg.frameId}:${acted}:${uid("k")}`);
    } catch (err) {
      const code = err instanceof WorkerStepError ? err.code : "TRANSPORT_ERROR";
      if (code === "SYNTHETIC_BACKEND_REFUSED") return finish("SYNTHETIC_REFUSED");
      if (code === "HUMAN_CONTROL") return finish("HUMAN_CONTROL");
      if (code === "VM_LOST") return finish("VM_LOST");
      if (code === "UNSUPPORTED_ACTION") return finish("UNSUPPORTED_ACTION");
      if (code === "STALE_PERCEPTION") {
        staleRetries += 1;
        if (staleRetries > staleBudget) return finish("ACT_FAILED");
        continue; // re-observe against the new current frame; not a failure
      }
      const done = noteFailure("ACT_FAILED");
      if (done) return done;
      await sleepMs(1000);
      continue;
    }
    consecFail = 0;
    acted += 1;
    if (receipt.synthetic === true) return finish("SYNTHETIC_REFUSED");
    lastFrame = receipt.frameId;
    if (receipt.terminated) return finish("TERMINATED");
  }
}

/** Production entry: orchestrate one session to completion against the live
 *  control plane. No backend parameter exists — synthesis is not selectable. */
export function runSessionToCompletion(sess: SessionDoc): Promise<{ steps: number; outcome: WorkerOutcome }> {
  return driveSession(sess, controlPlaneDeps());
}

async function tick(): Promise<void> {
  ensureDirs();
  const quota = quotaCheck();
  if (!quota.ok) {
    process.stdout.write(`[worker ${WORKER_ID}] quota: ${quota.reason}\n`);
    return;
  }
  const sessions = listSessions().filter((s) => ["RUNNING", "QUEUED", "READY"].includes(String(s.status)));
  if (sessions.length === 0) return;
  for (const s of sessions) {
    if (!tryAcquire(s.id)) continue; // held by another worker
    heldSessionId = s.id;
    process.stdout.write(`[worker ${WORKER_ID}] claimed ${s.id}\n`);
    const hb = setInterval(() => heartbeat(s.id), HEARTBEAT_MS);
    try {
      const { steps, outcome } = await runSessionToCompletion(s);
      process.stdout.write(`[worker ${WORKER_ID}] ${s.id}: ${steps} steps → ${outcome}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[worker ${WORKER_ID}] ${s.id} crashed: ${msg}\n`);
      // W5: count crashes; at the limit the session is FAILED (no further
      // retries) instead of lingering RUNNING forever.
      try {
        const rc = recordCrash(s.id);
        if (rc.failed) {
          process.stderr.write(`[worker ${WORKER_ID}] ${s.id} crash-loop (${rc.count}); marked FAILED\n`);
        }
      } catch { /* ignore */ }
    } finally {
      clearInterval(hb);
      releaseLease(s.id);
      if (heldSessionId === s.id) heldSessionId = null;
    }
  }
}

function recoverStale(): void {
  ensureDirs();
  const dir = join(dataDir(), "leases");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const l = readJson(join(dir, f)) as (Lease & { worker: string }) | null;
    if (!l) continue;
    if (l.worker && Date.now() - Date.parse(l.at) > l.ttlMs) {
      process.stdout.write(`[worker ${WORKER_ID}] recovering stale lease ${f} (was ${l.worker})\n`);
      try {
        writeFileSync(join(dir, f), JSON.stringify({ worker: "", at: nowIso(), ttlMs: 0 }), "utf8");
      } catch { /* ignore */ }
    }
  }
}

export async function startWorker(): Promise<void> {
  ensureDirs();
  recoverStale();
  process.stdout.write(`[worker ${WORKER_ID}] online, data=${dataDir()}\n`);
  const loop = async (): Promise<void> => {
    try {
      await tick();
    } catch (err) {
      process.stderr.write(`[worker] tick failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };
  await loop();
  const timer = setInterval(loop, 7000);
  const shut = (): void => {
    clearInterval(timer);
    // W6: release the in-flight lease synchronously before exit so the
    // session does not sit claimed until TTL expiry.
    try {
      if (heldSessionId) releaseLease(heldSessionId);
    } catch { /* ignore */ }
    heldSessionId = null;
    process.stdout.write(`[worker ${WORKER_ID}] shutdown\n`);
    process.exit(0);
  };
  process.on("SIGINT", shut);
  process.on("SIGTERM", shut);
}

const _entry = (process.argv[1] ?? "").replace(/\\/g, "/");
const isMain = _entry.endsWith("apps/worker/index.js") || _entry.endsWith("apps/worker/src/index.js");
if (isMain) {
  startWorker().catch((err) => {
    process.stderr.write(`[worker] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
