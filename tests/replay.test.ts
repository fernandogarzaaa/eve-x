import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Replay cursor over an ordered step list: seek by seq, branch from a prefix.
// Branching never mutates the parent history; the child carries its lineage.
interface Step { seq: number; label: string; }

class Replay {
  readonly steps: Step[];
  private cursor = 0;
  constructor(steps: Step[]) { this.steps = [...steps]; }
  seek(seq: number): Step {
    const found = this.steps.find((s) => s.seq === seq);
    if (!found) throw new Error(`Cannot seek: no step with seq ${seq}`);
    this.cursor = this.steps.indexOf(found);
    return found;
  }
  current(): Step | null { return this.steps[this.cursor] ?? null; }
  advance(): Step | null {
    if (this.cursor + 1 >= this.steps.length) return null;
    this.cursor += 1;
    return this.steps[this.cursor] as Step;
  }
  branch(fromSeq: number, extra: Step[]): Replay {
    const idx = this.steps.findIndex((s) => s.seq === fromSeq);
    if (idx === -1) throw new Error(`Cannot branch: no step with seq ${fromSeq}`);
    return new Replay([...this.steps.slice(0, idx + 1), ...extra]);
  }
}

const TRAJ: Step[] = [
  { seq: 0, label: "boot" },
  { seq: 1, label: "open-app" },
  { seq: 2, label: "click-login" },
  { seq: 3, label: "type-password" },
];

describe("replay seek/branch", () => {
  it("seeks to an exact seq", () => {
    const r = new Replay(TRAJ);
    assert.equal(r.seek(2).label, "click-login");
    assert.equal(r.current()?.seq, 2);
  });

  it("throws when seeking past the end", () => {
    const r = new Replay(TRAJ);
    assert.throws(() => r.seek(99), /Cannot seek/);
  });

  it("advances forward and returns null at the tip", () => {
    const r = new Replay(TRAJ);
    r.seek(3);
    assert.equal(r.advance(), null);
    r.seek(0);
    assert.equal(r.advance()?.label, "open-app");
  });

  it("branches without mutating the parent", () => {
    const r = new Replay(TRAJ);
    const child = r.branch(1, [{ seq: 2, label: "alt-path" }, { seq: 3, label: "alt-end" }]);
    assert.equal(r.steps.length, 4);
    assert.equal(r.steps[2]?.label, "click-login");
    assert.equal(child.steps.length, 4);
    assert.equal(child.steps[2]?.label, "alt-path");
  });

  it("branching from an unknown seq fails", () => {
    const r = new Replay(TRAJ);
    assert.throws(() => r.branch(42, []), /Cannot branch/);
  });
});
