import { z } from "zod";
import { EveError, canonicalJson, nowIso, sha256hex, uid } from "../../core/src/index.js";
import { TraceStep, type TraceStep as TraceStepType } from "../../protocol/src/index.js";

// ── Deterministic timeline player: load JSONL, play/pause/step/seek/speed,
// jump-to-error | intervention, branch via fork point. Snapshots + provenance. ──

export const PlayerStatusSchema = z.enum(["idle", "playing", "paused", "ended"]);
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;

export const SnapshotSchema = z.object({
  snapshotId: z.string(),
  sessionId: z.string(),
  seq: z.number().int().min(0),
  stepId: z.string(),
  digest: z.string(),
  at: z.string(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const ProvenanceLinkSchema = z.object({
  parentSessionId: z.string(),
  forkSeq: z.number().int().min(0),
  forkStepId: z.string(),
  forkDigest: z.string(),
  childSessionId: z.string(),
  createdAt: z.string(),
});
export type ProvenanceLink = z.infer<typeof ProvenanceLinkSchema>;

const StoredLineSchema = TraceStep.extend({
  prevDigest: z.string().optional(),
  digest: z.string().optional(),
});

/** Chain digest over the FULL canonical step body (not a reduced projection):
 *  any mutation, deletion, or reorder evidence breaks the chain. */
function digestFor(step: TraceStepType, prev: string): string {
  const { prevDigest: _pd, digest: _dg, ...body } = step as TraceStepType & { prevDigest?: unknown; digest?: unknown };
  void _pd;
  void _dg;
  return sha256hex(`${prev}.${canonicalJson(body)}`);
}

const GENESIS_DIGEST = "0".repeat(64);

function isErrorStep(s: TraceStepType): boolean {
  const o = (s.outcome ?? "").toLowerCase();
  return /fail|error|stuck|blocked|crash/.test(o) || s.verification?.passed === false;
}

export class TimelinePlayer {
  private steps: TraceStepType[] = [];
  private digests: string[] = [];
  private cursor = 0;
  private status: PlayerStatus = "idle";
  private speedStepsPerTick = 1;
  private branchHistory: ProvenanceLink[] = [];
  readonly playerId: string;

  constructor() {
    this.playerId = uid("player");
  }

  loadJsonl(jsonlInput: unknown): { steps: number; sessionId: string } {
    const jsonl = z.string().parse(jsonlInput);
    const lines = jsonl.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) throw new EveError("EMPTY_TIMELINE", "JSONL timeline has no steps");
    const steps: TraceStepType[] = [];
    const digests: string[] = [];
    let prev = GENESIS_DIGEST;
    for (const line of lines) {
      let raw: unknown;
      try {
        raw = JSON.parse(line) as unknown;
      } catch {
        throw new EveError("BAD_JSONL", "Timeline JSONL contains an unparsable line");
      }
      const parsed = StoredLineSchema.parse(raw) as TraceStepType & { prevDigest?: string; digest?: string };
      // Session identity first: a merged log is a session split, reported
      // as such even though its chained digests also break. Digest
      // verification follows for same-session lines.
      if (steps.length > 0 && parsed.session_id !== steps[0]?.session_id) {
        throw new EveError("SESSION_SPLIT", "Timeline mixes session_ids; fork instead of merging");
      }
      // Stored digests are EVIDENCE, not decoration: when a line carries a
      // chained digest it must verify against the running chain AND the full
      // canonical body. A forged/modified/deleted/duplicated step breaks here.
      if (parsed.digest !== undefined || parsed.prevDigest !== undefined) {
        if (typeof parsed.digest !== "string" || typeof parsed.prevDigest !== "string") {
          throw new EveError("CHAIN_BROKEN", "Timeline carries a partial digest record — refusing to replay");
        }
        if (parsed.prevDigest !== prev) {
          throw new EveError("CHAIN_BROKEN", `Timeline prevDigest mismatch at seq ${String(parsed.seq)} — reorder/deletion suspected`);
        }
        const recomputed = digestFor(parsed, prev);
        if (recomputed !== parsed.digest) {
          throw new EveError("CHAIN_BROKEN", `Timeline digest mismatch at seq ${String(parsed.seq)} — step was mutated`);
        }
        prev = parsed.digest;
      }
      const step = TraceStep.parse(parsed as unknown);
      if (steps.length > 0 && step.seq !== steps.length) {
        throw new EveError("SEQ_GAP", `Timeline seq gap: expected ${steps.length}, got ${step.seq}`);
      }
      const d = typeof parsed.digest === "string" ? parsed.digest : digestFor(step, prev);
      if (typeof parsed.digest !== "string") prev = d;
      steps.push(step);
      digests.push(d);
    }
    this.steps = steps;
    this.digests = digests;
    this.cursor = 0;
    this.status = "paused";
    const first = steps[0] as TraceStepType;
    return { steps: steps.length, sessionId: first.session_id };
  }

  get statusNow(): PlayerStatus {
    return this.status;
  }

  get length(): number {
    return this.steps.length;
  }

  get position(): number {
    return this.cursor;
  }

  current(): TraceStepType | null {
    if (this.steps.length === 0) return null;
    const s = this.steps[Math.min(this.cursor, this.steps.length - 1)] as TraceStepType;
    return { ...s };
  }

  play(): PlayerStatus {
    this.requireLoaded();
    this.status = this.cursor >= this.steps.length - 1 ? "ended" : "playing";
    return this.status;
  }

  pause(): PlayerStatus {
    this.requireLoaded();
    if (this.status === "playing" || this.status === "idle") this.status = "paused";
    return this.status;
  }

  /** Advance N steps (deterministic; no wall-clock drift). Returns landed step. */
  tick(ticksInput?: unknown): TraceStepType {
    const ticks = ticksInput === undefined ? 1 : z.number().int().min(1).max(1000).parse(ticksInput);
    this.requireLoaded();
    const n = ticks * this.speedStepsPerTick;
    this.cursor = Math.min(this.steps.length - 1, this.cursor + n);
    this.status = this.cursor >= this.steps.length - 1 ? "ended" : "playing";
    return this.current() as TraceStepType;
  }

  stepForward(): TraceStepType {
    this.requireLoaded();
    this.cursor = Math.min(this.steps.length - 1, this.cursor + 1);
    this.status = this.cursor >= this.steps.length - 1 ? "ended" : "paused";
    return this.current() as TraceStepType;
  }

  stepBack(): TraceStepType {
    this.requireLoaded();
    this.cursor = Math.max(0, this.cursor - 1);
    if (this.status === "ended") this.status = "paused";
    return this.current() as TraceStepType;
  }

  seek(seqInput: unknown): TraceStepType {
    const seq = z.number().int().min(0).parse(seqInput);
    this.requireLoaded();
    if (seq >= this.steps.length) throw new EveError("SEEK_OOB", `seek ${seq} beyond length ${this.steps.length}`);
    this.cursor = seq;
    this.status = seq >= this.steps.length - 1 ? "ended" : "paused";
    return this.current() as TraceStepType;
  }

  setSpeed(stepsPerTickInput: unknown): number {
    const v = z.number().int().min(1).max(100).parse(stepsPerTickInput);
    this.speedStepsPerTick = v;
    return v;
  }

  jumpToError(): TraceStepType {
    this.requireLoaded();
    const idx = this.steps.findIndex((s, i) => i >= this.cursor && isErrorStep(s));
    if (idx === -1) throw new EveError("NO_ERROR_STEP", "No error/failed-verification step at or after cursor");
    this.cursor = idx;
    this.status = "paused";
    return this.current() as TraceStepType;
  }

  jumpToIntervention(): TraceStepType {
    this.requireLoaded();
    const idx = this.steps.findIndex((s, i) => i >= this.cursor && (s.human_intervention || (s.human_judgment ?? "").length > 0));
    if (idx === -1) throw new EveError("NO_INTERVENTION", "No human-intervention step at or after cursor");
    this.cursor = idx;
    this.status = "paused";
    return this.current() as TraceStepType;
  }

  snapshot(): Snapshot {
    this.requireLoaded();
    const s = this.steps[this.cursor] as TraceStepType;
    const d = this.digests[this.cursor] as string;
    return SnapshotSchema.parse({
      snapshotId: `snap-${sha256hex(`${s.session_id}:${s.seq}:${d}`).slice(0, 12)}`,
      sessionId: s.session_id,
      seq: s.seq,
      stepId: s.step_id,
      digest: d,
      at: nowIso(),
    });
  }

  /**
   * Branch: fork a child timeline starting at `atSeq` with a new session id.
   * The copied prefix KEEPS the parent session_id — it is parent history,
   * and rewriting it would forge provenance. The child diverges only in the
   * link record (childSessionId) and in steps appended after the fork.
   */
  fork(newSessionIdInput: unknown, atSeqInput: unknown): { child: TimelinePlayer; link: ProvenanceLink } {
    const newSessionId = z.string().min(1).parse(newSessionIdInput);
    const atSeq = z.number().int().min(0).parse(atSeqInput);
    this.requireLoaded();
    if (atSeq >= this.steps.length) throw new EveError("FORK_OOB", `fork seq ${atSeq} beyond length ${this.steps.length}`);
    const forkStep = this.steps[atSeq] as TraceStepType;
    const forkDigest = this.digests[atSeq] as string;
    const child = new TimelinePlayer();
    child.steps = this.steps.slice(0, atSeq + 1).map((s) => ({ ...s }));
    child.digests = this.digests.slice(0, atSeq + 1);
    child.cursor = atSeq;
    child.status = "paused";
    const link = ProvenanceLinkSchema.parse({
      parentSessionId: forkStep.session_id,
      forkSeq: atSeq,
      forkStepId: forkStep.step_id,
      forkDigest,
      childSessionId: newSessionId,
      createdAt: nowIso(),
    });
    child.branchHistory = [...this.branchHistory, link];
    this.branchHistory.push(link);
    return { child, link };
  }

  provenance(): ProvenanceLink[] {
    return this.branchHistory.map((l) => ({ ...l }));
  }

  errorIndices(): number[] {
    return this.steps.map((s, i) => (isErrorStep(s) ? i : -1)).filter((i) => i >= 0);
  }

  interventionIndices(): number[] {
    return this.steps.map((s, i) => (s.human_intervention ? i : -1)).filter((i) => i >= 0);
  }

  private requireLoaded(): void {
    if (this.steps.length === 0) throw new EveError("NOT_LOADED", "TimelinePlayer has no loaded timeline — call loadJsonl first");
  }
}
