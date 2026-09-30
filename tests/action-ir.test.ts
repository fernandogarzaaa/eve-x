import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ActionIR } from "../packages/protocol/src/index.js";

const CLICK_BASE = {
  type: "click",
  to: { x: 100, y: 200 },
  confidence: 0.9,
} as const;

describe("action-IR validation", () => {
  it("accepts a well-formed click", () => {
    const r = ActionIR.safeParse({ ...CLICK_BASE });
    assert.equal(r.success, true);
  });

  it("rejects unknown action types", () => {
    const r = ActionIR.safeParse({ type: "rm_rf", confidence: 0.9 });
    assert.equal(r.success, false);
  });

  it("rejects confidence outside [0,1]", () => {
    assert.equal(ActionIR.safeParse({ ...CLICK_BASE, confidence: 1.5 }).success, false);
    assert.equal(ActionIR.safeParse({ ...CLICK_BASE, confidence: -0.1 }).success, false);
  });

  it("rejects oversized text payloads", () => {
    const r = ActionIR.safeParse({ type: "type", text: "x".repeat(5000), confidence: 0.8 });
    assert.equal(r.success, false);
  });

  it("rejects negative wait durations", () => {
    const r = ActionIR.safeParse({ type: "wait", ms: -5, confidence: 0.5 });
    assert.equal(r.success, false);
  });

  it("accepts key actions with bounded key lists", () => {
    const ok = ActionIR.safeParse({ type: "key", keys: ["ctrl", "c"], confidence: 0.7 });
    assert.equal(ok.success, true);
    const bad = ActionIR.safeParse({ type: "key", keys: ["a", "b", "c", "d", "e", "f", "g", "h", "i"], confidence: 0.7 });
    assert.equal(bad.success, false);
  });

  it("requires confidence on every action", () => {
    const r = ActionIR.safeParse({ type: "observe" });
    assert.equal(r.success, false);
  });
});
