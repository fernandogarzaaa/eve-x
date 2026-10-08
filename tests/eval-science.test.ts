import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runBench,
  evaluateBenchTask,
  wilsonCI,
  BenchAgentResultSchema,
  buildRegistry,
  type BenchTask,
  type BenchAgentResult,
} from "../packages/benchmarks/src/index.js";
import { scoreExperience } from "../packages/evaluation/src/index.js";

// Evaluation science: pathological fixtures proving metrics cannot be
// gamed by empty, tiny, or unmeasured inputs. Every guilty default from
// the math audit is pinned here — as nulls, refusals, or labeled rates.

function task(partial: Partial<BenchTask> = {}): BenchTask {
  return {
    benchTaskId: "bench-terminal-cli-1",
    category: "terminal-cli",
    goal: "List processes via terminal and report the count",
    successSignals: ["processes", "complete"],
    split: "test",
    seed: 1001,
    maxSteps: 40,
    stepsOptimal: 8,
    ...partial,
  };
}

function result(partial: Partial<BenchAgentResult> = {}): BenchAgentResult {
  return BenchAgentResultSchema.parse({
    verdict: "failure", success: false,
    actionSuccesses: 0, actionTotal: 1, groundedCorrect: 0, groundedTotal: 0,
    stepsUsed: 1, predictionsCorrect: 0, predictionsTotal: 0,
    recovered: 0, recoveryOpportunities: 0, humanAgreements: 0, humanJudged: 0,
    unsafe: false, takeover: false, latenciesMs: [100], steps: [],
    evidenceDigests: [], agentIdentity: "test", modelIdentity: null,
    ...partial,
  });
}


describe("H1: success without executed evidence is refused", () => {
  it("runBench rejects success verdicts with empty steps/evidence", async () => {
    const registry = [task()];
    await assert.rejects(
      runBench(registry, async () => result({ verdict: "success", success: true, steps: [], evidenceDigests: [], actionTotal: 0 }), { splits: ["test"] }),
      /executed evidence/,
    );
  });

  it("schema rejects numerator/denominator inversions", () => {
    assert.throws(() => result({ groundedCorrect: 3, groundedTotal: 2 }), /groundedCorrect/);
    assert.throws(() => result({ actionSuccesses: 2, actionTotal: 1 }), /actionSuccesses/);
    assert.throws(() => result({ recovered: 2, recoveryOpportunities: 1 }), /recovered/);
  });
});

describe("H2: unmeasured capabilities report null, never 1.0", () => {
  it("empty trajectory aggregates to nulls (not perfect scores)", async () => {
    const rec = await runBench([task()], async () => result({ verdict: "inconclusive", steps: [] }), { splits: ["test"], runId: "h2" });
    assert.equal(rec.metrics.recoveryRate, null);
    assert.equal(rec.metrics.humanAgreementRate, null);
    assert.equal(rec.metrics.predictionAccuracy, null);
    assert.equal(rec.metrics.taskSuccessRate, 0);
  });
});

describe("H5: efficiency is optimal-aware and success-conditioned", () => {
  it("failing fast scores 0, not 1.0", async () => {
    const rec = await runBench([task()], async () => result({ verdict: "failure", stepsUsed: 1 }), { splits: ["test"], runId: "h5a" });
    assert.equal(rec.metrics.stepEfficiency, 0);
  });

  it("equal steps with different optimals score differently", async () => {
    const mk = (optimal: number) => result({ verdict: "success", success: true, stepsUsed: 8, stepsOptimal: optimal, actionTotal: 8, actionSuccesses: 8, steps: [stepFixture()], evidenceDigests: ["d"] });
    const a = await runBench([task()], async () => mk(5), { splits: ["test"], runId: "h5b" });
    const b = await runBench([task()], async () => mk(15), { splits: ["test"], runId: "h5c" });
    assert.ok((a.metrics.stepEfficiency as number) < (b.metrics.stepEfficiency as number),
      `optimal 5@${(a.metrics.stepEfficiency as number)} must score below optimal 15@${(b.metrics.stepEfficiency as number)} for 8 used steps`);
  });
});

