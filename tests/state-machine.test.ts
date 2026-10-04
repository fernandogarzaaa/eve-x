import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StateMachine, VM_TRANSITIONS, EveError } from "../packages/core/src/index.js";
import { SESSION_SM, isVmLostCode } from "../apps/api/src/index.js";

function vmMachine(initial = "CREATING"): StateMachine<string> {
  return new StateMachine<string>(initial, VM_TRANSITIONS as Record<string, string[]>);
}

describe("vm state machine", () => {
  it("walks the happy path CREATING -> RUNNING -> STOPPED", () => {
    const m = vmMachine();
    m.transition("CREATED", "provisioned");
    m.transition("BOOTING", "boot requested");
    m.transition("READY", "guest agent online");
    m.transition("RUNNING", "task started");
    m.transition("STOPPING", "task done");
    m.transition("STOPPED", "halted");
    assert.equal(m.state, "STOPPED");
    assert.equal(m.log.length, 6);
  });

  it("rejects illegal jumps with INVALID_TRANSITION", () => {
    const m = vmMachine();
    assert.throws(() => m.transition("RUNNING", "skip boot"), (e: unknown) => {
      return e instanceof EveError && e.code === "INVALID_TRANSITION";
    });
    assert.equal(m.state, "CREATING");
  });

  it("supports pause/resume and restore branches", () => {
    const m = vmMachine("RUNNING");
    m.transition("PAUSING", "operator pause");
    m.transition("PAUSED", "paused");
    assert.ok(m.can("RUNNING"));
    assert.ok(!m.can("BOOTING"));
    m.transition("RUNNING", "resume");
    m.transition("RESTORING", "snapshot restore");
    m.transition("RUNNING", "restored");
    assert.equal(m.state, "RUNNING");
  });

  it("FAILED only exits via DESTROYING or CREATING", () => {
    const m = vmMachine("RUNNING");
    m.transition("FAILED", "qemu died");
    assert.ok(m.can("DESTROYING"));
    assert.ok(m.can("CREATING"));
    assert.ok(!m.can("RUNNING"));
  });

  it("fail-closed: every non-terminal state can reach FAILED", () => {
    for (const from of ["CREATING", "CREATED", "BOOTING", "READY", "RUNNING", "PAUSING", "PAUSED", "RESTORING", "FORKING", "STOPPING", "STOPPED"]) {
      const m = vmMachine(from);
      assert.ok(m.can("FAILED"), `${from} must reach FAILED (fail-closed invariant)`);
      m.transition("FAILED", "command-phase failure");
      assert.equal(m.state, "FAILED");
    }
  });

  it("DESTROYED is terminal", () => {
    const m = vmMachine("DESTROYING");
    m.transition("DESTROYED", "reaped");
    assert.deepEqual(m.can("CREATING"), false);
    assert.throws(() => m.transition("CREATING", "nope"));
  });
});

describe("session state machine (no stale RUNNING)", () => {
  it("RUNNING reaches FAILED; FAILED recovers to STOPPED/RUNNING only", () => {
    const m = new StateMachine<string>("RUNNING", SESSION_SM);
    assert.ok(m.can("FAILED"), "RUNNING must reach FAILED when the VM dies");
    m.transition("FAILED", "vm lost");
    assert.equal(m.state, "FAILED");
    assert.ok(!m.can("PAUSED"), "FAILED must not pause");
    m.transition("STOPPED", "operator cleanup");
    assert.equal(m.state, "STOPPED");
  });

  it("isVmLostCode admits only dead-VM signals", () => {
    for (const c of ["QMP_CLOSED", "VM_NOT_RUNNING", "VM_NOT_FOUND"]) {
      assert.equal(isVmLostCode(c), true, `${c} must mark the session FAILED`);
    }
    for (const c of ["STALE_PERCEPTION", "ACTUATION_FAILED", "UNSUPPORTED", "observe_failed", "", undefined, null, 42]) {
      assert.equal(isVmLostCode(c), false, `${String(c)} must NOT mark the session FAILED`);
    }
  });
});
