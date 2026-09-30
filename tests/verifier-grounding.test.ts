import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ActionIR } from "../packages/protocol/src/index.js";

// Local verifier: mirrors the control-plane gate — an action is executable
// only when its grounding references a known region, the confidence clears
// the threshold, and the bbox lies inside the frame.
const FRAME = { w: 1920, h: 1080 };
const THRESHOLD = 0.5;

interface Region { regionId: string; bbox: [number, number, number, number]; }

function verify(
  rawAction: unknown,
  regions: Region[],
  frame = FRAME,
): { passed: boolean; reason: string } {
  const parsed = ActionIR.safeParse(rawAction);
  if (!parsed.success) return { passed: false, reason: "schema-invalid" };
  const action = parsed.data;
  if (action.confidence < THRESHOLD) return { passed: false, reason: "low-confidence" };
  if (action.target !== undefined && action.target.kind === "visual-region") {
    const wantedRegionId: string = action.target.regionId;
    const known = regions.find((r) => r.regionId === wantedRegionId);
    if (!known) return { passed: false, reason: "unknown-region" };
    const b = action.target.bbox;
    const inside = b[0] >= 0 && b[1] >= 0 && b[2] <= frame.w && b[3] <= frame.h && b[2] > b[0] && b[3] > b[1];
    if (!inside) return { passed: false, reason: "bbox-out-of-frame" };
    return { passed: true, reason: "grounded" };
  }
  // Region-free actions (wait/observe/terminate) pass on confidence alone.
  return { passed: true, reason: "no-target-required" };
}

const REGIONS: Region[] = [{ regionId: "r-login", bbox: [100, 200, 300, 260] }];

function groundedClick(regionId: string, confidence: number): unknown {
  return {
    type: "click",
    target: { kind: "visual-region", regionId, bbox: [100, 200, 300, 260] },
    to: { x: 200, y: 230 },
    confidence,
  };
}

describe("verifier rejects bad grounding", () => {
  it("accepts a grounded click above threshold", () => {
    assert.deepEqual(verify(groundedClick("r-login", 0.9), REGIONS).passed, true);
  });

  it("rejects clicks on unknown regions", () => {
    const v = verify(groundedClick("r-ghost", 0.95), REGIONS);
    assert.equal(v.passed, false);
    assert.equal(v.reason, "unknown-region");
  });

  it("rejects low-confidence actions even with valid regions", () => {
    const v = verify(groundedClick("r-login", 0.2), REGIONS);
    assert.equal(v.passed, false);
    assert.equal(v.reason, "low-confidence");
  });

  it("rejects out-of-frame bboxes", () => {
    const v = verify(
      { type: "click", target: { kind: "visual-region", regionId: "r-login", bbox: [1800, 900, 2500, 1200] }, to: { x: 1900, y: 1000 }, confidence: 0.9 },
      REGIONS,
    );
    assert.equal(v.passed, false);
    assert.equal(v.reason, "bbox-out-of-frame");
  });

  it("rejects schema-invalid actions before grounding", () => {
    const v = verify({ type: "click", confidence: 0.9, to: { x: -1, y: 5 } }, REGIONS);
    // x=-1 violates Point.min(0): schema-invalid, never reaches grounding.
    assert.equal(v.passed, false);
  });

  it("lets region-free actions through on confidence", () => {
    assert.equal(verify({ type: "wait", ms: 500, confidence: 0.6 }, []).passed, true);
    assert.equal(verify({ type: "wait", ms: 500, confidence: 0.1 }, []).passed, false);
  });
});
