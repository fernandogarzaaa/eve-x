#!/usr/bin/env node
// Post-canonical qualification: genesis live + model eval/promotion + dataset shape.
// Uses the REAL canonical session trace. Evidence: artifacts/qualification/post-canonical.json
const API = process.env.EVE_API ?? "http://127.0.0.1:8080";
const TOKEN = process.env.EVEX_AUTH_TOKEN ?? "";
const ART = process.env.ARTDIR ?? "/root/evex-prod/artifacts/qualification";
const SID = process.env.SID;
if (!SID) throw new Error("SID required");
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const H = { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };
const out = { at: new Date().toISOString(), sessionId: SID, phases: [] };
const rec = (name, ok, detail) => {
  out.phases.push({ name, ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${String(detail).slice(0, 160)}`);
  if (!ok) { flush(); process.exitCode = 1; throw new Error("post-canonical abort: " + name); }
};
const flush = () => {
  mkdirSync(ART, { recursive: true });
  writeFileSync(join(ART, "post-canonical.json"), JSON.stringify(out, null, 2));
};
async function call(method, path, body) {
  const r = await fetch(API + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}

const { GenesisClient } = await import(join(ROOT, "dist", "packages", "genesis", "src", "index.js"));
const { ModelRegistry, sha256File } = await import(join(ROOT, "dist", "packages", "model-registry", "src", "index.js"));

// ---- trace + judgments (real evidence) ----
const trace = await call("GET", `/v1/trace/${SID}`);
const steps = trace.json.steps ?? [];
rec("trace-fetch", steps.length >= 5, `steps=${steps.length}`);
const stepIds = steps.map((s) => String(s.step_id ?? s.stepId ?? ""));
const okIds = stepIds.filter(Boolean);
rec("trace-step-ids", okIds.length === steps.length, `${okIds.length}/${steps.length} addressable`);

// ---- genesis: honest artifact must be SOUND (with evidence resolution) ----
const genesis = new GenesisClient();
const codeHash = createHash("sha1").update("evex-evaluator-v1").digest("hex");
const resolver = (sessionId, ids) => {
  if (sessionId !== SID) return { known: [], unknown: ids };
  const known = new Set(okIds);
  return { known: ids.filter((i) => known.has(i)), unknown: ids.filter((i) => !known.has(i)) };
};
const honest = genesis.submitArtifact({
  evaluatorId: "evex-task-success-v1",
  codeHash,
  claims: [{ claim: "Session completed the signup validation workflow", evidenceStepIds: okIds.slice(0, 3), score: 82 }],
  gradedSessionId: SID,
});
const honestAudit = genesis.audit(honest.artifactId, resolver);
rec("genesis-honest-sound", honestAudit.verdict === "SOUND", `verdict=${honestAudit.verdict}`);

// ---- genesis: adversarial variants must be EXPLOITABLE ----
const forged = genesis.submitArtifact({
  evaluatorId: "evex-task-success-v1", codeHash,
  claims: [{ claim: "Session completed brilliantly on phantom evidence", evidenceStepIds: ["step-does-not-exist-1", "step-does-not-exist-2"], score: 99 }],
  gradedSessionId: SID,
});
const forgedAudit = genesis.audit(forged.artifactId, resolver);
rec("genesis-forged-exploitable", forgedAudit.verdict === "EXPLOITABLE", `verdict=${forgedAudit.verdict}`);

const reordered = genesis.submitArtifact({
  evaluatorId: "evex-task-success-v1", codeHash,
  claims: [{ claim: "Steps from another session prove this one", evidenceStepIds: okIds.slice(0, 2), score: 95 }],
  gradedSessionId: "wrong-session-id",
});
const reorderedAudit = genesis.audit(reordered.artifactId, resolver);
rec("genesis-mismatched-exploitable", reorderedAudit.verdict === "EXPLOITABLE", `verdict=${reorderedAudit.verdict}`);

const selfGrade = genesis.submitArtifact({
  evaluatorId: "evex-task-success-v1", codeHash,
  claims: [{ claim: "Self-reviewed success is definitely success", evidenceStepIds: okIds.slice(0, 1), score: 100 }],
  gradedSessionId: SID, gradedSessionAuthor: "evex-task-success-v1",
});
const selfAudit = genesis.audit(selfGrade.artifactId, resolver);
rec("genesis-selfgrade-exploitable", selfAudit.verdict === "EXPLOITABLE", `verdict=${selfAudit.verdict}`);

// ---- model eval on REAL trace grounding (self-consistency calibration) ----
const boxSteps = steps.filter((s) => {
  const t = s.selected_action?.target ?? s.actual_action?.target;
  return Array.isArray(t?.bbox) && t.bbox.length === 4;
});
rec("trace-has-groundings", boxSteps.length >= 1, `${boxSteps.length} grounded steps`);
const regDir = join(ART, "eval-reg");
mkdirSync(regDir, { recursive: true });
const tasks = boxSteps.map((s, i) => ({
  task_id: `canon-${i}`,
  split: "test",
  goal: String(s.goal ?? "ground the observed control").slice(0, 120),
  expect: { success: true, bbox: (s.selected_action?.target ?? s.actual_action.target).bbox },
}));
writeFileSync(join(regDir, "registry.json"), JSON.stringify({ benchmark: "canon-ground-v1", tasks }));
const preds = tasks.map((t) => ({ task_id: t.task_id, step_id: "s0", bbox: t.expect.bbox }));
writeFileSync(join(regDir, "preds-exact.jsonl"), preds.map((p) => JSON.stringify(p)).join("\n") + "\n");
const shifted = tasks.map((t) => {
  // Negative control: displace far beyond any real frame so IoU is 0.
  // (+400px still overlaps full-width regions like the taskbar at IoU>0.5,
  // which taught us the shift must exceed the largest plausible frame.)
  const b = [...t.expect.bbox];
  b[0] += 100000; b[2] += 100000;
  return { task_id: t.task_id, step_id: "s0", bbox: b };
});
writeFileSync(join(regDir, "preds-shifted.jsonl"), shifted.map((p) => JSON.stringify(p)).join("\n") + "\n");
const { execFileSync } = await import("node:child_process");
const runEval = (preds) => execFileSync("python3",
  ["ml/evaluation/eval.py", "--registry", join(regDir, "registry.json"), "--predictions", preds,
   "--benchmark", "canon-ground-v1", "--split", "test", "--out", join(regDir, "artifact.json")],
  { cwd: ROOT, encoding: "utf8" }).toString();
const exactOut = runEval(join(regDir, "preds-exact.jsonl"));
const exact = JSON.parse(readFileSync(join(regDir, "artifact.json"), "utf8"));
const shiftOut = runEval(join(regDir, "preds-shifted.jsonl"));
const shifted2 = JSON.parse(readFileSync(join(regDir, "artifact.json"), "utf8"));
void exactOut; void shiftOut;
const exactAcc = exact.grounding_accuracy ?? exact.metrics?.grounding_accuracy ?? 0;
const shiftAcc = shifted2.grounding_accuracy ?? shifted2.metrics?.grounding_accuracy ?? 0;
rec("eval-discriminates", Number(exactAcc) > Number(shiftAcc), `exact=${exactAcc} shifted=${shiftAcc}`);
writeFileSync(join(ART, "eval-canon-ground.json"), JSON.stringify({ exact, shifted: shifted2 }, null, 2));

// ---- registry + promotion gates ----
const weightsPath = join(regDir, "weights.bin");
writeFileSync(weightsPath, Buffer.from("qual-checkpoint-bytes-0123456789"));
const wsha = sha256File(weightsPath);
const wbytes = readFileSync(weightsPath).length;
const registry = new ModelRegistry({ dir: join(ART, "model-registry") });
const rec1 = registry.createRecord({
  version: "canon-1", architecture: "cua-small", weightsUri: weightsPath,
  weightsSha256: wsha, weightsBytes: wbytes, quantization: "none",
  configHash: createHash("sha256").update("canon-config").digest("hex"),
  datasetDigest: createHash("sha256").update(JSON.stringify(tasks)).digest("hex"),
  codeDigest: createHash("sha256").update("canon-code").digest("hex"),
  trainedBy: "qual-harness",
  config: { epochs: 5, backend: "heuristic" },
});
registry.recordBenchmark(rec1.modelId, {
  benchmark: "canon-ground-v1", split: "test",
  successRate: 1, groundingAccuracy: Number(exactAcc) || 0, recoveryRate: 1,
  samples: tasks.length, digest: "qual", at: new Date().toISOString(),
});
const staged = registry.promote(rec1.modelId, "staging", { minSuccessRate: 0.5, minGroundingAccuracy: 0.0, minRecoveryRate: 0.0, requireHeldOut: false, approvalToken: "human-approval-qual-001" }, "canon-ground-v1");
rec("promote-qualified-staging", staged.stage === "staging", `stage=${staged.stage}`);
// Gate refusals: direct production skip, short token, corrupt weights, failing scores.
const gateFails = [];
try { registry.promote(rec1.modelId, "production", { minSuccessRate: 0, minGroundingAccuracy: 0, minRecoveryRate: 0, requireHeldOut: false, approvalToken: "x" }, "canon-ground-v1"); gateFails.push("short-token-accepted"); } catch {}
const rec2 = registry.createRecord({
  version: "canon-bad", architecture: "cua-small", weightsUri: join(regDir, "missing.bin"),
  weightsSha256: "0".repeat(64), weightsBytes: 10, quantization: "none",
  configHash: "c", datasetDigest: "d", codeDigest: "e", trainedBy: "qual-harness", config: {},
});
registry.recordBenchmark(rec2.modelId, { benchmark: "canon-ground-v1", split: "test", successRate: 1, groundingAccuracy: 1, recoveryRate: 1, samples: 1, digest: "q", at: new Date().toISOString() });
try { registry.promote(rec2.modelId, "staging", { minSuccessRate: 0, minGroundingAccuracy: 0, minRecoveryRate: 0, requireHeldOut: false, approvalToken: "human-approval-qual-002" }, "canon-ground-v1"); gateFails.push("missing-weights-accepted"); } catch {}
writeFileSync(weightsPath, Buffer.from("tampered-bytes-xxxxxxxxxxxx"));
try { registry.promote(rec1.modelId, "production", { minSuccessRate: 0.5, minGroundingAccuracy: 0.0, minRecoveryRate: 0, requireHeldOut: false, approvalToken: "human-approval-qual-003" }, "canon-ground-v1"); gateFails.push("tampered-weights-accepted"); } catch {}
rec("promotion-gates-refuse", gateFails.length === 0, gateFails.join(",") || "all refusals held");

// ---- human dataset shape ----
const jud = await call("POST", "/v1/judgments", {
  stepId: okIds[1] ?? okIds[0], reviewer: "canonical-reviewer-2",
  reasonable: true, targetCorrect: true, understandable: true, expected: true, recoveryOk: true,
});
const jb = jud.json;
const required = ["id", "reviewer", "reasonable", "targetCorrect", "understandable", "expected", "recoveryOk"];
const missing = required.filter((k) => jb[k] === undefined);
rec("judgment-shape", jud.status === 201 && missing.length === 0, missing.length === 0 ? `id=${jb.id}` : `missing: ${missing}`);

flush();
console.log("\nPOST-CANONICAL COMPLETE");
