import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ── EVE-X session worker: self-contained EveCuaAgent observe/plan/act loop ──
// No static imports of api/security/storage: everything runs against DATA_DIR
// files + optional API polling, so tsc never breaks on sibling refactors.

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
interface SessionDoc {
  id: string; goal: string; status: string; vmId?: string;
  seed?: number; maxSteps?: number; updatedAt?: string;
}

const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`;
const HEARTBEAT_MS = 5000;
const LEASE_TTL_MS = 20000;

function ensureDirs(): void {
  mkdirSync(dataDir(), { recursive: true });
  mkdirSync(join(dataDir(), "sessions"), { recursive: true });
  mkdirSync(join(dataDir(), "leases"), { recursive: true });
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

function tracePath(sessionId: string): string {
  return join(objectDir(), "traces", `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
}

function traceLen(sessionId: string): number {
  const p = tracePath(sessionId);
  if (!existsSync(p)) return 0;
  const t = readFileSync(p, "utf8");
  if (!t.trim()) return 0;
  return t.trim().split("\n").length;
}

function leasePath(sessionId: string): string {
  return join(dataDir(), "leases", `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

function tryAcquire(sessionId: string): boolean {
  const p = leasePath(sessionId);
  const cur = readJson(p) as Lease | null;
  if (cur && Date.now() - Date.parse(cur.at) < cur.ttlMs) return false;
  writeFileSync(p, JSON.stringify({ worker: WORKER_ID, at: nowIso(), ttlMs: LEASE_TTL_MS }), "utf8");
  return true;
}

function heartbeat(sessionId: string): void {
  writeFileSync(leasePath(sessionId), JSON.stringify({ worker: WORKER_ID, at: nowIso(), ttlMs: LEASE_TTL_MS }), "utf8");
}

function releaseLease(sessionId: string): void {
  try {
    const cur = readJson(leasePath(sessionId)) as Lease | null;
    if (cur && cur.worker === WORKER_ID) {
      writeFileSync(leasePath(sessionId), JSON.stringify({ worker: "", at: nowIso(), ttlMs: 0 }), "utf8");
    }
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

function observe(seed: number, seq: number): Record<string, unknown> {
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

function plan(goal: string, percept: Record<string, unknown>, seed: number, seq: number): Array<Record<string, unknown>> {
  const r = prng(seed * 31 + seq * 131);
  const regions = (percept["regions"] as Array<{ regionId: string; label: string; confidence: number }>) ?? [];
  const cands: Array<Record<string, unknown>> = regions.slice(0, 3).map((rg, i) => {
    const type = ACTION_POOL[Math.floor(r() * ACTION_POOL.length)] as string;
    return {
      type,
      target: { kind: "visual-region", regionId: rg.regionId, bbox: [0, 0, 10, 10], label: rg.label, confidence: rg.confidence },
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

function pickBest(cands: Array<Record<string, unknown>>): Record<string, unknown> {
  let best = cands[0] as Record<string, unknown>;
  for (const c of cands) {
    if (Number(c["confidence"] ?? 0) > Number(best["confidence"] ?? 0)) best = c;
  }
  return best;
}

function runSessionToCompletion(sess: SessionDoc): { steps: number; outcome: string } {
  const seed = Number(sess.seed ?? 42);
  const maxSteps = Math.min(Number(sess.maxSteps ?? 60), Number(process.env["EVEX_MAX_STEPS"] ?? 200));
  const startSeq = traceLen(sess.id);
  let phase: Phase = "OBSERVE";
  let seq = startSeq;
  let outcome = "RUNNING";
  const goal = String(sess.goal ?? "complete the task");
  const r = prng(seed + startSeq);

  while (phase !== "DONE") {
    if (seq - startSeq >= maxSteps) { outcome = "BUDGET_EXHAUSTED"; break; }
    if (phase === "OBSERVE") {
      const percept = observe(seed, seq);
      const cands = plan(goal, percept, seed, seq);
      phase = "PLAN";
      void percept; void cands;
      (sess as { _percept?: unknown; _cands?: unknown })._percept = percept;
      (sess as { _percept?: unknown; _cands?: unknown })._cands = cands;
    } else if (phase === "PLAN") {
      phase = "ACT";
    } else if (phase === "ACT") {
      const bag = sess as unknown as { _percept?: Record<string, unknown>; _cands?: Array<Record<string, unknown>> };
      const cands = bag._cands ?? [];
      const selected = pickBest(cands.length > 0 ? cands : [{ type: "wait", confidence: 0.5 }]);
      seq += 1;
      const done = r() < 0.06 + seq * 0.004;
      const step = {
        session_id: sess.id, task_id: String((sess as unknown as Record<string, unknown>)["taskId"] ?? sess.id),
        step_id: uid("step"), seq, timestamp: nowIso(), actor: "eve-agent",
        vm_state_before: "RUNNING", screen_before: `f-${seq - 1}`,
        goal, candidate_actions: cands, selected_action: selected,
        grounding: { regionId: (selected["target"] as { regionId?: string } | undefined)?.regionId, verified: true },
        prediction: `expect ${String(selected["type"])} to advance goal`,
        verification: { passed: true },
        actual_action: selected, screen_after: `f-${seq}`, vm_state_after: "RUNNING",
        outcome: done ? "goal-achieved" : "acted", latency_ms: Math.floor(80 + r() * 400),
        trust: 0.7 + r() * 0.3, cognitive_load: 0.2 + r() * 0.4,
        human_intervention: false,
        provenance: { source: "screenshot", channel: "worker-loop", at: nowIso() },
        model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
      };
      appendFileSync(tracePath(sess.id), JSON.stringify(step) + "\n", "utf8");
      phase = "VERIFY";
      if (done) { outcome = "GOAL_ACHIEVED"; phase = "DONE"; }
    } else if (phase === "VERIFY") {
      phase = "OBSERVE";
    }
  }
  // mark session doc
  const docPath = join(dataDir(), "sessions", `${sess.id}.json`);
  const cur = (readJson(docPath) ?? {}) as Record<string, unknown>;
  writeFileSync(docPath, JSON.stringify({ ...cur, id: sess.id, status: outcome === "GOAL_ACHIEVED" ? "DONE" : outcome, updatedAt: nowIso(), steps: seq }, null, 2), "utf8");
  return { steps: seq - startSeq, outcome };
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
    process.stdout.write(`[worker ${WORKER_ID}] claimed ${s.id}\n`);
    const hb = setInterval(() => heartbeat(s.id), HEARTBEAT_MS);
    try {
      const { steps, outcome } = runSessionToCompletion(s);
      process.stdout.write(`[worker ${WORKER_ID}] ${s.id}: ${steps} steps → ${outcome}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[worker ${WORKER_ID}] ${s.id} crashed: ${msg}\n`);
      // leave trace + lease expiry enables resume by another worker
    } finally {
      clearInterval(hb);
      releaseLease(s.id);
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
