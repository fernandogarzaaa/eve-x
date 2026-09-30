import { z } from "zod";
import { EveError, nowIso, uid } from "../../core/src/index.js";
import { HumanJudgment, type HumanJudgment as HumanJudgmentType } from "../../protocol/src/index.js";

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
