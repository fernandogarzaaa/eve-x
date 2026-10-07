import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "../packages/model-registry/src/index.js";

// Genesis gate: integrity evidence (grounding accuracy on held-out, valid
// lineage digests) is evaluated separately from performance (success rate,
// latency). A model can be fast yet untrusted — promotion requires both bars.
interface Integrity { groundingHeldOut: number; lineageOk: boolean; verifierPass: boolean; }
interface Performance { successRate: number; p50LatencyMs: number; }

function genesisVerdict(
  integrity: Integrity,
  performance: Performance,
): { ship: boolean; integrityPass: boolean; performancePass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const integrityPass = integrity.groundingHeldOut >= 0.85 && integrity.lineageOk && integrity.verifierPass;
  if (integrity.groundingHeldOut < 0.85) reasons.push("integrity: held-out grounding below 0.85");
  if (!integrity.lineageOk) reasons.push("integrity: lineage digests invalid");
  if (!integrity.verifierPass) reasons.push("integrity: verifier gate failed");
  const performancePass = performance.successRate >= 0.8 && performance.p50LatencyMs <= 15000;
  if (performance.successRate < 0.8) reasons.push("performance: success rate below 0.80");
  if (performance.p50LatencyMs > 15000) reasons.push("performance: p50 latency above budget");
  return { ship: integrityPass && performancePass, integrityPass, performancePass, reasons };
}

describe("genesis separates integrity from performance", () => {
  it("ships only when both bars pass", () => {
    const v = genesisVerdict(
      { groundingHeldOut: 0.9, lineageOk: true, verifierPass: true },
      { successRate: 0.85, p50LatencyMs: 4000 },
    );
    assert.equal(v.ship, true);
    assert.deepEqual(v.reasons, []);
  });

  it("blocks a fast model with weak grounding", () => {
    const v = genesisVerdict(
      { groundingHeldOut: 0.4, lineageOk: true, verifierPass: true },
      { successRate: 0.95, p50LatencyMs: 500 },
    );
    assert.equal(v.ship, false);
    assert.equal(v.integrityPass, false);
    assert.equal(v.performancePass, true);
  });

  it("blocks a well-grounded model that is too slow", () => {
    const v = genesisVerdict(
      { groundingHeldOut: 0.92, lineageOk: true, verifierPass: true },
      { successRate: 0.9, p50LatencyMs: 60000 },
    );
    assert.equal(v.ship, false);
    assert.equal(v.integrityPass, true);
    assert.equal(v.performancePass, false);
  });

  it("registry promotion mirrors the split: no held-out evidence, no production", () => {
    const dir = mkdtempSync(join(tmpdir(), "evex-genesis-"));
    try {
      const reg = new ModelRegistry({ dir });
      const wpath = join(dir, "weights", "w.bin");
      writeFileSync(wpath, Buffer.alloc(1024, 7));
      // Real digest so the weights gate passes and the held-out gate is what
      // refuses (the original intent of this test).
      const real = createHash("sha256").update(readFileSync(wpath)).digest("hex");
      const rec = reg.createRecord({
        version: "0.1.0",
        architecture: "cua-small",
        weightsUri: wpath,
        weightsSha256: real,
        weightsBytes: 1024,
        quantization: "none",
        configHash: "c".repeat(64),
        datasetDigest: "d".repeat(64),
        codeDigest: "e".repeat(64),
        trainedBy: "eval",
        config: { lr: 0.001 },
      });
      reg.recordBenchmark(rec.modelId, {
        benchmark: "eve-ground-v1",
        split: "test",
        successRate: 0.9,
        groundingAccuracy: 0.9,
        recoveryRate: 0.7,
        samples: 50,
        digest: "f".repeat(64),
        at: new Date().toISOString(),
      });
      // Test-only evidence: production promotion must refuse (held-out required).
      assert.throws(
        () => reg.promote(rec.modelId, "staging", { approvalToken: "human-ok-1", minSuccessRate: 0.8, minGroundingAccuracy: 0.85, minRecoveryRate: 0.6, requireHeldOut: true }, "eve-ground-v1"),
        /held-out/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registry promotion refuses missing or tampered weights", () => {
    const dir = mkdtempSync(join(tmpdir(), "evex-genesis-"));
    try {
      const reg = new ModelRegistry({ dir });
      const mk = (weightsUri: string, sha: string, bytes: number): string => {
        const rec = reg.createRecord({
          version: "0.1.0", architecture: "cua-small", weightsUri,
          weightsSha256: sha, weightsBytes: bytes, quantization: "none",
          configHash: "c".repeat(64), datasetDigest: "d".repeat(64),
          codeDigest: "e".repeat(64), trainedBy: "eval", config: {},
        });
        reg.recordBenchmark(rec.modelId, {
          benchmark: "eve-ground-v1", split: "test",
          successRate: 0.9, groundingAccuracy: 0.9, recoveryRate: 0.7,
          samples: 10, digest: "f".repeat(64), at: new Date().toISOString(),
        });
        return rec.modelId;
      };
      const gate = { approvalToken: "human-ok-2", minSuccessRate: 0.5, minGroundingAccuracy: 0.5, minRecoveryRate: 0.5, requireHeldOut: false };
      const missing = mk(join(dir, "weights", "nope.bin"), "0".repeat(64), 10);
      assert.throws(() => reg.promote(missing, "staging", gate, "eve-ground-v1"), /weights missing/);
      const wpath = join(dir, "weights", "w.bin");
      writeFileSync(wpath, Buffer.alloc(64, 1));
      const tampered = mk(wpath, "1".repeat(64), 64);
      assert.throws(() => reg.promote(tampered, "staging", gate, "eve-ground-v1"), /mismatch/);
      // Remote URIs can never be verified by this process: refused even
      // with a recorded digest and passing benchmark scores.
      const remote = mk("https://evil.example/w.bin", "2".repeat(64), 64);
      assert.throws(() => reg.promote(remote, "staging", gate, "eve-ground-v1"), /remote weights URI/);
      const s3remote = mk("s3://bucket/w.bin", "3".repeat(64), 64);
      assert.throws(() => reg.promote(s3remote, "staging", gate, "eve-ground-v1"), /remote weights URI/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
