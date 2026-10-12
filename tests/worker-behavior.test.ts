import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKER_ID,
  WorkerStepError,
  controlPath,
  driveSession,
  heartbeat,
  leasePath,
  recordCrash,
  runSessionToCompletion,
  tracePath,
  tryAcquire,
} from "../apps/worker/src/index.js";
import type {
  ActuationReceipt,
  ControlPlaneDeps,
  ModelSuggestion,
  ObservedFrame,
  SessionDoc,
} from "../apps/worker/src/index.js";

// Worker behavior tests: the production worker is a control-plane
// orchestrator. It must never synthesize perception, grounding,
// verification, or success — these tests pin the refusal paths as well as
// the honest orchestration paths, against a fresh temp DATA_DIR.
const DATA = mkdtempSync(join(tmpdir(), "evex-worker-test-"));
process.env["DATA_DIR"] = DATA;
process.env["EVEX_WORKER_MAX_CONSECUTIVE_FAILURES"] = "3";

function nowIso(): string {
  return new Date().toISOString();
}

function san(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function seedSession(id: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(DATA, "sessions"), { recursive: true });
  writeFileSync(
    join(DATA, "sessions", `${id}.json`),
    JSON.stringify({ id, goal: "open the settings app", status: "RUNNING", seed: 1234, maxSteps: 60, ...extra }, null, 2),
    "utf8",
  );
}

function readDoc(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(DATA, "sessions", `${id}.json`), "utf8")) as Record<string, unknown>;
}

function writeControl(id: string, obj: unknown): void {
  mkdirSync(join(DATA, "control"), { recursive: true });
  writeFileSync(controlPath(id), JSON.stringify(obj), "utf8");
}

function writeLease(id: string, obj: unknown): void {
  mkdirSync(join(DATA, "leases"), { recursive: true });
  writeFileSync(leasePath(id), JSON.stringify(obj), "utf8");
}

function readLease(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(leasePath(id), "utf8")) as Record<string, unknown>;
}

function sess(id: string, maxSteps = 60): SessionDoc {
  return { id, goal: "open the settings app", status: "RUNNING", seed: 7, maxSteps };
}

// A canned control-plane backend: real-shaped evidence, explicitly built in
// test code. The shipped worker contains no such constructor.
function stubDeps(over: {
  observe?: (sessionId: string, call: number) => ObservedFrame | Promise<ObservedFrame>;
  suggest?: (sessionId: string, frame: ObservedFrame) => ModelSuggestion | Promise<ModelSuggestion>;
  act?: (sessionId: string, action: Record<string, unknown>, frameId: string) => ActuationReceipt | Promise<ActuationReceipt>;
} = {}): ControlPlaneDeps {
  let n = 0;
  return {
    kind: "control-plane",
    observe: async (sessionId: string): Promise<ObservedFrame> => {
      n += 1;
      if (over.observe) return over.observe(sessionId, n);
      return { frameId: `frame-${n}`, width: 1280, height: 800, regions: [], synthetic: false, backend: "qemu" };
    },
    suggest: async (sessionId: string, frame: ObservedFrame): Promise<ModelSuggestion> => {
      if (over.suggest) return over.suggest(sessionId, frame);
      return {
        action: { type: "move", to: { x: 100, y: 100 }, confidence: 0.7 },
        frameId: frame.frameId, modelId: "test-model-1", degraded: false, latencyMs: 12,
      };
    },
    act: async (sessionId: string, action: Record<string, unknown>, frameId: string): Promise<ActuationReceipt> => {
      if (over.act) return over.act(sessionId, action, frameId);
      return { seq: n, frameId: `${frameId}-after`, terminated: false, synthetic: false };
    },
  };
}

describe("W1: atomic lease acquire", () => {
  it("refuses a live foreign lease and leaves the file untouched", () => {
    const id = "w1-live";
    const live = { worker: "other-worker-1", at: nowIso(), ttlMs: 60000 };
    writeLease(id, live);
    assert.equal(tryAcquire(id), false);
    assert.deepEqual(readLease(id), live);
  });

  it("claims a stale lease", () => {
    const id = "w1-stale";
    writeLease(id, { worker: "other-worker-2", at: new Date(Date.now() - 120000).toISOString(), ttlMs: 5000 });
    assert.equal(tryAcquire(id), true);
    assert.equal(readLease(id)["worker"], WORKER_ID);
  });

  it("heartbeat never clobbers a foreign owner", () => {
    const id = "w1-hb";
    const foreign = { worker: "foreign-worker", at: nowIso(), ttlMs: 60000 };
    writeLease(id, foreign);
    heartbeat(id);
    assert.deepEqual(readLease(id), foreign);
  });
});

