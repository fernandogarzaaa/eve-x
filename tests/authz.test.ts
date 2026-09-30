import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Capability } from "../packages/protocol/src/index.js";

// Local capability check: every control-plane operation maps to a required
// capability; admin implies all. Mirrors the api authz middleware contract.
const NEED: Record<string, string[]> = {
  "vm.create": ["vm:create"],
  "vm.control": ["vm:control"],
  "vm.destroy": ["vm:destroy"],
  "computer.observe": ["computer:observe"],
  "computer.act": ["computer:act"],
  "human.takeover": ["human:takeover"],
  "trace.read": ["trace:read"],
  "trace.export": ["trace:export"],
  "model.invoke": ["model:invoke"],
  "task.execute": ["task:execute"],
};

function authorize(granted: string[], operation: string): boolean {
  if (!(operation in NEED)) return false;
  const caps = granted.map((c) => Capability.parse(c));
  if (caps.includes("admin")) return true;
  const required = NEED[operation] as string[];
  return required.every((r) => caps.includes(r as (typeof caps)[number]));
}

describe("authz capabilities", () => {
  it("grants exactly the held capability", () => {
    assert.equal(authorize(["vm:create"], "vm.create"), true);
    assert.equal(authorize(["vm:create"], "vm.destroy"), false);
  });

  it("admin implies every operation", () => {
    for (const op of Object.keys(NEED)) {
      assert.equal(authorize(["admin"], op), true);
    }
  });

  it("denies unknown operations by default", () => {
    assert.equal(authorize(["vm:create"], "nope.does-not-exist"), false);
  });

  it("rejects malformed capability strings", () => {
    assert.throws(() => authorize(["root:all"], "vm.create"));
  });

  it("empty grant set denies everything except nothing", () => {
    assert.equal(authorize([], "trace.read"), false);
    assert.equal(authorize(["trace:read"], "trace.read"), true);
    assert.equal(authorize(["trace:read"], "trace.export"), false);
  });
});
