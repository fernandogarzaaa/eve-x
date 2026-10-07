import { z } from "zod";
import { EveError, nowIso, uid } from "../../core/src/index.js";
import { HumanJudgment, type HumanJudgment as HumanJudgmentType } from "../../protocol/src/index.js";

// ── EvidenceValidator / TaskOracle ─────────────────────────────────────────
// Task validation must never trust agent-emitted verdicts. A verdict is
// derived ONLY from server-resolved evidence:
//
// * the session trace (sequence + SHA-256 chain must verify — tampered,
//   reordered, gapped, or duplicated evidence is INVALID_EVIDENCE);
// * caller-nominated step ids, resolved server-side (unknown ids are
//   INVALID_EVIDENCE, never ignored);
// * oracle assertions evaluated deterministically against the cited steps
//   (failures → FAILED; note that verification-passed attests EXECUTION
//   only and can never confirm a verdict by itself);
// * supporting human judgments (reasonable + targetCorrect) on cited steps,
//   or server-verified grounding of the acted point.
//
// PASS additionally requires independent confirmation: either a supporting
// human judgment, or a server-verified grounding assertion (the acted point
// demonstrably inside a region of the exact observed frame). Execution
// verification and agent-written outcome strings alone can only ever yield
// INCONCLUSIVE — uncertainty is never collapsed into success. Every result
// names the exact evidence that caused it.

export const ValidationVerdictSchema = z.enum(["PASS", "FAILED", "INCONCLUSIVE", "INVALID_EVIDENCE"]);
export type ValidationVerdict = z.infer<typeof ValidationVerdictSchema>;

export const OracleAssertionSchema = z.object({
  kind: z.enum(["signal-present", "outcome-is", "grounding-verified", "verification-passed"]),
  signal: z.string().min(1).max(256).optional(),
  outcome: z.string().min(1).max(64).optional(),
});
export type OracleAssertion = z.infer<typeof OracleAssertionSchema>;

export const EvidenceBundleSchema = z.object({
  sessionId: z.string().min(1).max(128),
  stepIds: z.array(z.string().min(1).max(128)).min(1).max(200),
  assertions: z.array(OracleAssertionSchema).max(50).default([]),
  judgmentIds: z.array(z.string().min(1).max(128)).max(50).default([]),
});
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

export interface ResolvedStep {
  step_id: string;
  seq: number;
  outcome?: string;
  grounding?: { verified?: boolean };
  verification?: { passed?: boolean };
  raw: Record<string, unknown>;
}

export interface SupportingJudgment {
  id: string;
  stepId: string;
  reviewer: string;
  reasonable: boolean;
  targetCorrect: boolean;
}

export interface ReplaySummary {
  verdict: string;
  issues: string[];
  chained: boolean;
}

export const AssertionResultSchema = z.object({
  kind: OracleAssertionSchema.shape.kind,
  pass: z.boolean(),
  stepId: z.string().optional(),
  detail: z.string().max(512),
});
export type AssertionResult = z.infer<typeof AssertionResultSchema>;