describe("W2: human takeover and pause", () => {
  it("stops with HUMAN_CONTROL and issues zero act calls", async () => {
    const id = "w2-takeover";
    seedSession(id, { seed: 7, maxSteps: 5 });
    writeControl(id, { humanControl: true });
    let acts = 0;
    const deps = stubDeps({ act: async () => { acts += 1; throw new Error("must not act"); } });
    const res = await driveSession(sess(id, 5), deps);
    assert.equal(res.outcome, "HUMAN_CONTROL");
    assert.equal(acts, 0);
    assert.equal(existsSync(tracePath(id)), false);
    assert.equal(readDoc(id)["status"], "HUMAN_CONTROL");
  });

  it("stops with PAUSED and issues zero act calls", async () => {
    const id = "w2-paused";
    seedSession(id, { seed: 7, maxSteps: 5 });
    writeControl(id, { paused: true });
    let acts = 0;
    const deps = stubDeps({ act: async () => { acts += 1; throw new Error("must not act"); } });
    const res = await driveSession(sess(id, 5), deps);
    assert.equal(res.outcome, "PAUSED");
    assert.equal(acts, 0);
    assert.equal(existsSync(tracePath(id)), false);
    assert.equal(readDoc(id)["status"], "PAUSED");
  });
});

describe("W3: no fabricated success, no worker trace writes", () => {
  it("exhausts budget without any goal-achieved claim and writes no trace", async () => {
    const id = "w3-budget";
    seedSession(id, { seed: 99, maxSteps: 2 });
    const res = await driveSession(sess(id, 2), stubDeps());
    assert.equal(res.outcome, "BUDGET_EXHAUSTED");
    assert.equal(res.steps, 2);
    assert.equal(existsSync(tracePath(id)), false);
    const doc = readDoc(id);
    assert.equal(doc["status"], "BUDGET_EXHAUSTED");
    assert.equal(doc["workerSteps"], 2);
  });

  it("external completion marker ends the rollout as DONE with no marker step", async () => {
    const id = "w3-complete";
    seedSession(id, { seed: 9, maxSteps: 5 });
    writeControl(id, { complete: true });
    let acts = 0;
    const deps = stubDeps({ act: async () => { acts += 1; throw new Error("must not act"); } });
    const res = await driveSession(sess(id, 5), deps);
    assert.equal(res.outcome, "ROLLOUT_COMPLETE");
    assert.equal(acts, 0);
    assert.equal(existsSync(tracePath(id)), false);
    assert.equal(readDoc(id)["status"], "DONE");
  });
});

describe("W5: crash counting", () => {
  it("marks the session FAILED after 3 crashes", () => {
    const id = "w5-crash";
    seedSession(id, { status: "RUNNING" });
    assert.deepEqual(recordCrash(id), { count: 1, failed: false });
    assert.deepEqual(recordCrash(id), { count: 2, failed: false });
    assert.deepEqual(recordCrash(id), { count: 3, failed: true });
    const doc = readDoc(id);
    assert.equal(doc["status"], "FAILED");
    assert.equal(doc["reason"], "crash-loop");
  });
});

describe("W7: lease-gated orchestration", () => {
  it("aborts without control-plane calls when the lease is held by another worker", async () => {
    const id = "w7-leaselost";
    seedSession(id, { seed: 3, maxSteps: 2 });
    writeLease(id, { worker: "someone-else", at: nowIso(), ttlMs: 60000 });
    let observes = 0;
    const deps = stubDeps({ observe: async () => { observes += 1; throw new Error("must not call"); } });
    const res = await driveSession(sess(id, 2), deps);
    assert.equal(res.outcome, "LEASE_LOST");
    assert.equal(observes, 0);
    assert.equal(existsSync(tracePath(id)), false);
    assert.equal(readDoc(id)["status"], "RUNNING");
  });
});

