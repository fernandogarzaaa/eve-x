import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp, ensureOptionals, hydrateFromDisk, __clearMemory } from "../apps/api/src/index.js";
import { createSessionToken } from "../packages/security/src/index.js";
import { store } from "../packages/storage/src/index.js";

// API hardening: exercises the fixed control-plane behaviors over real HTTP
// against buildApp() on an ephemeral port (no extra deps; global fetch).

let base = "";
let srv: Server | null = null;
const MASTER = "test-master-token-xyz";
const SECRET = "test-hmac-secret-abc";
let prevBackend: string | undefined;
const QUOTA_ENV: Record<string, string> = {
  EVEX_MAX_VMS_PER_TENANT: "64",
  EVEX_MAX_TOTAL_VMS: "512",
  EVEX_MAX_CPU_PER_TENANT: "256",
  EVEX_MAX_MEM_MB_PER_TENANT: "524288",
};
const prevQuota: Record<string, string | undefined> = {};

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

interface ApiRes {
  status: number;
  headers: Headers;
  json: any;
}

async function api(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  extra?: Record<string, string>,
): Promise<ApiRes> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...auth(token), ...(extra ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json };
}

async function createSession(token: string, goal = "open settings"): Promise<string> {
  const r = await api("POST", "/v1/sessions", token, { goal });
  assert.equal(r.status, 201, `session create failed: ${JSON.stringify(r.json)}`);
  return String(r.json.id);
}

