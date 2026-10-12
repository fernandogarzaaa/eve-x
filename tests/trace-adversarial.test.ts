import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraceStore } from "../packages/traces/src/index.js";
import { TimelinePlayer } from "../packages/replay/src/index.js";
import { verifyReplay } from "../apps/api/src/index.js";

// Trace adversarial semantics: splice/insert/truncate/duplicate,
// cross-session injection and merge, truncated-prefix limitation with its
// expected-count mitigation, and cross-session evidence refusal.

function step(sid: string, seq: number, extra: Record<string, unknown> = {}) {
  return {
    session_id: sid, task_id: "t", step_id: `step-${seq}`, seq,
    timestamp: new Date().toISOString(), actor: "eve-agent" as const,
    vm_state_before: "RUNNING", screen_before: `f-${seq}`,
    goal: "g", candidate_actions: [], human_intervention: false,
    provenance: { source: "system" as const, channel: "t", at: new Date().toISOString() },
    model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
    ...extra,
  };
}

function chainedStore(sid: string, n: number): TraceStore {
  const store = new TraceStore(sid, "t");
  for (let i = 0; i < n; i += 1) store.append(step(sid, i));
  return store;
}

/** EveError carries its machine code on .code, not in the message —
 *  so match the code explicitly instead of assert.throws(/CODE/). */
function assertEveCode(fn: () => unknown, code: string | RegExp): void {
  try {
    fn();
  } catch (err) {
    const errCode = String((err as { code?: unknown })?.code ?? "");
    const text = `${errCode} ${err instanceof Error ? err.message : String(err)}`;
    assert.match(text, typeof code === "string" ? new RegExp(code) : code);
    return;
  }
  assert.fail(`expected throw with code ${String(code)}`);
}

describe("TraceStore tamper classes", () => {
  it("rejects cross-session injection", () => {
    const store = new TraceStore("sess-a", "t");
    store.append(step("sess-a", 0));
    assertEveCode(() => store.append(step("sess-b", 1)), "SESSION_MISMATCH");
  });

  it("rejects gapped appends (splice/insert shape)", () => {
    const store = new TraceStore("s", "t");
    store.append(step("s", 0));
    assertEveCode(() => store.append(step("s", 2)), "SEQ_GAP");
    assertEveCode(() => store.append(step("s", 0)), "SEQ_GAP");
  });

  it("spliced JSONL (dropped middle) fails reload", () => {
    const store = chainedStore("s", 4);
    const lines = store.exportJsonl().split("\n").filter((l) => l.trim().length > 0);
    const spliced = [lines[0], lines[2], lines[3]].join("\n") + "\n";
    assertEveCode(() => TraceStore.fromJsonl("s", "t", spliced), /SEQ_GAP|CHAIN_BROKEN/);
  });

  it("mutated body breaks the chain on reload", () => {
    const store = chainedStore("s", 3);
    const lines = store.exportJsonl().split("\n").filter((l) => l.trim().length > 0);
    const mid = JSON.parse(lines[1] as string) as Record<string, unknown>;
    mid["outcome"] = "goal-achieved";
    lines[1] = JSON.stringify(mid);
    assertEveCode(() => TraceStore.fromJsonl("s", "t", lines.join("\n") + "\n"), "CHAIN_BROKEN");
  });

  it("truncated prefix verifies — callers must check expected counts", () => {
    const store = chainedStore("s", 4);
    const lines = store.exportJsonl().split("\n").filter((l) => l.trim().length > 0);
    const prefix = lines.slice(0, 2).join("\n") + "\n";
    // The prefix alone is chain-valid: truncation is invisible here.
    const partial = TraceStore.fromJsonl("s", "t", prefix);
    assert.equal(partial.count(), 2);
    // The mitigation: verifyReplay with an expected count flags the shortfall.
    const steps = partial.list() as unknown as Array<Record<string, unknown>>;
    const r = verifyReplay(steps, 4);
    assert.equal(r.verdict, "replay-divergent");
    assert.ok(r.issues.some((i) => i.includes("truncated")));
    const ok = verifyReplay(steps, 2);
    assert.equal(ok.verdict, "deterministic-replay-ok");
  });
});

describe("TimelinePlayer adversarial loads", () => {
  it("rejects merged sessions (SESSION_SPLIT)", () => {
    const a = chainedStore("sess-a", 2).exportJsonl();
    const b = chainedStore("sess-b", 2).exportJsonl();
    const player = new TimelinePlayer();
    assertEveCode(() => player.loadJsonl(a + b), "SESSION_SPLIT");
  });

  it("rejects mutated stored digests", () => {
    const store = chainedStore("s", 2);
    const lines = store.exportJsonl().split("\n").filter((l) => l.trim().length > 0);
    const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
    first["digest"] = "0".repeat(64);
    lines[0] = JSON.stringify(first);
    const player = new TimelinePlayer();
    assertEveCode(() => player.loadJsonl(lines.join("\n") + "\n"), "CHAIN_BROKEN");
  });

  it("fork preserves parent session identity on the copied prefix", () => {
    const store = chainedStore("sess-p", 3);
    const player = new TimelinePlayer();
    player.loadJsonl(store.exportJsonl());
    const { child, link } = player.fork("sess-c", 1);
    assert.equal(link.parentSessionId, "sess-p");
    assert.equal(link.childSessionId, "sess-c");
    assert.equal(child.length, 2);
  });
});
