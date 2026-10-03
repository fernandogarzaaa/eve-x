import { randomUUID } from "node:crypto";
// Core primitives: ids, time, state machines, errors (§52)
export const uid = (p = "id"): string => `${p}-${randomUUID().slice(0, 8)}`;
export const nowIso = (): string => new Date().toISOString();
export class EveError extends Error {
  code: string;
  constructor(code: string, msg: string) { super(msg); this.code = code; }
}
/** Minimal deterministic PRNG (mulberry32) for seeded replay (§15). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Generic audited state machine (§5). */
export class StateMachine<S extends string> {
  private cur: S;
  readonly log: Array<{ from: S; to: S; at: string; reason: string }> = [];
  constructor(initial: S, private allowed: Record<S, S[]>) { this.cur = initial; }
  get state(): S { return this.cur; }
  can(to: S): boolean { return (this.allowed[this.cur] ?? []).includes(to); }
  transition(to: S, reason = ""): void {
    if (!this.can(to)) throw new EveError("INVALID_TRANSITION", `Cannot go ${this.cur} -> ${to}`);
    this.log.push({ from: this.cur, to, at: nowIso(), reason });
    this.cur = to;
  }
}
export const VM_TRANSITIONS: Record<string, string[]> = {
  // Fail-closed invariant: EVERY non-terminal state can reach FAILED, so a
  // command-phase failure (e.g. clone-resume timeout while PAUSED) always
  // lands honestly instead of stranding the cell in a transient state.
  CREATING: ["CREATED", "FAILED"], CREATED: ["BOOTING", "DESTROYING", "FAILED"],
  BOOTING: ["READY", "FAILED"], READY: ["RUNNING", "STOPPING", "FAILED"],
  RUNNING: ["PAUSING", "STOPPING", "RESTORING", "FORKING", "FAILED"],
  PAUSING: ["PAUSED", "FAILED"], PAUSED: ["RUNNING", "RESTORING", "STOPPING", "FAILED"],
  RESTORING: ["RUNNING", "FAILED"], FORKING: ["RUNNING", "FAILED"],
  STOPPING: ["STOPPED", "FAILED"], STOPPED: ["BOOTING", "DESTROYING", "CREATING", "FAILED"],
  FAILED: ["DESTROYING", "CREATING"], DESTROYING: ["DESTROYED"], DESTROYED: [],
};
export function sha1hex(s: string): string {
  let h1 = 0x67452301, h2 = 0xefcdab89, h3 = 0x98badcfe, h4 = 0x10325476, h5 = 0xc3d2e1f0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = (Math.imul(h1 ^ c, 0x5bd1e995) >>> 0); h2 = (Math.imul(h2 ^ c, 0x5bd1e995) >>> 0);
    h3 = (Math.imul(h3 ^ c, 0x5bd1e995) >>> 0); h4 = (Math.imul(h4 ^ c, 0x5bd1e995) >>> 0);
    h5 = (Math.imul(h5 ^ c, 0x5bd1e995) >>> 0);
  }
  return [h1, h2, h3, h4, h5].map((h) => (h >>> 0).toString(16).padStart(8, "0")).join("");
}
