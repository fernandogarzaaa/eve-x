import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp, ensureOptionals, hydrateFromDisk, __clearMemory } from "../apps/api/src/index.js";
import { createSessionToken } from "../packages/security/src/index.js";
import { validateEvidence } from "../packages/validation/src/index.js";
import type { EvidenceBundle } from "../packages/validation/src/index.js";

// Task validation: verdicts must be DERIVED from server-resolved evidence,
// never manufactured by calling the endpoint. These tests pin the
// EvidenceValidator contract (unit) and the HTTP wiring (integration),
// including tamper detection and cross-tenant refusal.

function ev(partial: Partial<EvidenceBundle> & { sessionId: string; stepIds: string[] }): EvidenceBundle {
  return { assertions: [], judgmentIds: [], ...partial };
}

function resolved(id: string, seq: number, extra: Record<string, unknown> = {}) {
  return {
    step_id: id, seq, outcome: "acted",
    grounding: { verified: false },
    verification: { passed: false },
    raw: { step_id: id, seq, outcome: "acted", ...(extra as object) },
  };
}

const OK_REPLAY = { verdict: "deterministic-replay-ok", issues: [], chained: true };

describe("validateEvidence (unit)", () => {
  it("rejects a divergent replay as INVALID_EVIDENCE (tamper poisons all)", () => {
    const r = validateEvidence({
      taskId: "t1",
      evidence: ev({ sessionId: "s", stepIds: ["a"] }),
      resolvedSteps: [resolved("a", 0)],
      replay: { verdict: "replay-divergent", issues: ["digest mismatch at seq 0"], chained: true },
      judgments: [],
      traceChained: true,
    });
    assert.equal(r.verdict, "INVALID_EVIDENCE");
    assert.ok(r.causedBy.some((c) => c.includes("replay-divergent")));
  });

  it("rejects an unchained trace as INVALID_EVIDENCE", () => {
    const r = validateEvidence({
      taskId: "t1",
      evidence: ev({ sessionId: "s", stepIds: ["a"] }),
      resolvedSteps: [resolved("a", 0)],
      replay: OK_REPLAY,
      judgments: [],
      traceChained: false,
    });
    assert.equal(r.verdict, "INVALID_EVIDENCE");
    assert.ok(r.causedBy.some((c) => c.includes("no SHA-256 evidence chain")));
  });

  it("rejects unknown cited steps as INVALID_EVIDENCE", () => {
    const r = validateEvidence({
      taskId: "t1",
      evidence: ev({ sessionId: "s", stepIds: ["ghost"] }),
      resolvedSteps: [resolved("a", 0)],
      replay: OK_REPLAY,
      judgments: [],
      traceChained: true,
    });
    assert.equal(r.verdict, "INVALID_EVIDENCE");
    assert.ok(r.causedBy.some((c) => c.includes("ghost")));
  });

  it("FAILED names the exact failing assertion and step", () => {
    const r = validateEvidence({
      taskId: "t1",
      evidence: ev({
        sessionId: "s", stepIds: ["a"],
        assertions: [{ kind: "outcome-is", outcome: "goal-achieved" }],
      }),
      resolvedSteps: [resolved("a", 0)],
      replay: OK_REPLAY,
      judgments: [],
      traceChained: true,
    });
    assert.equal(r.verdict, "FAILED");
    assert.ok(r.causedBy.some((c) => c.includes("goal-achieved")));
  });

  it("INCONCLUSIVE when assertions pass with no independent confirmation", () => {
    const r = validateEvidence({
      taskId: "t1",
      evidence: ev({
        sessionId: "s", stepIds: ["a"],
        assertions: [{ kind: "outcome-is", outcome: "acted" }],
      }),
      resolvedSteps: [resolved("a", 0)],
      replay: OK_REPLAY,
      judgments: [],
      traceChained: true,
    });
    assert.equal(r.verdict, "INCONCLUSIVE");
  });

  it("PASS with a supporting human judgment, naming the evidence", () => {
    const r = validateEvidence({
      taskId: "t1",
      evidence: ev({
        sessionId: "s", stepIds: ["a"],
        assertions: [{ kind: "outcome-is", outcome: "acted" }],
        judgmentIds: ["j1"],
      }),
      resolvedSteps: [resolved("a", 0)],
      replay: OK_REPLAY,
      judgments: [{ id: "j1", stepId: "a", reviewer: "r1", reasonable: true, targetCorrect: true }],
      traceChained: true,
    });
    assert.equal(r.verdict, "PASS");
    assert.ok(r.causedBy.some((c) => c.includes("j1")));
    assert.deepEqual(r.judgmentIds, ["j1"]);
  });

  it("execution verification alone is INCONCLUSIVE (never laundered to PASS)", () => {
    // Regression (evidence laundering): realAct stamps verification.passed
    // on EVERY act including wait/observe, and outcome:"acted" is
    // agent-visible text. Neither — alone or together — may confirm a
    // verdict, or one acted step would mint its own PASS.
    const r = validateEvidence({
      taskId: "t1",
      evidence: ev({
        sessionId: "s", stepIds: ["a"],
        assertions: [{ kind: "verification-passed" }, { kind: "outcome-is", outcome: "acted" }],
      }),
      resolvedSteps: [resolved("a", 0, { verification: { passed: true } })].map((s) => ({
        ...s, verification: { passed: true },
      })),
      replay: OK_REPLAY,
      judgments: [],
      traceChained: true,
    });
    assert.equal(r.verdict, "INCONCLUSIVE");
  });

  it("PASS with server-verified grounding (decision tied to observation)", () => {
    const r = validateEvidence({
      taskId: "t1",
      evidence: ev({
        sessionId: "s", stepIds: ["a"],
        assertions: [{ kind: "grounding-verified" }, { kind: "outcome-is", outcome: "acted" }],
      }),
      resolvedSteps: [resolved("a", 0, { grounding: { verified: true } })].map((s) => ({
        ...s, grounding: { verified: true },
      })),
      replay: OK_REPLAY,
      judgments: [],
      traceChained: true,
    });
    assert.equal(r.verdict, "PASS");
    assert.ok(r.causedBy.some((c) => c.includes("server-verified grounding") || c.includes("grounding")));
  });

  it("a non-supporting judgment cannot confirm PASS", () => {
    const r = validateEvidence({
      taskId: "t1",
      evidence: ev({ sessionId: "s", stepIds: ["a"], judgmentIds: ["j9"] }),
      resolvedSteps: [resolved("a", 0)],
      replay: OK_REPLAY,
      judgments: [{ id: "j9", stepId: "a", reviewer: "r1", reasonable: false, targetCorrect: false }],
      traceChained: true,
    });
    assert.equal(r.verdict, "INCONCLUSIVE");
  });

  it("is deterministic: same inputs, same verdict", () => {
    const input = {
      taskId: "t1",
      evidence: ev({ sessionId: "s", stepIds: ["a"], assertions: [{ kind: "outcome-is" as const, outcome: "acted" }] }),
      resolvedSteps: [resolved("a", 0)],
      replay: OK_REPLAY,
      judgments: [],
      traceChained: true,
    };
    const a = validateEvidence(input);
    const b = validateEvidence(input);
    assert.equal(a.verdict, b.verdict);
    assert.deepEqual(a.assertionResults, b.assertionResults);
    assert.deepEqual(a.causedBy, b.causedBy);
  });
});

