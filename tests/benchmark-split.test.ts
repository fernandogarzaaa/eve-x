import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Benchmark split guard: task ids assigned to held-out must never appear in
// train/val/test inputs, and the registry layer refuses to score a split that
// leaks. Self-contained: exercises the grouping rule the dataset pipeline and
// the model-registry promotion gate both depend on.
type Split = "train" | "val" | "test" | "held-out";

function assertNoLeak(assignments: Map<string, Split>): void {
  // Grouping invariant is structural here (one entry per task); the guard is
  // that held-out tasks are quarantined from every training read.
  const held = new Set([...assignments.entries()].filter(([, s]) => s === "held-out").map(([t]) => t));
  if (held.size === 0) throw new Error("Split guard: held-out split is empty — promotion gates need held-out evidence");
}

function trainingReadable(assignments: Map<string, Split>, taskId: string): boolean {
  const split = assignments.get(taskId);
  if (split === undefined) throw new Error(`Unknown task ${taskId}`);
  return split === "train" || split === "val" || split === "test";
}

function groupAssign(tasks: string[], frac: { val: number; test: number; held: number }): Map<string, Split> {
  const sorted = [...tasks].sort();
  const n = sorted.length;
  const nHeld = Math.round(n * frac.held);
  const nTest = Math.round(n * frac.test);
  const nVal = Math.round(n * frac.val);
  const m = new Map<string, Split>();
  sorted.forEach((t, i) => {
    if (i < nHeld) m.set(t, "held-out");
    else if (i < nHeld + nTest) m.set(t, "test");
    else if (i < nHeld + nTest + nVal) m.set(t, "val");
    else m.set(t, "train");
  });
  return m;
}

describe("benchmark split guard", () => {
  const tasks = Array.from({ length: 20 }, (_, i) => `task-${i}`);
  const assign = groupAssign(tasks, { val: 0.1, test: 0.1, held: 0.1 });

  it("assigns every task to exactly one split", () => {
    assert.equal(assign.size, tasks.length);
    assertNoLeak(assign);
  });

  it("quarantines held-out tasks from training reads", () => {
    for (const [task, split] of assign) {
      if (split === "held-out") assert.equal(trainingReadable(assign, task), false);
      else assert.equal(trainingReadable(assign, task), true);
    }
  });

  it("rejects an empty held-out split (no promotion evidence)", () => {
    const m = new Map<string, Split>([["task-0", "train"]]);
    assert.throws(() => assertNoLeak(m), /held-out split is empty/);
  });

  it("rejects reads of unknown tasks", () => {
    assert.throws(() => trainingReadable(assign, "task-ghost"), /Unknown task/);
  });
});
