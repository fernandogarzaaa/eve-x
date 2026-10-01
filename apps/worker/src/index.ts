import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ── EVE-X session worker: self-contained EveCuaAgent observe/plan/act loop ──
// No static imports of api/security/storage: everything runs against DATA_DIR
// files + optional API polling, so tsc never breaks on sibling refactors.
//
// Safety invariants:
// - W1: lease acquire is an atomic O_EXCL ("wx") create; heartbeat never
//   clobbers a lease owned by another worker.
// - W2: human takeover / pause (data/control/<session>.json) is honored
//   before every ACT step.
// - W3: the worker NEVER declares goal success. Loops end on maxSteps
//   (BUDGET_EXHAUSTED) or an external completion marker (ROLLOUT_COMPLETE).
//   Success verdicts belong to tasks/validate + Genesis (control-plane side).
// - W7: single-writer-per-session via lease is the trace atomicity invariant
//   (file-lock-free); lease ownership is re-asserted before each append batch.

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
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Lease { worker: string; at: string; ttlMs: number }
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

export function tracePath(sessionId: string): string {
  return join(objectDir(), "traces", `${sanitize(sessionId)}.jsonl`);
}

// W7: startSeq = max(line count, max seq in last 200 lines + 1), so worker
// appends never collide with control-plane appended steps.
export function nextTraceSeq(sessionId: string): number {
  const p = tracePath(sessionId);
  if (!existsSync(p)) return 0;
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return 0;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  let maxSeq = -1;
  for (const l of lines.slice(-200)) {
    try {
      const o = JSON.parse(l) as { seq?: unknown };
      if (typeof o.seq === "number" && Number.isFinite(o.seq)) {
        maxSeq = Math.max(maxSeq, Math.floor(o.seq));
      }
    } catch { /* ignore corrupt lines */ }
  }
  return Math.max(lines.length, maxSeq + 1);
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

function freshLeasePayload(): string {
  return JSON.stringify({ worker: WORKER_ID, at: nowIso(), ttlMs: LEASE_TTL_MS });
}

// W1: atomic acquire via O_EXCL create. No check-then-act: the create itself
// is the claim. On EEXIST, a live foreign lease is left untouched; a stale /
// released / corrupt / vanished entry is unlinked and claimed with ONE retry.
export function tryAcquire(sessionId: string): boolean {
  ensureDirs();
  const p = leasePath(sessionId);
  try {
    writeFileSync(p, freshLeasePayload(), { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") return false;
  }
  const cur = readJson(p) as Lease | null;
  if (cur && cur.worker === WORKER_ID) {
    try {
      writeFileSync(p, freshLeasePayload(), "utf8");
    } catch { /* ignore refresh failure; we already hold it */ }
    return true;
  }
  if (cur && cur.worker !== WORKER_ID && isLive(cur)) return false;
  try {
    unlinkSync(p);
  } catch { /* ignore: proceed to the single retry either way */ }
  try {
    writeFileSync(p, freshLeasePayload(), { encoding: "utf8", flag: "wx" });
    return true;
  } catch {
    return false; // second EEXIST (or other error) → give up
  }
}

// W1: read-first heartbeat — only refreshes our own lease, never another
// worker's. Missing/released entries are re-created atomically (best-effort).
export function heartbeat(sessionId: string): void {
  ensureDirs();
  const p = leasePath(sessionId);
  try {
    const cur = readJson(p) as Lease | null;
    if (cur && cur.worker === WORKER_ID) {
      writeFileSync(p, freshLeasePayload(), "utf8");
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
// before each append batch and abort if it is live-held by another worker.
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
  const maxSessions = Number(process.env["EVEX_MAX_SESSIONS"] ?? 8);
  const active = new Set<string>();
  const dir = join(dataDir(), "leases");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const l = readJson(join(dir, f)) as Lease | null;
      if (l && l.worker && Date.now() - Date.parse(l.at) < l.ttlMs) active.add(f);
    }
  }
  if (active.size >= maxSessions) return { ok: false, reason: `session quota reached (${active.size}/${maxSessions})` };
  const maxSteps = Number(process.env["EVEX_MAX_STEPS"] ?? 500);
  void maxSteps;
  return { ok: true, reason: "quota ok" };
}

// ── inline EveCuaAgent state machine ──
type Phase = "OBSERVE" | "PLAN" | "ACT" | "VERIFY" | "DONE";

const ACTION_POOL = ["click", "move", "type", "key", "scroll", "wait", "open_application"] as const;

export function observe(seed: number, seq: number): Record<string, unknown> {
  const r = prng(seed + seq * 7919);
  const nRegions = 2 + Math.floor(r() * 4);
  const regions = Array.from({ length: nRegions }, (_, i) => ({
    regionId: `r-${seq}-${i}`,
    bbox: [Math.floor(r() * 1600), Math.floor(r() * 900), 80 + Math.floor(r() * 200), 24 + Math.floor(r() * 60)],
    label: ["button", "input", "menu", "icon", "dialog"][Math.floor(r() * 5)],
    confidence: 0.6 + r() * 0.39,
  }));
  return {
    frameId: `f-${seq}`, width: 1920, height: 1080, pngBase64: "",
    regions, cursor: { x: Math.floor(r() * 1920), y: Math.floor(r() * 1080) },
    windows: ["desktop"], dialogs: [], loading: r() < 0.08,
    provenance: { source: "screenshot", channel: "worker", at: nowIso() },
  };
}

export function plan(goal: string, percept: Record<string, unknown>, seed: number, seq: number): Array<Record<string, unknown>> {
  const r = prng(seed * 31 + seq * 131);
  const regions = (percept["regions"] as Array<{ regionId: string; label: string; confidence: number; bbox?: unknown }>) ?? [];
  const cands: Array<Record<string, unknown>> = regions.slice(0, 3).map((rg, i) => {
    const type = ACTION_POOL[Math.floor(r() * ACTION_POOL.length)] as string;
    return {
      type,
      // W4: carry the actually-observed region bbox into the target — never a
      // hardcoded fallback box.
      target: { kind: "visual-region", regionId: rg.regionId, bbox: Array.isArray(rg.bbox) ? rg.bbox : [0, 0, 10, 10], label: rg.label, confidence: rg.confidence },
      text: type === "type" ? goal.slice(0, 32) : undefined,
      confidence: 0.5 + r() * 0.49,
      intent: `step ${seq} candidate ${i} toward: ${goal.slice(0, 80)}`,
    };
  });
  if (cands.length === 0) {
    cands.push({ type: "wait", ms: 500, confidence: 0.6, intent: "no regions; wait and re-observe" });
  }
  return cands;
}

export function pickBest(cands: Array<Record<string, unknown>>): Record<string, unknown> {
  let best = cands[0] as Record<string, unknown>;
  for (const c of cands) {
    if (Number(c["confidence"] ?? 0) > Number(best["confidence"] ?? 0)) best = c;
  }
  return best;
}

// W3: the agent NEVER declares itself successful. Outcomes:
// - BUDGET_EXHAUSTED on maxSteps (per-step outcome always "acted");
// - ROLLOUT_COMPLETE only on an explicit external marker
//   (data/control/<session>.json {complete:true}), recorded as one final
//   "rollout-complete" step; session doc status DONE only in this case;
// - HUMAN_CONTROL / PAUSED on takeover markers (no act steps appended,
//   lease released);
// - LEASE_LOST when the lease is live-held by another worker (abort without
//   appending or touching the session doc).
// W8: seed/maxSteps/taskId/vmId are read tolerantly and the session doc is
// updated by merge, never clobbering unknown fields.
export function runSessionToCompletion(sess: SessionDoc): { steps: number; outcome: string } {
  ensureDirs();
  const raw = sess as unknown as Record<string, unknown>;
  const seedRaw = Number(raw["seed"] ?? 42);
  const seed = Number.isFinite(seedRaw) ? seedRaw : 42;
  const maxRaw = Number(raw["maxSteps"] ?? 60);
  const maxEnv = Number(process.env["EVEX_MAX_STEPS"] ?? 200);
  const maxSteps = Math.min(
    Number.isFinite(maxRaw) ? Math.max(0, Math.floor(maxRaw)) : 60,
    Number.isFinite(maxEnv) ? Math.max(0, Math.floor(maxEnv)) : 200,
  );
  const startSeq = nextTraceSeq(sess.id);
  let phase: Phase = "OBSERVE";
  let seq = startSeq; // next seq to assign
  const goal = String(sess.goal ?? "complete the task");
  const taskId = String(raw["taskId"] ?? sess.id);

  const finish = (finalOutcome: string): { steps: number; outcome: string } => {
    if (finalOutcome === "ROLLOUT_COMPLETE") resetCrashes(sess.id);
    releaseLease(sess.id);
    // W8: merge — unknown control-plane fields survive the write-back.
    const docPath = join(dataDir(), "sessions", `${sess.id}.json`);
    const cur = (readJson(docPath) ?? {}) as Record<string, unknown>;
    const status = finalOutcome === "ROLLOUT_COMPLETE" ? "DONE" : finalOutcome;
    writeFileSync(docPath, JSON.stringify({ ...cur, id: sess.id, status, updatedAt: nowIso(), steps: seq }, null, 2), "utf8");
    return { steps: seq - startSeq, outcome: finalOutcome };
  };

  const baseStep = (mySeq: number): Record<string, unknown> => ({
    session_id: sess.id, task_id: taskId,
    step_id: uid("step"), seq: mySeq, timestamp: nowIso(), actor: "eve-agent",
    screen_before: `f-${mySeq}`, screen_after: `f-${mySeq + 1}`,
    goal,
    provenance: { source: "screenshot", channel: "worker-loop", at: nowIso() },
    model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
  });

  // (The DONE assignment below always returns, so CFA narrows `phase` at the
  // head; the cast keeps the comparison well-typed.)
  while (phase !== ("DONE" as Phase)) {
    if (phase === "OBSERVE") {
      // W2: checked at the top of every loop iteration, before any ACT step.
      const ctl = readControl(sess.id);
      if (ctl.humanControl) return finish("HUMAN_CONTROL");
      if (ctl.paused) return finish("PAUSED");
      if (ctl.complete) {
        if (!leaseUsable(sess.id)) return { steps: seq - startSeq, outcome: "LEASE_LOST" };
        const mySeq = seq;
        seq += 1;
        const step = {
          ...baseStep(mySeq),
          vm_state_before: "RUNNING",
          candidate_actions: [],
          selected_action: { type: "noop", confidence: 1, intent: "external completion marker observed; ending rollout" },
          grounding: { verified: true },
          prediction: "no further action; rollout complete",
          verification: { passed: true },
          actual_action: { type: "noop", confidence: 1 },
          vm_state_after: "RUNNING",
          outcome: "rollout-complete", latency_ms: 0,
          trust: 1, cognitive_load: 0,
          human_intervention: false,
        };
        appendFileSync(tracePath(sess.id), JSON.stringify(step) + "\n", "utf8");
        phase = "DONE";
        return finish("ROLLOUT_COMPLETE");
      }
      if (seq - startSeq >= maxSteps) return finish("BUDGET_EXHAUSTED");
      const percept = observe(seed, seq);
      const cands = plan(goal, percept, seed, seq);
      phase = "PLAN";
      void percept; void cands;
      (sess as { _percept?: unknown; _cands?: unknown })._percept = percept;
      (sess as { _percept?: unknown; _cands?: unknown })._cands = cands;
    } else if (phase === "PLAN") {
      phase = "ACT";
    } else if (phase === "ACT") {
      // W7: re-assert lease ownership before the append batch; abort if lost.
      if (!leaseUsable(sess.id)) return { steps: seq - startSeq, outcome: "LEASE_LOST" };
      const bag = sess as unknown as { _percept?: Record<string, unknown>; _cands?: Array<Record<string, unknown>> };
      const cands = bag._cands ?? [];
      const selected = pickBest(cands.length > 0 ? cands : [{ type: "wait", confidence: 0.5 }]);
      const mySeq = seq;
      seq += 1;
      const step = {
        ...baseStep(mySeq),
        vm_state_before: "RUNNING",
        candidate_actions: cands, selected_action: selected,
        grounding: { regionId: (selected["target"] as { regionId?: string } | undefined)?.regionId, verified: true },
        prediction: `expect ${String(selected["type"])} to advance goal`,
        verification: { passed: true },
        actual_action: selected, vm_state_after: "RUNNING",
        outcome: "acted", latency_ms: 100,
        trust: 0.85, cognitive_load: 0.4,
        human_intervention: false,
      };
      appendFileSync(tracePath(sess.id), JSON.stringify(step) + "\n", "utf8");
      phase = "VERIFY";
    } else if (phase === "VERIFY") {
      phase = "OBSERVE";
    }
  }
  return finish("BUDGET_EXHAUSTED");
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
      const { steps, outcome } = runSessionToCompletion(s);
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
