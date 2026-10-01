import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKER_ID,
  controlPath,
  heartbeat,
  leasePath,
  observe,
  plan,
  recordCrash,
  runSessionToCompletion,
  tryAcquire,
} from "../apps/worker/src/index.js";

// Worker behavior tests: exercise the worker's pure, side-effect-free exports
// against a fresh temp DATA_DIR for this test file run (no daemon, no TTL).
const DATA = mkdtempSync(join(tmpdir(), "evex-worker-test-"));
process.env["DATA_DIR"] = DATA;

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

function traceFile(id: string): string {
  return join(DATA, "objects", "traces", `${san(id)}.jsonl`);
}

function traceLines(id: string): Array<Record<string, unknown>> {
  const p = traceFile(id);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function writeTrace(id: string, steps: Array<Record<string, unknown>>): void {
  mkdirSync(join(DATA, "objects", "traces"), { recursive: true });
  writeFileSync(traceFile(id), steps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
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
  it("stops with HUMAN_CONTROL and appends zero act steps", () => {
    const id = "w2-takeover";
    seedSession(id, { seed: 7, maxSteps: 5 });
    writeControl(id, { humanControl: true });
    const res = runSessionToCompletion({ id, goal: "open the settings app", status: "RUNNING", seed: 7, maxSteps: 5 });
    assert.equal(res.outcome, "HUMAN_CONTROL");
    assert.equal(traceLines(id).length, 0);
    assert.equal(readDoc(id)["status"], "HUMAN_CONTROL");
  });

  it("stops with PAUSED and appends zero act steps", () => {
    const id = "w2-paused";
    seedSession(id, { seed: 7, maxSteps: 5 });
    writeControl(id, { paused: true });
    const res = runSessionToCompletion({ id, goal: "open the settings app", status: "RUNNING", seed: 7, maxSteps: 5 });
    assert.equal(res.outcome, "PAUSED");
    assert.equal(traceLines(id).length, 0);
    assert.equal(readDoc(id)["status"], "PAUSED");
  });
});

describe("W3: no fabricated success", () => {
  it("exhausts budget without any goal-achieved step", () => {
    const id = "w3-budget";
    seedSession(id, { seed: 99, maxSteps: 2 });
    const res = runSessionToCompletion({ id, goal: "open the settings app", status: "RUNNING", seed: 99, maxSteps: 2 });
    assert.equal(res.outcome, "BUDGET_EXHAUSTED");
    const steps = traceLines(id);
    assert.equal(steps.length, 2);
    for (const s of steps) assert.equal(s["outcome"], "acted");
    const raw = readFileSync(traceFile(id), "utf8");
    assert.ok(!raw.includes("goal-achieved") && !raw.includes("GOAL_ACHIEVED"));
    assert.equal(readDoc(id)["status"], "BUDGET_EXHAUSTED");
  });

  it("external completion marker ends the rollout as DONE", () => {
    const id = "w3-complete";
    seedSession(id, { seed: 9, maxSteps: 5 });
    writeControl(id, { complete: true });
    const res = runSessionToCompletion({ id, goal: "open the settings app", status: "RUNNING", seed: 9, maxSteps: 5 });
    assert.equal(res.outcome, "ROLLOUT_COMPLETE");
    assert.equal(readDoc(id)["status"], "DONE");
    const steps = traceLines(id);
    assert.ok(steps.length >= 1);
    assert.equal(steps[steps.length - 1]?.["outcome"], "rollout-complete");
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

describe("W7: seq continuity and lease-gated appends", () => {
  it("continues from max(line count, max seq + 1) with no duplicates", () => {
    const id = "w7-seq";
    writeTrace(id, [0, 1, 2].map((seq) => ({ session_id: id, step_id: `pre-${seq}`, seq, outcome: "acted" })));
    seedSession(id, { seed: 5, maxSteps: 2 });
    const res = runSessionToCompletion({ id, goal: "open the settings app", status: "RUNNING", seed: 5, maxSteps: 2 });
    assert.equal(res.outcome, "BUDGET_EXHAUSTED");
    const seqs = traceLines(id).map((s) => s["seq"]);
    assert.deepEqual(seqs, [0, 1, 2, 3, 4]);
    assert.equal(new Set(seqs).size, seqs.length);
  });

  it("aborts without appending when the lease is held by another worker", () => {
    const id = "w7-leaselost";
    seedSession(id, { seed: 3, maxSteps: 2 });
    writeLease(id, { worker: "someone-else", at: nowIso(), ttlMs: 60000 });
    const res = runSessionToCompletion({ id, goal: "open the settings app", status: "RUNNING", seed: 3, maxSteps: 2 });
    assert.equal(res.outcome, "LEASE_LOST");
    assert.equal(traceLines(id).length, 0);
    assert.equal(readDoc(id)["status"], "RUNNING");
  });
});

describe("W4 + determinism: grounding and seeded perception", () => {
  it("carries the observed region bbox into the candidate target", () => {
    const percept = observe(11, 0);
    const regions = percept["regions"] as Array<{ regionId: string; bbox: unknown }>;
    const cands = plan("open the settings app", percept, 11, 0);
    assert.ok(cands.length > 0);
    for (const c of cands) {
      const t = c["target"] as { regionId?: string; bbox?: unknown } | undefined;
      if (t?.regionId !== undefined) {
        const src = regions.find((r) => r.regionId === t.regionId);
        if (!src) assert.fail(`candidate references unknown region ${t.regionId}`);
        assert.deepEqual(t.bbox, src.bbox);
      }
    }
  });

  it("same seed produces the same candidate regionIds", () => {
    const idsOf = (seed: number, seq: number): string[] =>
      (observe(seed, seq)["regions"] as Array<{ regionId: string }>).map((r) => r.regionId);
    assert.deepEqual(idsOf(42, 3), idsOf(42, 3));
  });
});
