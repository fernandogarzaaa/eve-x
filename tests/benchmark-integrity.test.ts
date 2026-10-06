import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildRegistry,
  runBench,
  evaluateBenchTask,
  mockAgentAdapter,
  wilsonCI,
  assertProductionRecord,
  type BenchTask,
} from "../packages/benchmarks/src/index.js";
import { buildApp, ensureOptionals, hydrateFromDisk, __clearMemory } from "../apps/api/src/index.js";

// Benchmark integrity: numbers must come from real executed trajectories
// scored by the IndependentEvaluator. Mock evidence is refused in
// production runs, stamped in harness runs, and inconclusive/invalid are
// counted — never coerced into success.

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

function step(seq: number, extra: Record<string, unknown> = {}) {
  return {
    session_id: "s", task_id: "t", step_id: `step-${seq}`, seq,
    timestamp: new Date().toISOString(), actor: "eve-agent" as const,
    vm_state_before: "RUNNING", screen_before: `f-${seq}`,
    goal: "g", candidate_actions: [],
    human_intervention: false,
    provenance: { source: "system" as const, channel: "t", at: new Date().toISOString() },
    model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
    ...extra,
  };
}

describe("mock refusal + stamping", () => {
  it("runBench refuses mock results in a production run", async () => {
    const registry = [task()];
    await assert.rejects(
      runBench(registry, mockAgentAdapter(7), { splits: ["test"] }),
      /refuse mock evidence/,
    );
  });

  it("runBench accepts mock results only with testOnly:true and stamps the record", async () => {
    const registry = [task()];
    const rec = await runBench(registry, mockAgentAdapter(7), { splits: ["test"], testOnly: true, runId: "r1" });
    assert.equal(rec.synthetic, true);
    assert.equal(rec.testOnly, true);
    assert.throws(() => assertProductionRecord(rec), /refusing production use/);
  });

  it("a clean production record passes the consumer guard", async () => {
    const registry = [task()];
    const rec = await runBench(
      registry,
      async () => ({
        verdict: "failure", success: false,
        actionSuccesses: 0, actionTotal: 1, groundedCorrect: 0, groundedTotal: 0,
        stepsUsed: 1, predictionsCorrect: 0, predictionsTotal: 0,
        recovered: 0, recoveryOpportunities: 0, humanAgreements: 0, humanJudged: 0,
        unsafe: false, takeover: false, latenciesMs: [], steps: [],
        evidenceDigests: [], agentIdentity: "real", modelIdentity: null,
      }),
      { splits: ["test"], runId: "r2" },
    );
    assert.equal(rec.synthetic, false);
    assertProductionRecord(rec);
  });
});

describe("IndependentEvaluator", () => {
  it("invalid when the backend is synthetic (counted, never scored)", () => {
    const r = evaluateBenchTask({
      task: task(), steps: [step(0)], evidenceDigests: [],
      agentIdentity: "evex-real-agent", modelIdentity: null, backendSynthetic: true,
    });
    assert.equal(r.verdict, "invalid");
    assert.equal(r.success, false);
  });

  it("inconclusive on an empty trajectory", () => {
    const r = evaluateBenchTask({
      task: task(), steps: [], evidenceDigests: [],
      agentIdentity: "evex-real-agent", modelIdentity: null,
    });
    assert.equal(r.verdict, "inconclusive");
  });

  it("success requires signals AND final verification-passed", () => {
    const steps = [
      step(0, { outcome: "acted", selected_action: { type: "click", confidence: 0.9 }, grounding: { verified: true } }),
      step(1, {
        outcome: "processes complete", selected_action: { type: "wait", confidence: 0.5 },
        verification: { passed: true, reason: "actuated" }, screen_after: "f-2",
      }),
    ];
    const r = evaluateBenchTask({
      task: task(), steps: steps as never, evidenceDigests: ["d"],
      agentIdentity: "evex-real-agent", modelIdentity: null,
    });
    assert.equal(r.verdict, "success");
    assert.equal(r.groundedCorrect, 1);
    assert.equal(r.groundedTotal, 1);
  });

  it("signals without verification are failure, not success", () => {
    const steps = [step(0, { outcome: "processes complete" })];
    const r = evaluateBenchTask({
      task: task(), steps: steps as never, evidenceDigests: [],
      agentIdentity: "evex-real-agent", modelIdentity: null,
    });
    assert.equal(r.verdict, "failure");
  });

  it("grounding credit is decision-point only (unverified pointers score 0)", () => {
    const steps = [
      step(0, { outcome: "acted", selected_action: { type: "click", confidence: 0.9 }, grounding: { verified: false, reason: "no region" } }),
      step(1, { outcome: "acted", selected_action: { type: "click", confidence: 0.9 }, grounding: { verified: true } }),
    ];
    const r = evaluateBenchTask({
      task: task(), steps: steps as never, evidenceDigests: [],
      agentIdentity: "evex-real-agent", modelIdentity: null,
    });
    assert.equal(r.groundedCorrect, 1);
    assert.equal(r.groundedTotal, 2);
  });

  it("recovery is temporal: failure → act → later verification", () => {
    const steps = [
      step(0, { outcome: "actuation-failed" }),
      step(1, { outcome: "acted", selected_action: { type: "click", confidence: 0.8 } }),
      step(2, { outcome: "acted", verification: { passed: true, reason: "actuated" } }),
    ];
    const r = evaluateBenchTask({
      task: task(), steps: steps as never, evidenceDigests: [],
      agentIdentity: "evex-real-agent", modelIdentity: null,
    });
    assert.equal(r.recoveryOpportunities, 1);
    assert.equal(r.recovered, 1);
  });

  it("unrecovered failure counts the opportunity without credit", () => {
    const steps = [step(0, { outcome: "actuation-failed" }), step(1, { outcome: "acted" })];
    const r = evaluateBenchTask({
      task: task(), steps: steps as never, evidenceDigests: [],
      agentIdentity: "evex-real-agent", modelIdentity: null,
    });
    assert.equal(r.recoveryOpportunities, 1);
    assert.equal(r.recovered, 0);
  });
});