describe("POST /v1/tasks/:id/validate (integration)", () => {
  let base = "";
  let srv: Server | null = null;
  const MASTER = "test-master-token-validation";
  let DATA = "";
  let prevBackend: string | undefined;

  async function api(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json: json as Record<string, unknown> };
  }

  before(async () => {
    DATA = mkdtempSync(join(tmpdir(), "evex-validate-"));
    process.env["DATA_DIR"] = DATA;
    process.env["EVEX_AUTH_TOKEN"] = MASTER;
    process.env["EVEX_TOKEN_SECRET"] = "test-hmac-secret-validation";
    prevBackend = process.env["VM_BACKEND"];
    process.env["VM_BACKEND"] = "dev-framebuffer";
    // Generous quotas: every seedTaskWithSteps provisions a session VM.
    process.env["EVEX_MAX_VMS_PER_TENANT"] = "64";
    process.env["EVEX_MAX_TOTAL_VMS"] = "512";
    process.env["EVEX_MAX_CPU_PER_TENANT"] = "256";
    process.env["EVEX_MAX_MEM_MB_PER_TENANT"] = "524288";
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
  });

  async function seedTaskWithSteps(goal = "open settings"): Promise<{ taskId: string; sessionId: string; stepIds: string[] }> {
    const t = await api("POST", "/v1/tasks/start", MASTER, { goal });
    assert.equal(t.status, 201);
    const taskId = String((t.json as Record<string, unknown>)["id"]);
    const s = await api("POST", "/v1/sessions", MASTER, { goal });
    assert.equal(s.status, 201);
    const sessionId = String((s.json as Record<string, unknown>)["id"]);
    for (let i = 0; i < 2; i += 1) {
      const a = await api("POST", `/v1/computer/${sessionId}/act`, MASTER, { type: "wait", ms: 10, confidence: 0.9 });
      assert.equal(a.status, 200, `act failed: ${JSON.stringify(a.json)}`);
    }
    const tr = await api("GET", `/v1/trace/${sessionId}`, MASTER);
    const steps = (tr.json as Record<string, unknown>)["steps"] as Array<Record<string, unknown>>;
    assert.ok(steps.length >= 2);
    return { taskId, sessionId, stepIds: steps.map((st) => String(st["step_id"])) };
  }

  async function judge(sessionId: string, stepId: string, ok: boolean): Promise<string> {
    const j = await api("POST", "/v1/judgments", MASTER, {
      stepId, sessionId, reviewer: "r1",
      reasonable: ok, targetCorrect: ok, understandable: true, expected: true, recoveryOk: true,
    });
    assert.equal(j.status, 201, `judgment failed: ${JSON.stringify(j.json)}`);
    return String((j.json as Record<string, unknown>)["id"]);
  }

  it("400s without an evidence bundle (calling validate manufactures nothing)", async () => {    const { taskId } = await seedTaskWithSteps();
    const r = await api("POST", `/v1/tasks/${taskId}/validate`, MASTER, {});
    assert.equal(r.status, 400);
    assert.equal((r.json as Record<string, unknown>)["error"], "evidence_required");
    const st = await api("GET", `/v1/tasks/${taskId}/status`, MASTER);
    assert.notEqual((st.json as Record<string, unknown>)["status"], "DONE");
  });

  it("INVALID_EVIDENCE for unknown cited steps", async () => {
    const { taskId, sessionId } = await seedTaskWithSteps();
    const r = await api("POST", `/v1/tasks/${taskId}/validate`, MASTER, {
      evidence: { sessionId, stepIds: ["step-ghost-xyz"] },
    });
    assert.equal((r.json as Record<string, unknown> && (r.json as { validation: { verdict: string } }).validation.verdict), "INVALID_EVIDENCE");
  });

  it("INVALID_EVIDENCE for cross-session evidence injection", async () => {
    const a = await seedTaskWithSteps("goal A");
    const b = await seedTaskWithSteps("goal B");
    // Session B's real, chained steps cited as session A's evidence: the
    // resolver only sees A's trace, so they are unknown there — refused,
    // never borrowed across the session boundary.
    const r = await api("POST", `/v1/tasks/${a.taskId}/validate`, MASTER, {
      evidence: { sessionId: a.sessionId, stepIds: b.stepIds },
    });
    assert.equal((r.json as { validation: { verdict: string } }).validation.verdict, "INVALID_EVIDENCE");
  });

  it("INCONCLUSIVE for passing assertions with no independent confirmation", async () => {
    const { taskId, sessionId, stepIds } = await seedTaskWithSteps();
    const r = await api("POST", `/v1/tasks/${taskId}/validate`, MASTER, {
      evidence: { sessionId, stepIds, assertions: [{ kind: "outcome-is", outcome: "acted" }] },
    });
    const v = (r.json as { validation: { verdict: string } }).validation;
    assert.equal(v.verdict, "INCONCLUSIVE");
  });

  it("FAILED names the failing assertion", async () => {
    const { taskId, sessionId, stepIds } = await seedTaskWithSteps();
    const r = await api("POST", `/v1/tasks/${taskId}/validate`, MASTER, {
      evidence: { sessionId, stepIds, assertions: [{ kind: "outcome-is", outcome: "goal-achieved" }] },
    });
    const body = r.json as { validation: { verdict: string; causedBy: string[] }; task: { status: string } };
    assert.equal(body.validation.verdict, "FAILED");
    assert.ok(body.validation.causedBy.some((c) => c.includes("goal-achieved")));
    assert.equal(body.task.status, "DONE");
  });

  it("PASS with a supporting human judgment, task DONE", async () => {
    const { taskId, sessionId, stepIds } = await seedTaskWithSteps();
    const jid = await judge(sessionId, stepIds[0] as string, true);
    const r = await api("POST", `/v1/tasks/${taskId}/validate`, MASTER, {
      evidence: {
        sessionId, stepIds,
        assertions: [{ kind: "outcome-is", outcome: "acted" }],
        judgmentIds: [jid],
      },
    });
    const body = r.json as { validation: { verdict: string; causedBy: string[] }; task: { status: string } };
    assert.equal(body.validation.verdict, "PASS");
    assert.ok(body.validation.causedBy.some((c) => c.includes(jid)));
    assert.equal(body.task.status, "DONE");
  });

  it("INVALID_EVIDENCE when the trace file is tampered post-hoc", async () => {
    const { taskId, sessionId, stepIds } = await seedTaskWithSteps();
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const objDir = process.env["OBJECT_DIR"] ?? join(DATA, "objects");
    const p = join(objDir, "traces", `${safe}.jsonl`);
    assert.ok(existsSync(p), "trace file must exist");
    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim().length > 0);
    const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
    first["outcome"] = "goal-achieved";
    lines[0] = JSON.stringify(first);
    writeFileSync(p, lines.join("\n") + "\n", "utf8");
    // Simulate a restart: drop memory so the merged trace reads the file.
    __clearMemory();
    hydrateFromDisk();
    const r = await api("POST", `/v1/tasks/${taskId}/validate`, MASTER, {
      evidence: { sessionId, stepIds, assertions: [{ kind: "outcome-is", outcome: "goal-achieved" }] },
    });
    const v = (r.json as { validation: { verdict: string } }).validation;
    assert.equal(v.verdict, "INVALID_EVIDENCE");
  });

  it("cross-tenant validation and judgment are refused", async () => {
    const { taskId, sessionId, stepIds } = await seedTaskWithSteps();
    const mallory = createSessionToken({ user: "mallory", role: "operator" }).token;
    const v = await api("POST", `/v1/tasks/${taskId}/validate`, mallory, {
      evidence: { sessionId, stepIds },
    });
    assert.equal(v.status, 403);
    const j = await api("POST", "/v1/judgments", mallory, {
      stepId: stepIds[0], sessionId, reviewer: "mallory",
      reasonable: true, targetCorrect: true, understandable: true, expected: true, recoveryOk: true,
    });
    assert.equal(j.status, 403);
  });
});