export const ValidationResultSchema = z.object({
  verdict: ValidationVerdictSchema,
  taskId: z.string(),
  sessionId: z.string(),
  stepIds: z.array(z.string()),
  assertionResults: z.array(AssertionResultSchema),
  judgmentIds: z.array(z.string()),
  causedBy: z.array(z.string().max(512)),
  checkedAt: z.string(),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

function stepText(s: ResolvedStep): string {
  return JSON.stringify(s.raw);
}

function evalAssertion(a: OracleAssertion, steps: ResolvedStep[]): AssertionResult {
  if (a.kind === "signal-present") {
    const sig = a.signal ?? "";
    const hit = steps.find((s) => stepText(s).includes(sig));
    if (hit) return { kind: a.kind, pass: true, stepId: hit.step_id, detail: `signal ${JSON.stringify(sig)} present in step ${hit.step_id}` };
    return { kind: a.kind, pass: false, detail: `signal ${JSON.stringify(sig)} absent from all ${steps.length} cited steps` };
  }
  if (a.kind === "outcome-is") {
    const want = a.outcome ?? "";
    const hit = steps.find((s) => s.outcome === want);
    if (hit) return { kind: a.kind, pass: true, stepId: hit.step_id, detail: `step ${hit.step_id} outcome is ${JSON.stringify(want)}` };
    return { kind: a.kind, pass: false, detail: `no cited step has outcome ${JSON.stringify(want)}` };
  }
  if (a.kind === "grounding-verified") {
    const hit = steps.find((s) => s.grounding?.verified === true);
    if (hit) return { kind: a.kind, pass: true, stepId: hit.step_id, detail: `step ${hit.step_id} carries server-verified grounding` };
    return { kind: a.kind, pass: false, detail: "no cited step carries server-verified grounding" };
  }
  const hit = steps.find((s) => s.verification?.passed === true);
  if (hit) return { kind: a.kind, pass: true, stepId: hit.step_id, detail: `step ${hit.step_id} carries server-passed verification` };
  return { kind: a.kind, pass: false, detail: "no cited step carries server-passed verification" };
}

/** Pure deterministic validator: same inputs → same verdict, always. */
export function validateEvidence(input: {
  taskId: unknown;
  evidence: EvidenceBundle;
  /** Cited steps, resolved server-side from the session trace. */
  resolvedSteps: ResolvedStep[];
  /** Replay verdict over the FULL session trace (chain + sequence). */
  replay: ReplaySummary;
  /** Judgments resolved server-side by id. */
  judgments: SupportingJudgment[];
  traceChained: boolean;
}): ValidationResult {
  const taskId = z.string().min(1).parse(input.taskId);
  const ev = EvidenceBundleSchema.parse(input.evidence);
  const checkedAt = nowIso();
  const causedBy: string[] = [];
  const fail = (reasons: string[]): ValidationResult => ValidationResultSchema.parse({
    verdict: "INVALID_EVIDENCE" as const, taskId, sessionId: ev.sessionId,
    stepIds: ev.stepIds, assertionResults: [], judgmentIds: [], causedBy: reasons, checkedAt,
  });

  // 1. Trace integrity first: tamper evidence poisons everything downstream.
  if (input.replay.verdict !== "deterministic-replay-ok") {
    return fail([
      `trace replay is ${input.replay.verdict}`,
      ...input.replay.issues.slice(0, 5).map((i) => `replay: ${i}`),
    ]);
  }
  if (!input.traceChained) {
    return fail(["trace carries no SHA-256 evidence chain — tampering is undetectable, refusing verdict"]);
  }
  // 2. Every cited step must resolve. Unknown ids are evidence failure.
  const byId = new Map(input.resolvedSteps.map((s) => [s.step_id, s]));
  const missing = ev.stepIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return fail([`cited steps not found in session trace: ${missing.slice(0, 10).join(", ")}`]);
  }
  const cited = ev.stepIds.map((id) => byId.get(id) as ResolvedStep);
  // 3. Judgments must resolve to cited steps.
  const jById = new Map(input.judgments.map((j) => [j.id, j]));
  const unknownJ = ev.judgmentIds.filter((id) => !jById.has(id));
  if (unknownJ.length > 0) {
    return fail([`cited judgments not found: ${unknownJ.slice(0, 10).join(", ")}`]);
  }
  const citedJudgments = ev.judgmentIds.map((id) => jById.get(id) as SupportingJudgment);
  const stray = citedJudgments.filter((j) => !byId.has(j.stepId));
  if (stray.length > 0) {
    return fail([`judgments cite steps outside the evidence set: ${stray.map((j) => j.id).join(", ")}`]);
  }
  // 4. Deterministic oracle assertions.
  const assertionResults = ev.assertions.map((a) => evalAssertion(a, cited));
  const failed = assertionResults.filter((r) => !r.pass);
  if (failed.length > 0) {
    return ValidationResultSchema.parse({
      verdict: "FAILED" as const, taskId, sessionId: ev.sessionId,
      stepIds: ev.stepIds, assertionResults,
      judgmentIds: ev.judgmentIds,
      causedBy: failed.map((f) => `assertion failed: ${f.detail}`),
      checkedAt,
    });
  }
  // 5. No failures — but PASS needs independent confirmation tied to the
  // GOAL, not to execution. verification-passed attests only that an
  // actuation ran and a post-frame was captured (stamped on every act,
  // including wait/observe) — it is deliberately NOT confirmation, or any
  // acted step would launder itself into a verdict. Likewise
  // signal-present/outcome-is match agent-written text. Confirmation is:
  // a supporting human judgment, or server-verified grounding (the acted
  // point demonstrably inside a region of the exact observed frame).
  const supporting = citedJudgments.filter((j) => j.reasonable && j.targetCorrect);
  const independent = assertionResults.filter(
    (r) => r.pass && r.kind === "grounding-verified",
  );
  if (supporting.length > 0 || independent.length > 0) {
    const causes = [
      ...supporting.map((j) => `human judgment ${j.id} by ${j.reviewer} supports step ${j.stepId}`),
      ...independent.map((r) => `independent evidence: ${r.detail}`),
      ...assertionResults.filter((r) => r.pass).map((r) => `oracle: ${r.detail}`),
    ];
    if (causes.length === 0) causes.push("evidence present with no failing assertions and independent confirmation");
    return ValidationResultSchema.parse({
      verdict: "PASS" as const, taskId, sessionId: ev.sessionId,
      stepIds: ev.stepIds, assertionResults,
      judgmentIds: supporting.map((j) => j.id),
      causedBy: causes, checkedAt,
    });
  }
  return ValidationResultSchema.parse({
    verdict: "INCONCLUSIVE" as const, taskId, sessionId: ev.sessionId,
    stepIds: ev.stepIds, assertionResults,
    judgmentIds: [],
    causedBy: ["no failing assertions, but no independent confirmation (supporting human judgment or server-verified grounding) — refusing to infer success"],
    checkedAt,
  });
}

// ── Blind-review queue: reviewers see claims WITHOUT confidence/rationale
// until their judgment is submitted. Plus agreement stats + ledger. ──

export const ReviewArtifactSchema = z.object({
  artifactId: z.string().min(1),
  sessionId: z.string().min(1),
  stepIds: z.array(z.string().min(1)).min(1),
  claims: z.array(z.string().min(1).max(1024)).min(1),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().max(4096).optional(),
  submittedBy: z.string().min(1),
  submittedAt: z.string().min(1),
});
export type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>;

/** What a reviewer sees BEFORE judging: no confidence, no rationale. */
export const BlindViewSchema = z.object({
  artifactId: z.string(),
  sessionId: z.string(),
  stepIds: z.array(z.string()),
  claims: z.array(z.string()),
  blind: z.literal(true),
});
export type BlindView = z.infer<typeof BlindViewSchema>;

export const JudgmentInputSchema = HumanJudgment.omit({ at: true }).extend({
  at: z.string().optional(),
});
export type JudgmentInput = z.infer<typeof JudgmentInputSchema>;

export const AgreementStatsSchema = z.object({
  stepId: z.string(),
  n: z.number().int().min(0),
  reasonableAgreement: z.number().min(0).max(1),
  targetCorrectAgreement: z.number().min(0).max(1),
  understandableAgreement: z.number().min(0).max(1),
  expectedAgreement: z.number().min(0).max(1),
  recoveryOkAgreement: z.number().min(0).max(1),
  pairwiseAgreement: z.number().min(0).max(1),
});
export type AgreementStats = z.infer<typeof AgreementStatsSchema>;

export const LedgerEntrySchema = z.object({
  entryId: z.string(),
  kind: z.enum(["correction", "takeover"]),
  stepId: z.string(),
  artifactId: z.string(),
  reviewer: z.string(),
  detail: z.string(),
  at: z.string(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

function majorityRate(votes: boolean[]): number {
  if (votes.length === 0) return 1;
  const trues = votes.filter(Boolean).length;
  return Math.max(trues, votes.length - trues) / votes.length;
}

function pairwiseRate(judgments: HumanJudgmentType[], pick: (j: HumanJudgmentType) => boolean): number {
  if (judgments.length < 2) return 1;
  let agree = 0;
  let total = 0;
  for (let i = 0; i < judgments.length; i += 1) {
    for (let k = i + 1; k < judgments.length; k += 1) {
      total += 1;
      const a = judgments[i];
      const b = judgments[k];
      if (a !== undefined && b !== undefined && pick(a) === pick(b)) agree += 1;
    }
  }
  return total === 0 ? 1 : agree / total;
}

interface StoredItem {
  artifact: ReviewArtifact;
  judgedBy: Set<string>;
}

export class BlindReviewQueue {
  private items = new Map<string, StoredItem>();
  private judgments: HumanJudgmentType[] = [];
  private ledger: LedgerEntry[] = [];

  enqueue(raw: unknown): string {
    const base = z
      .object({
        artifactId: z.string().min(1).optional(),
        sessionId: z.string().min(1),
        stepIds: z.array(z.string().min(1)).min(1),
        claims: z.array(z.string().min(1).max(1024)).min(1),
        confidence: z.number().min(0).max(1).optional(),
        rationale: z.string().max(4096).optional(),
        submittedBy: z.string().min(1),
      })
      .parse(raw);
    const artifact = ReviewArtifactSchema.parse({ ...base, artifactId: base.artifactId ?? uid("artifact"), submittedAt: nowIso() });
    if (this.items.has(artifact.artifactId)) throw new EveError("DUPLICATE_ARTIFACT", `Artifact ${artifact.artifactId} already queued`);
    this.items.set(artifact.artifactId, { artifact, judgedBy: new Set() });
    return artifact.artifactId;
  }

  /** Blind view hides confidence + rationale. Only full artifact holder can resolve. */
  blindView(artifactIdInput: unknown): BlindView {
    const artifactId = z.string().min(1).parse(artifactIdInput);
    const item = this.items.get(artifactId);
    if (!item) throw new EveError("UNKNOWN_ARTIFACT", `No review item ${artifactId}`);
    return BlindViewSchema.parse({
      artifactId: item.artifact.artifactId,
      sessionId: item.artifact.sessionId,
      stepIds: item.artifact.stepIds,
      claims: item.artifact.claims,
      blind: true,
    });
  }

  pendingFor(reviewerInput: unknown): BlindView[] {
    const reviewer = z.string().min(1).parse(reviewerInput);
    const out: BlindView[] = [];
    for (const item of this.items.values()) {
      if (!item.judgedBy.has(reviewer)) out.push(this.blindView(item.artifact.artifactId));
    }
    return out;
  }

  /** Submit a judgment made from the blind view only. Confidence/rationale unlock after. */
  submitJudgment(artifactIdInput: unknown, judgmentInput: unknown): { judgment: HumanJudgmentType; unlocked: ReviewArtifact } {
    const artifactId = z.string().min(1).parse(artifactIdInput);
    const item = this.items.get(artifactId);
    if (!item) throw new EveError("UNKNOWN_ARTIFACT", `No review item ${artifactId}`);
    const parsed = JudgmentInputSchema.parse(judgmentInput);
    if (!item.artifact.stepIds.includes(parsed.stepId)) {
      throw new EveError("STEP_NOT_IN_SCOPE", `Step ${parsed.stepId} is not part of artifact ${artifactId}`);
    }
    if (item.judgedBy.has(parsed.reviewer)) {
      throw new EveError("ALREADY_JUDGED", `Reviewer ${parsed.reviewer} already judged ${artifactId} — blind would be broken`);
    }
    const judgment = HumanJudgment.parse({ ...parsed, blind: true, at: parsed.at ?? nowIso() });
    this.judgments.push(judgment);
    item.judgedBy.add(judgment.reviewer);

    const unreasonable = !judgment.reasonable || !judgment.targetCorrect;
    if ((judgment.correction ?? "").trim().length > 0 || unreasonable) {
      this.ledger.push({
        entryId: uid("ledger"),
        kind: unreasonable ? "takeover" : "correction",
        stepId: judgment.stepId,
        artifactId,
        reviewer: judgment.reviewer,
        detail: (judgment.correction ?? judgment.note ?? "flagged without correction").slice(0, 500),
        at: nowIso(),
      });
    }
    return { judgment, unlocked: item.artifact };
  }

  judgmentsForStep(stepIdInput: unknown): HumanJudgmentType[] {
    const stepId = z.string().min(1).parse(stepIdInput);
    return this.judgments.filter((j) => j.stepId === stepId);
  }

  agreementForStep(stepIdInput: unknown): AgreementStats {
    const stepId = z.string().min(1).parse(stepIdInput);
    const js = this.judgmentsForStep(stepId);
    const rate = (pick: (j: HumanJudgmentType) => boolean): number =>
      js.length < 2 ? 1 : pairwiseRate(js, pick);
    const overall =
      (rate((j) => j.reasonable) +
        rate((j) => j.targetCorrect) +
        rate((j) => j.understandable) +
        rate((j) => j.expected) +
        rate((j) => j.recoveryOk)) /
      5;
    return AgreementStatsSchema.parse({
      stepId,
      n: js.length,
      reasonableAgreement: majorityRate(js.map((j) => j.reasonable)),
      targetCorrectAgreement: majorityRate(js.map((j) => j.targetCorrect)),
      understandableAgreement: majorityRate(js.map((j) => j.understandable)),
      expectedAgreement: majorityRate(js.map((j) => j.expected)),
      recoveryOkAgreement: majorityRate(js.map((j) => j.recoveryOk)),
      pairwiseAgreement: Math.round(overall * 1000) / 1000,
    });
  }

  agreementAll(): AgreementStats[] {
    const steps = [...new Set(this.judgments.map((j) => j.stepId))];
    return steps.map((s) => this.agreementForStep(s));
  }

  ledgerList(kindInput?: unknown): LedgerEntry[] {
    const kind = kindInput === undefined ? undefined : z.enum(["correction", "takeover"]).parse(kindInput);
    return this.ledger.filter((e) => (kind === undefined ? true : e.kind === kind)).map((e) => ({ ...e }));
  }

  size(): number {
    return this.items.size;
  }
}