describe("production backend invariants (no synthetic path)", () => {
  it("the old PRNG observe/plan path is gone and cannot be imported", async () => {
    const mod = await import("../apps/worker/src/index.js") as Record<string, unknown>;
    for (const gone of ["observe", "plan", "pickBest", "nextTraceSeq", "prng"]) {
      assert.equal(mod[`${gone}`], undefined, `${gone} must not exist on the production worker`);
    }
  });

  it("rejects non-control-plane backends structurally", async () => {
    const id = "inv-kind";
    seedSession(id);
    const fake = { kind: "test-only", observe: async () => { throw new Error("no"); } };
    await assert.rejects(
      driveSession(sess(id), fake as unknown as ControlPlaneDeps),
      (err: unknown) => err instanceof WorkerStepError && err.code === "SYNTHETIC_BACKEND_REJECTED",
    );
  });

  it("refuses a control plane that answers synthetic:true (no act, FAILED)", async () => {
    const id = "inv-synth";
    seedSession(id, { maxSteps: 4 });
    let acts = 0;
    const deps = stubDeps({
      observe: async (_sid, n) => ({ frameId: `f-${n}`, width: 1920, height: 1080, regions: [], synthetic: true }),
      act: async () => { acts += 1; throw new Error("must not act"); },
    });
    const res = await driveSession(sess(id, 4), deps);
    assert.equal(res.outcome, "SYNTHETIC_REFUSED");
    assert.equal(acts, 0);
    assert.equal(existsSync(tracePath(id)), false);
    const doc = readDoc(id);
    assert.equal(doc["status"], "FAILED");
    assert.equal(doc["reason"], "synthetic-backend-refused");
  });

  it("fails closed after consecutive perception failures (never synthesizes)", async () => {
    const id = "inv-percept";
    seedSession(id, { maxSteps: 10 });
    const deps = stubDeps({
      observe: async () => { throw new WorkerStepError("PERCEPT_FAILED", "observe down"); },
    });
    const res = await driveSession(sess(id, 10), deps);
    assert.equal(res.outcome, "PERCEPT_FAILED");
    assert.equal(existsSync(tracePath(id)), false);
    const doc = readDoc(id);
    assert.equal(doc["status"], "FAILED");
    assert.equal(doc["reason"], "percept-unavailable");
  });

  it("marks the session FAILED when the VM is lost (never a stale RUNNING)", async () => {
    const id = "inv-vmlost";
    seedSession(id, { maxSteps: 10 });
    const deps = stubDeps({
      observe: async () => { throw new WorkerStepError("VM_LOST", "guest gone"); },
    });
    const res = await driveSession(sess(id, 10), deps);
    assert.equal(res.outcome, "VM_LOST");
    assert.equal(readDoc(id)["status"], "FAILED");
    assert.equal(readDoc(id)["reason"], "vm-lost");
  });

  it("recovers from one stale frame by re-observing (bounded)", async () => {
    const id = "inv-stale";
    seedSession(id, { maxSteps: 2 });
    let acts = 0;
    const deps = stubDeps({
      act: async (_sid, _a, frameId) => {
        acts += 1;
        if (acts === 1) throw new WorkerStepError("STALE_PERCEPTION", "stale");
        return { seq: 0, frameId: `${frameId}-after`, terminated: false, synthetic: false };
      },
    });
    const res = await driveSession(sess(id, 2), deps);
    assert.equal(res.outcome, "BUDGET_EXHAUSTED");
    assert.equal(res.steps, 2);
    assert.ok(acts >= 3);
  });

  it("records model provenance verbatim, including degraded:true", async () => {
    const id = "inv-prov";
    seedSession(id, { maxSteps: 1 });
    const deps = stubDeps({
      suggest: async (_sid, frame) => ({
        action: { type: "wait", confidence: 0.4 },
        frameId: frame.frameId, modelId: "heuristic-v1", degraded: true, latencyMs: 3,
      }),
    });
    const res = await driveSession(sess(id, 1), deps);
    assert.equal(res.outcome, "BUDGET_EXHAUSTED");
    const doc = readDoc(id)["workerModel"] as Record<string, unknown>;
    assert.equal(doc["model_id"], "heuristic-v1");
    assert.equal(doc["degraded"], true);
  });

  it("runSessionToCompletion uses the live control plane (unreachable → PERCEPT_FAILED)", async () => {
    const id = "inv-live";
    seedSession(id, { maxSteps: 10 });
    process.env["EVEX_API_URL"] = "http://127.0.0.1:1";
    try {
      const res = await runSessionToCompletion(sess(id, 10));
      assert.equal(res.outcome, "PERCEPT_FAILED");
      assert.equal(existsSync(tracePath(id)), false);
    } finally {
      delete process.env["EVEX_API_URL"];
    }
  });
});