function stepFixture() {
  return {
    session_id: "s", task_id: "t", step_id: "step-0", seq: 0,
    timestamp: new Date().toISOString(), actor: "eve-agent" as const,
    vm_state_before: "RUNNING", screen_before: "f-0",
    goal: "g", candidate_actions: [], human_intervention: false,
    provenance: { source: "system" as const, channel: "t", at: new Date().toISOString() },
    model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
  };
}

describe("M6: safety rates cannot be diluted by invalid tasks", () => {
  it("executed-basis rate exposes real unsafety", async () => {
    const rec = await runBench(
      [task({ benchTaskId: "real" }), task({ benchTaskId: "i1" }), task({ benchTaskId: "i2" }), task({ benchTaskId: "i3" })],
      async (t) => t.benchTaskId === "real"
        ? result({ verdict: "failure", unsafe: true })
        : result({ verdict: "invalid" }),
      { splits: ["test"], runId: "m6" },
    );
    assert.equal(rec.metrics.unsafeRate, 0.25);
    assert.equal(rec.metrics.unsafeRateExecuted, 1.0);
  });
});

describe("M7 + L11: small samples and malformed counts", () => {
  it("smallN flags runs under 5 tasks", async () => {
    const rec = await runBench([task()], async () => result(), { splits: ["test"], runId: "m7" });
    assert.equal(rec.metrics.smallN, true);
    assert.ok(rec.metrics.taskSuccessCI.hi - rec.metrics.taskSuccessCI.lo > 0.5, "interval must show the uncertainty");
  });

  it("wilsonCI throws on successes > trials", () => {
    try {
      wilsonCI(5, 3);
      assert.fail("expected BAD_COUNTS");
    } catch (err) {
      assert.equal((err as { code?: string }).code, "BAD_COUNTS");
    }
    assert.deepEqual(wilsonCI(0, 0), { lo: 0, hi: 0 });
  });
});

describe("H4: grades cannot mask task failure", () => {
  it("clean failure trajectory grades D or worse", () => {
    const steps = Array.from({ length: 10 }, (_, i) => ({
      session_id: "s", task_id: "t", step_id: `step-${i}`, seq: i,
      timestamp: new Date().toISOString(), actor: "eve-agent" as const,
      vm_state_before: "RUNNING", screen_before: `f-${i}`,
      goal: "open settings", candidate_actions: [],
      selected_action: { type: "wait" as const, confidence: 0.5 },
      prediction: "waiting advances toward open settings",
      screen_after: `f-${i + 1}`, outcome: "action failed",
      latency_ms: 200, trust: 0.4, cognitive_load: 0.5, human_intervention: false,
      provenance: { source: "system" as const, channel: "t", at: new Date().toISOString() },
      model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
    }));
    const rep = scoreExperience(steps, { sessionId: "s", taskId: "t" });
    const taskFinding = rep.findings.find((f) => f.dimension === "task_success");
    assert.ok((taskFinding?.score ?? 100) < 50, `task_success must be low, got ${taskFinding?.score}`);
    assert.ok(rep.grade === "D" || rep.grade === "F", `grade must cap at D, got ${rep.grade} (overall ${rep.overall})`);
  });
});

describe("grounding basis is labeled per system", () => {
  it("benchmark metrics tag pointer-step grounding", async () => {
    const rec = await runBench([task()], async () => result(), { splits: ["test"], runId: "m9" });
    assert.equal(rec.metrics.groundingBasis, "pointer-step");
  });

  it("evaluator results carry the task optimal through", () => {
    const r = evaluateBenchTask({
      task: task({ stepsOptimal: 12 }), steps: [], evidenceDigests: [],
      agentIdentity: "evex-real-agent", modelIdentity: null,
    });
    assert.equal(r.verdict, "inconclusive");
  });
});
