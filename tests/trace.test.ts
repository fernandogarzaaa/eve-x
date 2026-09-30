import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraceStep } from "../packages/protocol/src/index.js";
import { nowIso, uid } from "../packages/core/src/index.js";

// Minimal append-only trace store: append validates against TraceStep,
// export serializes deterministic JSONL. Mirrors the control-plane ledger.
interface StoredStep { seq: number; step: unknown; digest: string; }

function digestOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

class TraceStore {
  private steps: StoredStep[] = [];
  append(raw: unknown): number {
    const parsed = TraceStep.parse(raw);
    const seq = this.steps.length;
    if (parsed.seq !== seq) throw new Error(`Out-of-order append: got seq ${parsed.seq}, want ${seq}`);
    const digest = digestOf(JSON.stringify(parsed));
    this.steps.push({ seq, step: parsed, digest });
    return seq;
  }
  len(): number { return this.steps.length; }
  exportJsonl(): string {
    return this.steps.map((s) => JSON.stringify({ ...s.step as Record<string, unknown>, _digest: s.digest })).join("\n") + (this.steps.length > 0 ? "\n" : "");
  }
  digests(): string[] { return this.steps.map((s) => s.digest); }
}

function makeStep(seq: number, session: string): unknown {
  return {
    session_id: session,
    task_id: "task-1",
    step_id: uid("step"),
    seq,
    timestamp: nowIso(),
    actor: "eve-agent",
    vm_state_before: "RUNNING",
    screen_before: "frame-1",
    goal: "open the settings app",
    candidate_actions: [{ type: "observe", confidence: 0.9 }],
    provenance: { source: "screenshot", channel: "vnc", at: nowIso() },
    model_version: "model-test",
    environment_version: "env-1",
  };
}

describe("trace append/export", () => {
  it("appends validated steps in order", () => {
    const store = new TraceStore();
    const session = uid("sess");
    store.append(makeStep(0, session));
    store.append(makeStep(1, session));
    assert.equal(store.len(), 2);
  });

  it("rejects out-of-order seq", () => {
    const store = new TraceStore();
    const session = uid("sess");
    store.append(makeStep(0, session));
    assert.throws(() => store.append(makeStep(5, session)), /Out-of-order/);
  });

  it("rejects schema-invalid steps", () => {
    const store = new TraceStore();
    assert.throws(() => store.append({ nonsense: true }));
  });

  it("exports deterministic JSONL with per-step digests", () => {
    const store = new TraceStore();
    const session = uid("sess");
    store.append(makeStep(0, session));
    store.append(makeStep(1, session));
    const a = store.exportJsonl();
    const store2 = new TraceStore();
    // Re-appending parsed lines reproduces identical digests.
    for (const line of a.trim().split("\n")) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      delete obj["_digest"];
      const seq = obj["seq"];
      assert.equal(typeof seq, "number");
      store2.append(obj);
    }
    assert.deepEqual(store2.digests(), store.digests());
  });
});
