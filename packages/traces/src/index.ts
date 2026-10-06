import { z } from "zod";
import { EveError, canonicalJson, sha256hex } from "../../core/src/index.js";
import { TraceStep, type TraceStep as TraceStepType } from "../../protocol/src/index.js";

// ── Append-only TraceStore: one JSONL stream per session, immutable append,
// SHA-256 digest chain per step, exports JSON + JSONL + CSV (parquet-compat). ──

export const StoredStepSchema = TraceStep.extend({
  prevDigest: z.string().length(64),
  digest: z.string().length(64),
});
export type StoredStep = z.infer<typeof StoredStepSchema>;

const GENESIS_DIGEST = "0".repeat(64);
export { canonicalJson };

const CSV_COLUMNS = [
  "session_id",
  "task_id",
  "step_id",
  "seq",
  "timestamp",
  "actor",
  "vm_state_before",
  "screen_before",
  "goal",
  "selected_action_type",
  "selected_action_confidence",
  "grounding_verified",
  "prediction",
  "verification_passed",
  "screen_after",
  "vm_state_after",
  "outcome",
  "latency_ms",
  "emotion",
  "trust",
  "cognitive_load",
  "human_intervention",
  "model_version",
  "environment_version",
  "prev_digest",
  "digest",
] as const;

function csvCell(value: string | number | boolean | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export class TraceStore {
  readonly sessionId: string;
  readonly taskId: string;
  private steps: StoredStep[] = [];

  constructor(sessionIdInput: unknown, taskIdInput: unknown) {
    this.sessionId = z.string().min(1).parse(sessionIdInput);
    this.taskId = z.string().min(1).parse(taskIdInput);
  }

  /** Immutable append: validates, chains digest, returns stored record. */
  append(stepInput: unknown): StoredStep {
    const step = TraceStep.parse(stepInput);
    if (step.session_id !== this.sessionId) {
      throw new EveError("SESSION_MISMATCH", `Step session ${step.session_id} != store ${this.sessionId}`);
    }
    const expectedSeq = this.steps.length;
    if (step.seq !== expectedSeq) {
      throw new EveError("SEQ_GAP", `Expected seq ${expectedSeq}, got ${step.seq} — append-only store rejects gaps/reorders`);
    }
    const prevDigest = this.steps.length === 0 ? GENESIS_DIGEST : ((this.steps[this.steps.length - 1]?.digest ?? GENESIS_DIGEST) as string);
    const digest = sha256hex(`${prevDigest}.${canonicalJson(step)}`);
    const stored = StoredStepSchema.parse({ ...step, prevDigest, digest });
    this.steps.push(stored);
    return { ...stored };
  }

  get(seqInput: unknown): StoredStep {
    const seq = z.number().int().min(0).parse(seqInput);
    const found = this.steps[seq];
    if (!found) throw new EveError("STEP_NOT_FOUND", `No step seq=${seq} in session ${this.sessionId}`);
    return { ...found };
  }

  getById(stepIdInput: unknown): StoredStep {
    const stepId = z.string().min(1).parse(stepIdInput);
    const found = this.steps.find((s) => s.step_id === stepId);
    if (!found) throw new EveError("STEP_NOT_FOUND", `No step id=${stepId} in session ${this.sessionId}`);
    return { ...found };
  }

  list(): StoredStep[] {
    return this.steps.map((s) => ({ ...s }));
  }

  count(): number {
    return this.steps.length;
  }

  headDigest(): string {
    if (this.steps.length === 0) return GENESIS_DIGEST;
    return (this.steps[this.steps.length - 1]?.digest ?? GENESIS_DIGEST) as string;
  }

  /** Recompute the whole chain; throws on first tamper evidence. */
  verifyChain(): { ok: true; steps: number; headDigest: string } {
    let prev = GENESIS_DIGEST;
    for (let i = 0; i < this.steps.length; i += 1) {
      const s = this.steps[i] as StoredStep;
      if (s.seq !== i) throw new EveError("CHAIN_BROKEN", `seq mismatch at index ${i}: stored seq=${s.seq}`);
      if (s.prevDigest !== prev) throw new EveError("CHAIN_BROKEN", `prevDigest mismatch at seq=${i}`);
      const { prevDigest: _p, digest: _d, ...body } = s;
      void _p;
      void _d;
      const recomputed = sha256hex(`${prev}.${canonicalJson(TraceStep.parse(body))}`);
      if (recomputed !== s.digest) throw new EveError("CHAIN_BROKEN", `digest mismatch at seq=${i} — step was mutated`);
      prev = s.digest;
    }
    return { ok: true, steps: this.steps.length, headDigest: prev };
  }

  exportJson(): StoredStep[] {
    return this.list();
  }

  exportJsonl(): string {
    return this.steps.map((s) => canonicalJson(s)).join("\n") + (this.steps.length > 0 ? "\n" : "");
  }

  exportCsv(): string {
    const rows: string[] = [CSV_COLUMNS.join(",")];
    for (const s of this.steps) {
      const record: Record<(typeof CSV_COLUMNS)[number], string | number | boolean | null | undefined> = {
        session_id: s.session_id,
        task_id: s.task_id,
        step_id: s.step_id,
        seq: s.seq,
        timestamp: s.timestamp,
        actor: s.actor,
        vm_state_before: s.vm_state_before,
        screen_before: s.screen_before,
        goal: s.goal,
        selected_action_type: s.selected_action?.type ?? "",
        selected_action_confidence: s.selected_action?.confidence ?? "",
        grounding_verified: s.grounding?.verified ?? "",
        prediction: s.prediction ?? "",
        verification_passed: s.verification?.passed ?? "",
        screen_after: s.screen_after ?? "",
        vm_state_after: s.vm_state_after ?? "",
        outcome: s.outcome ?? "",
        latency_ms: s.latency_ms ?? "",
        emotion: s.emotion ?? "",
        trust: s.trust ?? "",
        cognitive_load: s.cognitive_load ?? "",
        human_intervention: s.human_intervention,
        model_version: s.model_version,
        environment_version: s.environment_version,
        prev_digest: s.prevDigest,
        digest: s.digest,
      };
      rows.push(CSV_COLUMNS.map((c) => csvCell(record[c])).join(","));
    }
    return rows.join("\n") + "\n";
  }

  /** Load a JSONL stream (produced by exportJsonl) into a fresh store; verifies chain. */
  static fromJsonl(sessionIdInput: unknown, taskIdInput: unknown, jsonlInput: unknown): TraceStore {
    const jsonl = z.string().parse(jsonlInput);
    const store = new TraceStore(sessionIdInput, taskIdInput);
    const lines = jsonl.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new EveError("BAD_JSONL", "Trace JSONL contains an unparsable line");
      }
      const { prevDigest: _p, digest: _d, ...body } = z.record(z.unknown()).parse(parsed) as Record<string, unknown>;
      void _p;
      void _d;
      store.append(body);
    }
    store.verifyChain();
    return store;
  }
}

export { CSV_COLUMNS, GENESIS_DIGEST };
export type { TraceStepType };
