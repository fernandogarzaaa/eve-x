import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GenesisClient } from "../packages/genesis/src/index.js";

// Evidence resolution: claims must cite steps that exist in the graded session.
const HASH = "a".repeat(64);
const resolver = (sid: string | undefined, ids: string[]) => {
  if (sid !== "sess-real") return { known: [], unknown: ids };
  const known = new Set(["s0", "s1", "s2"]);
  return { known: ids.filter((i) => known.has(i)), unknown: ids.filter((i) => !known.has(i)) };
};

function submit(client: GenesisClient, claims: Array<{ claim: string; evidenceStepIds: string[]; score: number }>, extra: Record<string, unknown> = {}) {
  return client.submitArtifact({
    evaluatorId: "evex-test-eval",
    codeHash: HASH,
    claims,
    gradedSessionId: "sess-real",
    ...extra,
  });
}

describe("genesis evidence resolution", () => {
  it("honest claims with resolvable evidence are SOUND", () => {
    const g = new GenesisClient();
    const a = submit(g, [{ claim: "The workflow completed successfully here", evidenceStepIds: ["s0", "s1"], score: 80 }]);
    assert.equal(g.audit(a.artifactId, resolver).verdict, "SOUND");
  });

  it("phantom step ids are EXPLOITABLE", () => {
    const g = new GenesisClient();
    const a = submit(g, [{ claim: "Phantom evidence proves everything fine", evidenceStepIds: ["nope-1"], score: 90 }]);
    const r = g.audit(a.artifactId, resolver);
    assert.equal(r.verdict, "EXPLOITABLE");
    assert.ok(r.failedChecks.includes("evidence-resolves"));
  });

  it("wrong-session evidence is EXPLOITABLE", () => {
    const g = new GenesisClient();
    const a = submit(
      g,
      [{ claim: "Another session proves this session fine", evidenceStepIds: ["s0"], score: 90 }],
      { gradedSessionId: "sess-other" },
    );
    assert.equal(g.audit(a.artifactId, resolver).verdict, "EXPLOITABLE");
  });

  it("self-grading authors are EXPLOITABLE", () => {
    const g = new GenesisClient();
    const a = submit(
      g,
      [{ claim: "Self review confirms full success today", evidenceStepIds: ["s0"], score: 95 }],
      { gradedSessionAuthor: "evex-test-eval" },
    );
    assert.equal(g.audit(a.artifactId, resolver).verdict, "EXPLOITABLE");
  });

  it("without a resolver the check abstains explicitly (never silently passes)", () => {
    const g = new GenesisClient();
    const a = submit(g, [{ claim: "Unresolved evidence claim text here", evidenceStepIds: ["s0"], score: 80 }]);
    const r = g.audit(a.artifactId);
    assert.ok(r.reasons.some((x) => x.includes("abstained")));
  });
});
