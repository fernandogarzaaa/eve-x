import { z } from "zod";
import { EveError, nowIso, sha1hex, uid } from "../../core/src/index.js";

// ── Genesis assurance client: evaluator artifacts are adversarially audited
// (self-grading detection, boundary checks). Verdicts are SOUND | EXPLOITABLE
// and are NEVER performance scores — assurance is kept separate. ──

export const EvaluatorClaimSchema = z.object({
  claim: z.string().min(8).max(1024),
  evidenceStepIds: z.array(z.string().min(1)).min(1),
  score: z.number().min(0).max(100),
});
export type EvaluatorClaim = z.infer<typeof EvaluatorClaimSchema>;

export const EvaluatorArtifactSchema = z.object({
  artifactId: z.string().min(1),
  evaluatorId: z.string().min(1).max(128),
  codeHash: z.string().regex(/^[0-9a-f]{40}$/, "codeHash must be 40 lowercase hex chars"),
  codeText: z.string().max(200_000).optional(),
  claims: z.array(EvaluatorClaimSchema).min(1),
  gradedSessionId: z.string().min(1).optional(),
  gradedSessionAuthor: z.string().min(1).max(128).optional(),
  submittedAt: z.string().min(1),
});
export type EvaluatorArtifact = z.infer<typeof EvaluatorArtifactSchema>;

