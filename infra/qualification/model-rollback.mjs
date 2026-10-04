#!/usr/bin/env node
// §31-32 model release integrity + rollback: A→production, B→production,
// retire B (rollback), exactly one production record remains and it is A.
// Weights are real files with recorded sha256; benchmark gates enforced.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ModelRegistry } from "../../dist/packages/model-registry/src/index.js";

const dir = mkdtempSync(join(tmpdir(), "evex-modelrel-"));
const reg = new ModelRegistry({ dir });
const mk = (name) => {
  const p = join(dir, name + ".bin");
  writeFileSync(p, Buffer.from("weights-" + name + "-release-1.0.0"));
  const sha = createHash("sha256").update(Buffer.from("weights-" + name + "-release-1.0.0")).digest("hex");
  const rec = reg.createRecord({
    version: "1.0.0", architecture: "cua-base", weightsUri: "file://" + p,
    weightsSha256: sha, weightsBytes: Buffer.from("weights-" + name + "-release-1.0.0").length,
    quantization: "none", configHash: "cfg-" + name, datasetDigest: "data-" + name,
    codeDigest: "15e6b977bfd4", trainedBy: "release-qual", config: {},
  });
  reg.recordBenchmark(rec.modelId, { benchmark: "canon-ground-v1", split: "test", successRate: 1, groundingAccuracy: 1, recoveryRate: 1, samples: 2, digest: "eval-release-qual", at: new Date().toISOString() });
  reg.recordBenchmark(rec.modelId, { benchmark: "canon-ground-v1", split: "held-out", successRate: 1, groundingAccuracy: 1, recoveryRate: 1, samples: 1, digest: "eval-release-qual", at: new Date().toISOString() });
  return reg.getRecord(rec.modelId);
};
const gate = { approvalToken: "human-release-approval-1", minSuccessRate: 0.5, minGroundingAccuracy: 0.5, minRecoveryRate: 0 };
const A = mk("A");
const B = mk("B");
const prod = (tag) => {
  const ids = reg.listRecords("production").map((r) => r.modelId).sort();
  console.log(`${tag} production=${JSON.stringify(ids)}`);
  return ids;
};
reg.promote(A.modelId, "staging", gate, "canon-ground-v1");
reg.promote(A.modelId, "production", gate, "canon-ground-v1");
let ids = prod("after-A");
if (ids.length !== 1 || ids[0] !== A.modelId) throw new Error("A must be sole production");
reg.promote(B.modelId, "staging", gate, "canon-ground-v1");
reg.promote(B.modelId, "production", gate, "canon-ground-v1");
ids = prod("after-B");
if (ids.length !== 2) throw new Error("A+B production expected, got " + JSON.stringify(ids));
// Rollback: retire B, A remains the production record.
reg.retire(B.modelId);
ids = prod("after-rollback");
if (ids.length !== 1 || ids[0] !== A.modelId) throw new Error("rollback failed: " + JSON.stringify(ids));
console.log("MODEL ROLLBACK COMPLETE: active=" + ids[0]);