describe("wilsonCI", () => {
  it("is empty on zero trials and brackets the rate otherwise", () => {
    assert.deepEqual(wilsonCI(0, 0), { lo: 0, hi: 0 });
    const ci = wilsonCI(6, 10);
    assert.ok(ci.lo <= 0.6 && 0.6 <= ci.hi, `rate must lie in interval: ${JSON.stringify(ci)}`);
    assert.ok(ci.lo < ci.hi);
  });
});

describe("benchmark records carry verdict counts + CI", () => {
  it("aggregates inconclusive/invalid separately with an interval", async () => {
    const registry = [task({ benchTaskId: "a" }), task({ benchTaskId: "b" }), task({ benchTaskId: "c" })];
    let n = 0;
    const rec = await runBench(
      registry,
      async () => {
        n += 1;
        const verdict = n === 1 ? "success" : n === 2 ? "inconclusive" : "invalid";
        return {
          verdict, success: verdict === "success",
          actionSuccesses: 0, actionTotal: 0, groundedCorrect: 0, groundedTotal: 0,
          stepsUsed: 0, predictionsCorrect: 0, predictionsTotal: 0,
          recovered: 0, recoveryOpportunities: 0, humanAgreements: 0, humanJudged: 0,
          unsafe: false, takeover: false, latenciesMs: [], steps: [],
          evidenceDigests: [], agentIdentity: "t", modelIdentity: null,
        };
      },
      { splits: ["test"], runId: "r3" },
    );
    assert.equal(rec.metrics.successCount, 1);
    assert.equal(rec.metrics.inconclusiveCount, 1);
    assert.equal(rec.metrics.invalidCount, 1);
    assert.ok(rec.metrics.taskSuccessCI.lo <= rec.metrics.taskSuccessRate);
    assert.ok(rec.metrics.taskSuccessRate <= rec.metrics.taskSuccessCI.hi);
    assert.ok(Array.isArray(rec.taskIds) && rec.taskIds.length === 3);
    assert.ok(typeof rec.methodology === "string" && rec.methodology.length > 0);
  });
});

describe("POST /v1/benchmarks (integration)", () => {
  let base = "";
  let srv: Server | null = null;
  const MASTER = "test-master-token-bench";
  let prevBackend: string | undefined;

  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${MASTER}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json: json as Record<string, unknown> };
  }

  before(async () => {
    process.env["DATA_DIR"] = mkdtempSync(join(tmpdir(), "evex-bench-"));
    process.env["EVEX_AUTH_TOKEN"] = MASTER;
    prevBackend = process.env["VM_BACKEND"];
    process.env["VM_BACKEND"] = "dev-framebuffer";
    process.env["EVEX_MAX_VMS_PER_TENANT"] = "64";
    process.env["EVEX_MAX_TOTAL_VMS"] = "512";
    process.env["EVEX_MAX_CPU_PER_TENANT"] = "256";
    process.env["EVEX_MAX_MEM_MB_PER_TENANT"] = "524288";
    delete process.env["EVEX_TENANT"];
    delete process.env["INFERENCE_URL"];
    await ensureOptionals();
    __clearMemory();
    const app = buildApp();
    hydrateFromDisk();
    const s = createServer(app);
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
    srv = s;
    const addr = s.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => srv?.close(() => resolve()));
    if (prevBackend === undefined) delete process.env["VM_BACKEND"];
    else process.env["VM_BACKEND"] = prevBackend;
  });

  it("mock agent without testOnly:true is refused (400, no record)", async () => {
    const r = await api("POST", "/v1/benchmarks", { name: "m", size: 1, seed: 1, agent: "mock-test-only" });
    assert.equal(r.status, 400);
    assert.equal(r.json["error"], "mock_agent_requires_test_only");
  });

  it("mock agent with testOnly:true is stamped synthetic/test_only", async () => {
    const r = await api("POST", "/v1/benchmarks", { name: "m", size: 2, seed: 1, agent: "mock-test-only", testOnly: true });
    assert.equal(r.status, 201);
    assert.equal(r.json["synthetic"], true);
    assert.equal(r.json["testOnly"], true);
    assert.throws(() => assertProductionRecord(r.json as { synthetic?: boolean; testOnly?: boolean }), /refusing production use/);
  });

  it("real agent on the dev backend reports invalid (never fake numbers)", async () => {
    const r = await api("POST", "/v1/benchmarks", { name: "real-dev", size: 1, seed: 1 });
    assert.equal(r.status, 201, `real benchmark failed: ${JSON.stringify(r.json).slice(0, 500)}`);
    const metrics = r.json["metrics"] as Record<string, number>;
    assert.equal(metrics["tasks"], 1);
    assert.equal(metrics["invalidCount"], 1);
    assert.equal(metrics["successCount"], 0);
    assert.equal(metrics["taskSuccessRate"], 0);
    assert.equal(r.json["synthetic"], false);
  });
});