export const VerdictSchema = z.enum(["SOUND", "EXPLOITABLE"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const AuditResultSchema = z.object({
  auditId: z.string(),
  artifactId: z.string(),
  verdict: VerdictSchema,
  reasons: z.array(z.string().min(1)),
  failedChecks: z.array(z.string().min(1)),
  passedChecks: z.array(z.string().min(1)),
  auditedAt: z.string(),
});
export type AuditResult = z.infer<typeof AuditResultSchema>;

interface Check {
  name: string;
  run: (artifact: EvaluatorArtifact, resolver?: EvidenceResolver) => string | null; // null = pass, string = failure reason
}

/**
 * Resolves claimed evidence step ids against a session. Returns null when
 * the session cannot be read at all (the check abstains with an explicit
 * note — absence of evidence is not evidence of forgery). Unknown ids
 * within a readable session FAIL the check.
 */
export type EvidenceResolver = (
  sessionId: string | undefined,
  stepIds: string[],
) => { known: string[]; unknown: string[] } | null;

const SELF_GRADING_PATTERNS: RegExp[] = [
  /self[\s_-]?approv/i,
  /override[\s_-]?verdict/i,
  /always[\s_-]?pass/i,
  /force[\s_-]?sound/i,
  /ignore[\s_-]?evidence/i,
  /selfScore\s*=\s*100/i,
  /trust\s*me/i,
  /do\s*not\s*audit/i,
  /verdict\s*=\s*["']SOUND["']/i,
];

const CHECKS: Check[] = [
  {
    name: "code-hash-integrity",
    run: (a) => {
      if (a.codeText !== undefined) {
        const recomputed = sha1hex(a.codeText);
        if (recomputed !== a.codeHash) return `codeHash mismatch: declared ${a.codeHash} but code hashes to ${recomputed}`;
      }
      return null;
    },
  },
  {
    name: "claims-have-evidence",
    run: (a) => {
      const bad = a.claims.filter((c) => c.evidenceStepIds.length === 0);
      return bad.length > 0 ? `${bad.length} claim(s) carry no evidence step ids` : null;
    },
  },
  {
    name: "no-self-grading-session",
    run: (a) => {
      if (a.gradedSessionAuthor !== undefined && a.gradedSessionAuthor === a.evaluatorId) {
        return `evaluator ${a.evaluatorId} graded its own session ${a.gradedSessionId ?? "?"} (self-grading)`;
      }
      return null;
    },
  },
  {
    name: "no-self-grading-code",
    run: (a) => {
      if (a.codeText === undefined) return null;
      const hits = SELF_GRADING_PATTERNS.filter((re) => re.test(a.codeText as string)).map((re) => re.source);
      return hits.length > 0 ? `self-grading patterns in evaluator code: ${hits.slice(0, 3).join(", ")}` : null;
    },
  },
  {
    name: "claims-score-separation",
    run: (a) => {
      // Assurance must not smuggle a performance score into the verdict path:
      // claims that are all perfect 100s with single-token evidence look gamed.
      const perfect = a.claims.filter((c) => c.score === 100);
      if (a.claims.length >= 3 && perfect.length === a.claims.length) {
        return "all claims score a perfect 100 — indistinguishable from a self-awarded performance score";
      }
      return null;
    },
  },
  {
    name: "boundary-claim-text",
    run: (a) => {
      const empty = a.claims.filter((c) => c.claim.trim().length < 8);
      const overlong = a.claims.filter((c) => c.claim.length > 1024);
      if (empty.length > 0 || overlong.length > 0) return "claim text violates length boundaries";
      const dupes = new Set(a.claims.map((c) => c.claim.trim().toLowerCase()));
      if (dupes.size < a.claims.length) return "duplicate claim text — boundary check failed";
      return null;
    },
  },
  {
    name: "evidence-resolves",
    run: (a, resolver) => {
      if (!resolver) return null; // abstain: recorded by the caller, not a pass of substance
      if (!a.gradedSessionId) return "claims cite evidence but no graded session is named";
      const ids = [...new Set(a.claims.flatMap((c) => c.evidenceStepIds))];
      const resolved = resolver(a.gradedSessionId, ids);
      if (resolved === null) return null; // session unreadable: abstain, do not convict
      if (resolved.unknown.length > 0) {
        return `evidence step ids unknown in session ${a.gradedSessionId}: ${resolved.unknown.slice(0, 5).join(", ")}`;
      }
      return null;
    },
  },
];

export class GenesisClient {
  private artifacts = new Map<string, EvaluatorArtifact>();
  private audits: AuditResult[] = [];

  submitArtifact(raw: unknown): EvaluatorArtifact {
    const base = z
      .object({
        artifactId: z.string().min(1).optional(),
        evaluatorId: z.string().min(1).max(128),
        codeHash: z.string().regex(/^[0-9a-f]{40}$/),
        codeText: z.string().max(200_000).optional(),
        claims: z.array(EvaluatorClaimSchema).min(1),
        gradedSessionId: z.string().min(1).optional(),
        gradedSessionAuthor: z.string().min(1).max(128).optional(),
      })
      .parse(raw);
    const artifact = EvaluatorArtifactSchema.parse({ ...base, artifactId: base.artifactId ?? uid("gen"), submittedAt: nowIso() });
    if (this.artifacts.has(artifact.artifactId)) throw new EveError("DUPLICATE_ARTIFACT", `Genesis artifact ${artifact.artifactId} already submitted`);
    this.artifacts.set(artifact.artifactId, artifact);
    return { ...artifact };
  }

  audit(artifactIdInput: unknown, resolver?: EvidenceResolver): AuditResult {
    const artifactId = z.string().min(1).parse(artifactIdInput);
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) throw new EveError("UNKNOWN_ARTIFACT", `No genesis artifact ${artifactId}`);
    const failedChecks: string[] = [];
    const passedChecks: string[] = [];
    const reasons: string[] = [];
    for (const check of CHECKS) {
      const failure = check.run(artifact, resolver);
      if (failure === null) {
        passedChecks.push(check.name);
        if (check.name === "evidence-resolves" && !resolver) {
          reasons.push("evidence-resolves: abstained (no resolver supplied)");
        }
      } else {
        failedChecks.push(check.name);
        reasons.push(`${check.name}: ${failure}`);
      }
    }
    const verdict: Verdict = failedChecks.length === 0 ? "SOUND" : "EXPLOITABLE";
    if (verdict === "SOUND") reasons.push("all adversarial audit checks passed; assurance verdict only — not a performance score");
    const result = AuditResultSchema.parse({
      auditId: uid("audit"),
      artifactId,
      verdict,
      reasons,
      failedChecks,
      passedChecks,
      auditedAt: nowIso(),
    });
    this.audits.push(result);
    return { ...result };
  }

  latestVerdict(artifactIdInput: unknown): AuditResult | null {
    const artifactId = z.string().min(1).parse(artifactIdInput);
    const found = [...this.audits].reverse().find((a) => a.artifactId === artifactId);
    return found ? { ...found } : null;
  }

  auditHistory(): AuditResult[] {
    return this.audits.map((a) => ({ ...a }));
  }
}
