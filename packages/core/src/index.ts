import { createHash, randomUUID } from "node:crypto";
// Core primitives: ids, time, state machines, errors (§52)
export { RELEASE } from "./release.gen.js";
import { RELEASE } from "./release.gen.js";
/** Full runtime release identity: baked build facts + live runtime facts. */
export function releaseIdentity(): Record<string, string | boolean> {
  return {
    ...RELEASE,
    nodeVersion: process.version,
    release: `${String(RELEASE.product)} ${String(RELEASE.version)}+${String(RELEASE.commit).slice(0, 12)}${RELEASE.dirty ? ".dirty" : ""}`,
  };
}
/** Fail-closed release/commit gate: when EVEX_EXPECT_COMMIT is set, the
 *  process refuses to serve unless the baked commit matches (§21). */
export function assertReleaseCommit(expectedEnv = "EVEX_EXPECT_COMMIT"): void {
  const expected = (process.env[expectedEnv] ?? "").trim();
  if (!expected) return;
  const built = String(RELEASE.commit);
  if (built !== expected) {
    throw new Error(`release mismatch: built from ${built} but ${expectedEnv}=${expected}`);
  }
}
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
/** Real SHA-256 hex digest (64 lowercase hex chars). This is the ONLY
 *  approved digest for evidence chains, image pins, and model fingerprints.
 *  (A previous `sha1hex` helper was a non-cryptographic toy hash misnamed as
 *  SHA-1; it was removed — every consumer now uses this.) */
export function sha256hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
/** Canonical JSON: stable key order so digests are reproducible across
 *  processes and restarts. The single canonicalizer for all evidence. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value) as string;
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(String(value)) as string;
}
