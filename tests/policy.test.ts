import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskSpec } from "../packages/protocol/src/index.js";

// Local policy gate: mirrors the control-plane enforcement — destructive,
// external-comms, and credential actions need explicit opt-in; everything in
// requireApprovalFor escalates instead of executing.
const DESTRUCTIVE = new Set(["destroy", "shutdown", "reboot", "snapshot", "restore", "fork"]);
const COMMS = new Set(["tool", "open_application", "terminal"]);
const CREDENTIAL_HINTS = ["password", "login", "sign in", "credential", "token"];

interface GateInput { actionType: string; goal: string; task: unknown; }

function gate(input: GateInput): { decision: "allow" | "deny" | "escalate"; reason: string } {
  const task = TaskSpec.parse(input.task);
  const goalLower = input.goal.toLowerCase();
  if (DESTRUCTIVE.has(input.actionType) && !task.policy.allowDestructive) {
    return { decision: "deny", reason: "destructive action without allowDestructive" };
  }
  if (COMMS.has(input.actionType) && !task.policy.allowExternalComms) {
    return { decision: "deny", reason: "external-comms action without allowExternalComms" };
  }
  if (CREDENTIAL_HINTS.some((h) => goalLower.includes(h)) && !task.policy.allowCredentialUse) {
    return { decision: "deny", reason: "credential-adjacent goal without allowCredentialUse" };
  }
  const approvals = task.policy.requireApprovalFor;
  if (approvals.includes("destructive") && DESTRUCTIVE.has(input.actionType)) {
    return { decision: "escalate", reason: "destructive action requires approval" };
  }
  return { decision: "allow", reason: "within policy" };
}

function baseTask(): unknown {
  return {
    taskId: "t-1",
    goal: "open settings",
    vm: { image: "ubuntu-desktop-v1" },
    policy: {
      allowDestructive: false,
      allowExternalComms: false,
      allowCredentialUse: false,
      requireApprovalFor: ["destructive", "purchase", "data-export"],
    },
  };
}

describe("policy denial", () => {
  it("denies destructive ops by default", () => {
    const d = gate({ actionType: "destroy", goal: "clean up", task: baseTask() });
    assert.equal(d.decision, "deny");
  });

  it("allows benign observe/click actions", () => {
    const d = gate({ actionType: "click", goal: "open settings", task: baseTask() } as GateInput);
    // click is not in the comms/destructive sets: allowed.
    assert.equal(d.decision, "allow");
  });

  it("denies terminal use without comms opt-in", () => {
    const d = gate({ actionType: "terminal", goal: "list files", task: baseTask() });
    assert.equal(d.decision, "deny");
  });

  it("denies credential-adjacent goals without credential opt-in", () => {
    const t = baseTask() as Record<string, Record<string, boolean>>;
    (t["policy"] as Record<string, boolean>)["allowExternalComms"] = true;
    const d = gate({ actionType: "type", goal: "enter password", task: t });
    assert.equal(d.decision, "deny");
  });

  it("escalates approved-category destructive actions when opted in", () => {
    const t = baseTask() as { policy: Record<string, unknown> };
    t.policy["allowDestructive"] = true;
    const d = gate({ actionType: "reboot", goal: "restart guest", task: t });
    assert.equal(d.decision, "escalate");
  });
});
