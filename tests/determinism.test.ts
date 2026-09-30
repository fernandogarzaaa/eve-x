import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { prng } from "../packages/core/src/index.js";

// A seeded trajectory sampler: the same seed must always produce the same
// action sequence; different seeds diverge. This is the determinism contract
// replay and benchmarks rely on.
const ACTIONS = ["click", "move", "type", "scroll", "wait", "observe"] as const;

function sampleTrajectory(seed: number, steps: number): string[] {
  const rand = prng(seed);
  const out: string[] = [];
  for (let i = 0; i < steps; i++) {
    const idx = Math.floor(rand() * ACTIONS.length);
    out.push(ACTIONS[idx] as string);
  }
  return out;
}

describe("determinism: same seed, same trajectory", () => {
  it("reproduces identical trajectories for the same seed", () => {
    assert.deepEqual(sampleTrajectory(42, 50), sampleTrajectory(42, 50));
  });

  it("diverges for different seeds", () => {
    assert.notDeepEqual(sampleTrajectory(1, 50), sampleTrajectory(2, 50));
  });

  it("prng output stays in [0,1)", () => {
    const rand = prng(7);
    for (let i = 0; i < 1000; i++) {
      const v = rand();
      assert.ok(v >= 0 && v < 1);
    }
  });

  it("seed 0 and negative-equivalent seeds behave deterministically", () => {
    assert.deepEqual(sampleTrajectory(0, 20), sampleTrajectory(0, 20));
  });
});