async function createVm(token: string): Promise<string> {
  const r = await api("POST", "/v1/vms", token, {});
  assert.equal(r.status, 201, `vm create failed: ${JSON.stringify(r.json)}`);
  return String(r.json.id);
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "evex-hard-"));
  process.env["DATA_DIR"] = dir;
  process.env["EVEX_AUTH_TOKEN"] = MASTER;
  process.env["EVEX_TOKEN_SECRET"] = SECRET;
  process.env["EVEX_CORS_ORIGINS"] = "http://localhost:3000,http://localhost:3001";
  // Pin the dev backend: these tests exercise API hardening (authz, replay,
  // idempotency), not drivers. Without the pin, auto-select would grab a
  // live Docker daemon where present and change timing/behavior.
  prevBackend = process.env["VM_BACKEND"];
  process.env["VM_BACKEND"] = "dev-framebuffer";
  for (const [k, v] of Object.entries(QUOTA_ENV)) {
    prevQuota[k] = process.env[k];
    process.env[k] = v;
  }
  delete process.env["EVEX_TENANT"];
  await ensureOptionals();
  __clearMemory();
  const app = buildApp();
  hydrateFromDisk();
  const s = createServer(app);
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
  srv = s;
  const addr = s.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => srv?.close(() => resolve()));
  if (prevBackend === undefined) delete process.env["VM_BACKEND"];
  else process.env["VM_BACKEND"] = prevBackend;
  for (const [k, v] of Object.entries(prevQuota)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("api hardening", () => {
  it("illegal VM transition returns 409 without mutating state", async () => {
    const vm = await createVm(MASTER);
    const snap1 = await api("POST", `/v1/vms/${vm}/snapshot`, MASTER, { label: "snap1" });
    assert.equal(snap1.status, 200);
    assert.equal(snap1.json.state, "RUNNING");
    // RUNNING -> RUNNING is illegal: must 409 and leave state/snapshots alone.
    const illegal = await api("POST", `/v1/vms/${vm}/snapshot`, MASTER, { label: "snap2" });
    assert.equal(illegal.status, 409);
    assert.equal(illegal.json.error, "illegal_transition");
    const st = await api("GET", `/v1/vms/${vm}/status`, MASTER);
    assert.equal(st.json.state, "RUNNING");
    const full = await api("GET", `/v1/vms/${vm}`, MASTER);
    assert.deepEqual(full.json.snapshots, ["snap1"]);
  });

  it("restore of an unknown snapshot returns 404 and never touches state", async () => {
    const vm = await createVm(MASTER);
    await api("POST", `/v1/vms/${vm}/snapshot`, MASTER, { label: "good1" });
    const bad = await api("POST", `/v1/vms/${vm}/restore`, MASTER, { snapshot: "nope-missing" });
    assert.equal(bad.status, 404);
    assert.equal(bad.json.error, "snapshot_not_found");
    const st = await api("GET", `/v1/vms/${vm}/status`, MASTER);
    assert.equal(st.json.state, "RUNNING");
    // Restore with an invalid label is rejected before any state change.
    const trav = await api("POST", `/v1/vms/${vm}/restore`, MASTER, { snapshot: "../evil" });
    assert.equal(trav.status, 400);
    const st2 = await api("GET", `/v1/vms/${vm}/status`, MASTER);
    assert.equal(st2.json.state, "RUNNING");
  });

  it("replay reports divergent on a seq gap and ok on a clean trace", async () => {
    const gapped = await createSession(MASTER, "gap case");
    store.appendTrace(gapped, {
      session_id: gapped, task_id: "task-x", step_id: "step-gap", seq: 2,
      timestamp: new Date().toISOString(), actor: "eve-agent",
      vm_state_before: "RUNNING", screen_before: "f-1", goal: "gap case",
      candidate_actions: [],
      provenance: { source: "screenshot", channel: "t", at: new Date().toISOString() },
      model_version: "evex-1", environment_version: "env-1",
    });
    const r = await api("POST", `/v1/replay/${gapped}`, MASTER, {});
    assert.equal(r.json.verdict, "replay-divergent");
    assert.ok(Array.isArray(r.json.issues) && r.json.issues.length > 0);
    assert.equal(r.json.replayed, 2);

    const clean = await createSession(MASTER, "clean case");
    const ok = await api("POST", `/v1/replay/${clean}`, MASTER, {});
    assert.equal(ok.json.verdict, "deterministic-replay-ok");
    assert.deepEqual(ok.json.issues, []);
  });

  it("act idempotency returns the original response with no new step", async () => {
    const sess = await createSession(MASTER, "idem case");
    const body = { type: "click", x: 100, y: 200, idempotencyKey: "idem-1" };
    const first = await api("POST", `/v1/computer/${sess}/act`, MASTER, body);
    assert.equal(first.status, 200);
    assert.equal(first.json.seq, 1);
    const second = await api("POST", `/v1/computer/${sess}/act`, MASTER, body);
    assert.equal(second.status, 200);
    assert.deepEqual(second.json, first.json);
    const trace = await api("GET", `/v1/trace/${sess}`, MASTER);
    assert.equal(trace.json.steps.length, 2);
    assert.deepEqual(trace.json.steps.map((s: any) => s.seq), [0, 1]);
  });

  it("act with a stale frameId returns 409 with the current frame", async () => {
    const sess = await createSession(MASTER, "stale case");
    const stale = await api("POST", `/v1/computer/${sess}/act`, MASTER, { type: "click", x: 1, y: 2, frameId: "f-999" });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error, "stale_perception");
    assert.equal(stale.json.current, "f-0");
    const fresh = await api("POST", `/v1/computer/${sess}/act`, MASTER, { type: "click", x: 1, y: 2, frameId: "f-0" });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.json.seq, 1);
  });

  it("act with an unknown action type returns 400", async () => {
    const sess = await createSession(MASTER, "bad type case");
    const r = await api("POST", `/v1/computer/${sess}/act`, MASTER, { type: "definitely_not_a_type" });
    assert.equal(r.status, 400);
  });

  it("every response carries x-request-id", async () => {
    const h = await fetch(`${base}/health`);
    assert.ok((h.headers.get("x-request-id") ?? "").length > 0);
    await h.json();
    const nf = await api("GET", "/v1/sessions/does-not-exist", MASTER);
    assert.equal(nf.status, 404);
    assert.ok((nf.headers.get("x-request-id") ?? "").length > 0);
  });

  it("CORS reflects allowlisted origins only", async () => {
    const okRes = await fetch(`${base}/health`, { headers: { Origin: "http://localhost:3000" } });
    assert.equal(okRes.headers.get("access-control-allow-origin"), "http://localhost:3000");
    await okRes.json();
    const evil = await fetch(`${base}/health`, { headers: { Origin: "https://evil.example" } });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    await evil.json();
    const pre = await fetch(`${base}/v1/sessions`, { method: "OPTIONS", headers: { Origin: "http://localhost:3000" } });
    assert.equal(pre.status, 204);
  });

  it("cross-tenant ids are rejected with 403", async () => {
    const a = createSessionToken({ tenant: "tenant-a", user: "alice" }).token;
    const b = createSessionToken({ tenant: "tenant-b", user: "bob" }).token;
    const sess = await createSession(a, "tenant-a goal");
    const cross = await api("GET", `/v1/sessions/${sess}`, b);
    assert.equal(cross.status, 403);
    assert.equal(cross.json.error, "forbidden");
    const own = await api("GET", `/v1/sessions/${sess}`, a);
    assert.equal(own.status, 200);

    const vmRes = await api("POST", "/v1/vms", a, {});
    assert.equal(vmRes.status, 201);
    const vmCross = await api("GET", `/v1/vms/${String(vmRes.json.id)}`, b);
    assert.equal(vmCross.status, 403);

    const taskRes = await api("POST", "/v1/tasks/start", a, { goal: "tenant task" });
    assert.equal(taskRes.status, 201);
    const taskCross = await api("GET", `/v1/tasks/${String(taskRes.json.id)}/status`, b);
    assert.equal(taskCross.status, 403);
  });

  it("judgment duplicates on (stepId, reviewer) return 409", async () => {
    // Judgments bind to real, owned steps: unknown steps fail closed (404).
    const sess = await createSession(MASTER, "judgment dedupe case");
    const act = await api("POST", `/v1/computer/${sess}/act`, MASTER, { type: "wait", ms: 10, confidence: 0.9 });
    assert.equal(act.status, 200);
    const tr = await api("GET", `/v1/trace/${sess}`, MASTER);
    const steps = tr.json.steps as Array<{ step_id: string }>;
    assert.ok(steps.length > 0);
    const body = {
      stepId: String(steps[0]?.step_id), sessionId: sess, reviewer: "r1",
      reasonable: true, targetCorrect: true, understandable: true, expected: true, recoveryOk: true,
    };
    const unknown = await api("POST", "/v1/judgments", MASTER, { ...body, stepId: "step-ghost-xyz" });
    assert.equal(unknown.status, 404);
    const first = await api("POST", "/v1/judgments", MASTER, body);
    assert.equal(first.status, 201);
    const dup = await api("POST", "/v1/judgments", MASTER, body);
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error, "duplicate");
    const otherReviewer = await api("POST", "/v1/judgments", MASTER, { ...body, reviewer: "r2" });
    assert.equal(otherReviewer.status, 201);
  });

  it("snapshot label traversal is rejected and state is preserved", async () => {
    const vm = await createVm(MASTER);
    const bad = await api("POST", `/v1/vms/${vm}/snapshot`, MASTER, { label: "../../evil" });
    assert.equal(bad.status, 400);
    const st = await api("GET", `/v1/vms/${vm}/status`, MASTER);
    assert.equal(st.json.state, "READY");
  });

  it("rate limiter returns 429 with Retry-After on bursts", async () => {
    const burst = createSessionToken({ tenant: "burst-t", user: "bursty" }).token;
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    let body: any = null;
    for (let i = 0; i < 25; i += 1) {
      const r = await api("POST", "/v1/vms", burst, {});
      statuses.push(r.status);
      if (r.status === 429) {
        retryAfter = r.headers.get("retry-after");
        body = r.json;
      }
    }
    assert.equal(statuses[0], 201);
    assert.ok(statuses.includes(429), `expected a 429 in burst, got ${statuses.join(",")}`);
    assert.ok((retryAfter ?? "").length > 0, "Retry-After header missing");
    assert.equal(body?.error, "rate_limited");
    assert.equal(typeof body?.retryAfter, "number");
  });

  it("persisted docs survive a restart (clear + hydrate)", async () => {
    const sess = await createSession(MASTER, "restart case");
    const act = await api("POST", `/v1/computer/${sess}/act`, MASTER, { type: "wait", ms: 10, confidence: 0.9 });
    assert.equal(act.status, 200);
    const tr = await api("GET", `/v1/trace/${sess}`, MASTER);
    const steps = tr.json.steps as Array<{ step_id: string }>;
    assert.ok(steps.length > 0);
    const stepId = String(steps[0]?.step_id);
    const first = await api("POST", "/v1/judgments", MASTER, {
      stepId, sessionId: sess, reviewer: "r-restart",
      reasonable: true, targetCorrect: true, understandable: true, expected: true, recoveryOk: true,
    });
    assert.equal(first.status, 201);
    __clearMemory();
    const counts = hydrateFromDisk();
    assert.ok(counts.sessions >= 1, `expected hydrated sessions, got ${JSON.stringify(counts)}`);
    const got = await api("GET", `/v1/sessions/${sess}`, MASTER);
    assert.equal(got.status, 200);
    // Recovery honesty: in-flight RUNNING is demoted to PAUSED on restart —
    // execution is never resurrected without proof. Explicit resume re-arms.
    assert.equal(got.json.status, "PAUSED");
    const badResume = await api("POST", `/v1/sessions/${sess}/resume`, MASTER, {});
    assert.equal(badResume.status, 200);
    assert.equal(badResume.json.status, "RUNNING");
    const resumeAgain = await api("POST", `/v1/sessions/${sess}/resume`, MASTER, {});
    assert.equal(resumeAgain.status, 409);
    // Dedupe state also survives: the earlier judgment is still a duplicate.
    const dup = await api("POST", "/v1/judgments", MASTER, {
      stepId, sessionId: sess, reviewer: "r-restart",
      reasonable: true, targetCorrect: true, understandable: true, expected: true, recoveryOk: true,
    });
    assert.equal(dup.status, 409);
  });
});
