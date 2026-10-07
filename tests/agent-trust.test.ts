import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EveCuaAgent, type ComputerRuntimeLike } from "../packages/agent/src/index.js";

// Agent verdicts must come from evidence (explicit successSignals on
// non-failed steps), never from outcome prose. A guest shouting "success"
// or "advanced" at the agent must not inflate trust or flip success.

function percept() {
  return {
    frameId: "frame-test-1", width: 1280, height: 800, pngBase64: "",
    regions: [], cursor: { x: 100, y: 100 },
    windows: ["desktop"], dialogs: [], loading: false,
    provenance: { source: "screenshot", channel: "test", at: new Date().toISOString() },
  };
}

function runtime(outcome: string): ComputerRuntimeLike {
  return {
    observe: async () => percept() as never,
    act: async () => ({
      screenAfter: "screen-after-1", vmStateAfter: "RUNNING",
      outcome, latencyMs: 5,
    }),
    currentVmState: () => "RUNNING",
  };
}

function agent() {
  return new EveCuaAgent({ agentId: "test-agent", maxSteps: 3, seed: 1 });
}

function task(signals: string[] = []) {
  return {
    taskId: "task-1", sessionId: "sess-1",
    goal: "open the settings panel",
    successSignals: signals, maxSteps: 3,
  };
}

describe("agent verdicts ignore outcome prose", () => {
  it("guest shouting success/advance does not flip success or trust", async () => {
    const res = await agent().execute(task([]), runtime("advanced success!! goal achieved"));
    assert.equal(res.success, false, "no successSignals hit: must not succeed");
    for (const s of res.steps) {
      assert.ok((s.trust ?? 1) <= 0.45, `trust must stay at baseline, got ${s.trust}`);
    }
  });

  it("explicit successSignals on a clean step succeed", async () => {
    const res = await agent().execute(task(["done-marker"]), runtime("finished done-marker cleanly"));
    assert.equal(res.success, true);
  });

  it("success signals on a failed step do not succeed", async () => {
    const res = await agent().execute(task(["done-marker"]), runtime("error: failed before done-marker"));
    assert.equal(res.success, false);
  });
});
