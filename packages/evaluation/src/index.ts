import { z } from "zod";
import { EveError, nowIso } from "../../core/src/index.js";
import { HumanJudgment, TraceStep, type TraceStep as TraceStepType } from "../../protocol/src/index.js";

// ── EVE-X experience scoring: every finding carries {claim, evidence stepIds, score}.
// Vibes-only scores are rejected: empty trajectories or evidence-free findings throw. ──

export const DimensionSchema = z.enum([
  "task_success",
  "usability",
  "learnability",
  "navigation",
  "efficiency",
  "error_recovery",
  "responsiveness",
  "cognitive_load",
  "trust",
  "expectation_alignment",
  "accessibility",
  "visual_clarity",
]);
export type Dimension = z.infer<typeof DimensionSchema>;

export const SeveritySchema = z.enum(["info", "minor", "major", "critical"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FindingSchema = z.object({
  dimension: DimensionSchema,
  claim: z.string().min(8).max(1024),
  evidenceStepIds: z.array(z.string().min(1)).min(1),
  score: z.number().min(0).max(100),
  severity: SeveritySchema,
  detail: z.string().max(2048).optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const ExperienceReportSchema = z.object({
  reportId: z.string(),
  sessionId: z.string(),
  taskId: z.string(),
  overall: z.number().min(0).max(100),
  grade: z.enum(["A", "B", "C", "D", "F"]),
  findings: z.array(FindingSchema).min(1),
  evaluatedAt: z.string(),
  modelVersion: z.string(),
  environmentVersion: z.string(),
});
export type ExperienceReport = z.infer<typeof ExperienceReportSchema>;

function requireEvidence(stepIds: string[], dimension: string): string[] {
  if (stepIds.length === 0) throw new EveError("NO_EVIDENCE", `Dimension ${dimension}: score requires ≥1 evidence step id`);
  return [...new Set(stepIds)];
}

function avg(nums: number[], fallback: number): number {
  if (nums.length === 0) return fallback;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function clampScore(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.round(Math.min(100, Math.max(0, v)) * 10) / 10;
}

function outcomeOf(step: TraceStepType): string {
  return (step.outcome ?? "").toLowerCase();
}

function isSuccessOutcome(o: string): boolean {
  return /success|achieved|complete|done/.test(o) && !/fail|error|unsuccess/.test(o);
}

function isFailureOutcome(o: string): boolean {
  return /fail|error|stuck|blocked/.test(o);
}

export interface ScoreOptions {
  sessionId: string;
  taskId: string;
  modelVersion?: string;
  environmentVersion?: string;
  judgmentsInput?: unknown;
}

function successStepIds(steps: TraceStepType[]): string[] {
  return steps.filter((s) => isSuccessOutcome(outcomeOf(s))).map((s) => s.step_id);
}

export function scoreTaskSuccess(steps: TraceStepType[]): Finding {
  const ids = successStepIds(steps);
  if (ids.length > 0) {
    const lastIdx = steps.findIndex((s) => s.step_id === ids[ids.length - 1]);
    const efficiency = 1 - lastIdx / Math.max(1, steps.length);
    return FindingSchema.parse({
      dimension: "task_success",
      claim: `Goal achieved at step ${lastIdx + 1}/${steps.length} with outcome evidence.`,
      evidenceStepIds: requireEvidence([ids[ids.length - 1] as string], "task_success"),
      score: clampScore(72 + efficiency * 28),
      severity: "info",
    });
  }
  const ev = steps.filter((s) => outcomeOf(s).length > 0).map((s) => s.step_id);
  if (ev.length === 0) throw new EveError("NO_EVIDENCE", "Dimension task_success: trajectory has no outcome text to judge");
  const partial = steps.some((s) => /partial|progress|advance/i.test(s.outcome ?? ""));
  return FindingSchema.parse({
    dimension: "task_success",
    claim: partial ? "Goal not achieved; partial progress observed before budget end." : "Goal not achieved within the step budget.",
    evidenceStepIds: requireEvidence([ev[ev.length - 1] as string, ev[0] as string], "task_success"),
    score: clampScore(partial ? 38 : 12),
    severity: "critical",
  });
}

export function scoreUsability(steps: TraceStepType[]): Finding {
  const interventions = steps.filter((s) => s.human_intervention).map((s) => s.step_id);
  const rate = interventions.length / steps.length;
  const ev = interventions.length > 0 ? interventions : [steps[steps.length - 1]?.step_id ?? "", steps[0]?.step_id ?? ""].filter(Boolean);
  return FindingSchema.parse({
    dimension: "usability",
    claim:
      interventions.length === 0
        ? `No human takeovers across ${steps.length} steps; flow ran autonomously.`
        : `${interventions.length}/${steps.length} steps required human takeover (${Math.round(rate * 100)}%).`,
    evidenceStepIds: requireEvidence(ev, "usability"),
    score: clampScore(100 - rate * 90),
    severity: rate > 0.3 ? "major" : rate > 0 ? "minor" : "info",
  });
}

export function scoreLearnability(steps: TraceStepType[]): Finding {
  const lat = steps.map((s) => s.latency_ms ?? 0).filter((n) => n > 0);
  if (lat.length < 2) {
    const ev = steps.slice(0, 2).map((s) => s.step_id);
    if (ev.length === 0) throw new EveError("NO_EVIDENCE", "Dimension learnability: no steps");
    return FindingSchema.parse({
      dimension: "learnability",
      claim: "Insufficient latency samples to judge learning curve; single-observation session.",
      evidenceStepIds: requireEvidence(ev, "learnability"),
      score: 55,
      severity: "minor",
    });
  }
  const first = avg(lat.slice(0, Math.ceil(lat.length / 2)), 0);
  const second = avg(lat.slice(Math.ceil(lat.length / 2)), 0);
  const improving = second < first;
  const ratio = first > 0 ? (first - second) / first : 0;
  return FindingSchema.parse({
    dimension: "learnability",
    claim: improving
      ? `Mean effort fell ${Math.round(ratio * 100)}% in the second half — operator adapted.`
      : "No measurable speed-up in the second half — interface did not get easier with practice.",
    evidenceStepIds: requireEvidence([steps[0]?.step_id ?? "", steps[steps.length - 1]?.step_id ?? ""], "learnability"),
    score: clampScore(improving ? 65 + Math.min(0.5, ratio) * 70 : 48),
    severity: improving ? "info" : "minor",
  });
}

export function scoreNavigation(steps: TraceStepType[]): Finding {
  const revisits = new Set<string>();
  const seenScreens = new Set<string>();
  let loops = 0;
  for (const s of steps) {
    const key = s.screen_after ?? s.screen_before;
    if (key && seenScreens.has(key)) {
      loops += 1;
      revisits.add(s.step_id);
    }
    if (key) seenScreens.add(key);
  }
  const ev = revisits.size > 0 ? [...revisits].slice(0, 4) : steps.slice(0, Math.min(2, steps.length)).map((s) => s.step_id);
  return FindingSchema.parse({
    dimension: "navigation",
    claim:
      loops === 0
        ? `Forward-only traversal across ${seenScreens.size} distinct screens — no loops.`
        : `${loops} screen revisit(s) detected — operator looped instead of progressing.`,
    evidenceStepIds: requireEvidence(ev, "navigation"),
    score: clampScore(100 - loops * 22),
    severity: loops >= 3 ? "major" : loops > 0 ? "minor" : "info",
  });
}

export function scoreEfficiency(steps: TraceStepType[]): Finding {
  const waits = steps.filter((s) => s.selected_action?.type === "wait" || s.selected_action?.type === "observe").length;
  const wasteRatio = waits / steps.length;
  const ev = steps.length > 0 ? [steps[0]?.step_id ?? "", steps[steps.length - 1]?.step_id ?? ""] : [];
  return FindingSchema.parse({
    dimension: "efficiency",
    claim: `${steps.length} steps, ${waits} passive (wait/observe). Waste ratio ${Math.round(wasteRatio * 100)}%.`,
    evidenceStepIds: requireEvidence(ev.filter(Boolean), "efficiency"),
    score: clampScore(steps.length <= 8 ? 92 : Math.max(8, 96 - steps.length * 2.2 - wasteRatio * 30)),
    severity: wasteRatio > 0.4 || steps.length > 40 ? "major" : wasteRatio > 0.2 ? "minor" : "info",
  });
}

export function scoreErrorRecovery(steps: TraceStepType[]): Finding {
  const failIdx: number[] = [];
  steps.forEach((s, i) => {
    if (isFailureOutcome(outcomeOf(s))) failIdx.push(i);
  });
  if (failIdx.length === 0) {
    return FindingSchema.parse({
      dimension: "error_recovery",
      // Labeled as unexercised, not recovered: the 80 is a neutral UX prior
      // for clean runs, excluded from any success reading by the grade gate.
      claim: "No errors encountered; recovery path unexercised (nothing to recover from — not evidence of recovery skill).",
      evidenceStepIds: requireEvidence(steps.slice(0, 2).map((s) => s.step_id), "error_recovery"),
      score: 80,
      severity: "info",
    });
  }
  let recovered = 0;
  const ev: string[] = [];
  for (const i of failIdx) {
    const next = steps.slice(i + 1, i + 4);
    const ok = next.some((s) => isSuccessOutcome(outcomeOf(s)));
    if (ok) recovered += 1;
    const f = steps[i];
    if (f) ev.push(f.step_id);
    const r = next.find((s) => isSuccessOutcome(outcomeOf(s)));
    if (r) ev.push(r.step_id);
  }
  const rate = recovered / failIdx.length;
  return FindingSchema.parse({
    dimension: "error_recovery",
    claim: `${recovered}/${failIdx.length} error episodes recovered within 3 steps.`,
    evidenceStepIds: requireEvidence(ev.slice(0, 6), "error_recovery"),
    score: clampScore(rate * 100),
    severity: rate < 0.4 ? "major" : rate < 0.8 ? "minor" : "info",
  });
}

export function scoreResponsiveness(steps: TraceStepType[]): Finding {
  const lat = steps.map((s) => s.latency_ms ?? 0).filter((n) => n > 0);
  if (lat.length === 0) throw new EveError("NO_EVIDENCE", "Dimension responsiveness: no latency_ms samples recorded");
  const p95 = [...lat].sort((a, b) => a - b)[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] ?? 0;
  const slowIdx = steps.findIndex((s) => (s.latency_ms ?? 0) >= p95);
  const slow = steps[slowIdx];
  return FindingSchema.parse({
    dimension: "responsiveness",
    claim: `p95 action latency ${Math.round(p95)}ms over ${lat.length} samples (avg ${Math.round(avg(lat, 0))}ms).`,
    evidenceStepIds: requireEvidence([slow?.step_id ?? steps[0]?.step_id ?? ""].filter(Boolean), "responsiveness"),
    score: clampScore(p95 <= 800 ? 95 : p95 <= 2500 ? 70 : p95 <= 6000 ? 45 : 20),
    severity: p95 > 6000 ? "major" : p95 > 2500 ? "minor" : "info",
  });
}

export function scoreCognitiveLoad(steps: TraceStepType[]): Finding {
  const loads = steps.map((s) => s.cognitive_load ?? 0.5);
  const mean = avg(loads, 0.5);
  const peak = steps.reduce((best, s) => ((s.cognitive_load ?? 0) > (best.cognitive_load ?? 0) ? s : best), steps[0] as TraceStepType);
  return FindingSchema.parse({
    dimension: "cognitive_load",
    claim: `Mean modeled load ${mean.toFixed(2)} (peak ${((peak?.cognitive_load ?? 0) as number).toFixed(2)} at step ${(peak?.seq ?? 0) + 1}).`,
    evidenceStepIds: requireEvidence([peak?.step_id ?? "", steps[0]?.step_id ?? ""].filter(Boolean), "cognitive_load"),
    score: clampScore(100 - mean * 85),
    severity: mean > 0.7 ? "major" : mean > 0.5 ? "minor" : "info",
  });
}

export function scoreTrust(steps: TraceStepType[]): Finding {
  const trusts = steps.map((s) => s.trust).filter((t): t is number => typeof t === "number");
  if (trusts.length === 0) throw new EveError("NO_EVIDENCE", "Dimension trust: no trust samples recorded on steps");
  const mean = avg(trusts, 0.5);
  const last = steps[steps.length - 1];
  return FindingSchema.parse({
    dimension: "trust",
    claim: `Mean operator trust ${mean.toFixed(2)} across ${trusts.length} samples; ended at ${(trusts[trusts.length - 1] ?? 0).toFixed(2)}.`,
    evidenceStepIds: requireEvidence([last?.step_id ?? "", steps[0]?.step_id ?? ""].filter(Boolean), "trust"),
    score: clampScore(mean * 100),
    severity: mean < 0.4 ? "major" : mean < 0.6 ? "minor" : "info",
  });
}

export function scoreExpectationAlignment(steps: TraceStepType[]): Finding {
  const withPred = steps.filter((s) => (s.prediction ?? "").length > 0 && (s.outcome ?? "").length > 0);
  if (withPred.length === 0) throw new EveError("NO_EVIDENCE", "Dimension expectation_alignment: no steps carry both prediction and outcome");
  let aligned = 0;
  const ev: string[] = [];
  for (const s of withPred) {
    const p = (s.prediction ?? "").toLowerCase();
    const o = (s.outcome ?? "").toLowerCase();
    const tokens = p.split(/[^a-z0-9]+/).filter((t) => t.length > 3);
    const hit = tokens.some((t) => o.includes(t));
    if (hit) {
      aligned += 1;
      if (ev.length < 4) ev.push(s.step_id);
    }
  }
  if (ev.length === 0) ev.push(withPred[0]?.step_id ?? "", withPred[withPred.length - 1]?.step_id ?? "");
  const rate = aligned / withPred.length;
  return FindingSchema.parse({
    dimension: "expectation_alignment",
    claim: `${aligned}/${withPred.length} predictions lexically aligned with observed outcomes.`,
    evidenceStepIds: requireEvidence(ev.filter(Boolean), "expectation_alignment"),
    score: clampScore(rate * 100),
    severity: rate < 0.4 ? "major" : rate < 0.7 ? "minor" : "info",
  });
}

export function scoreAccessibility(steps: TraceStepType[]): Finding {
  const keyboard = steps.filter((s) => s.selected_action?.type === "key" || s.selected_action?.type === "hotkey").length;
  const zooms = steps.filter((s) => s.selected_action?.type === "zoom" || s.selected_action?.type === "crop").length;
  const ev = steps.filter((s) => ["key", "hotkey", "zoom", "crop"].includes(s.selected_action?.type ?? "")).map((s) => s.step_id);
  const fallback = steps.slice(0, 2).map((s) => s.step_id);
  return FindingSchema.parse({
    dimension: "accessibility",
    claim: `${keyboard} keyboard-driven actions, ${zooms} zoom/crop perception aids across ${steps.length} steps.`,
    evidenceStepIds: requireEvidence((ev.length > 0 ? ev.slice(0, 4) : fallback).filter(Boolean), "accessibility"),
    score: clampScore(55 + Math.min(30, keyboard * 6) + Math.min(15, zooms * 5)),
    severity: keyboard === 0 && zooms === 0 ? "minor" : "info",
  });
}

export function scoreVisualClarity(steps: TraceStepType[]): Finding {
  const grounded = steps.filter((s) => s.grounding?.verified).length;
  const rate = grounded / steps.length;
  const bad = steps.find((s) => s.grounding && !s.grounding.verified);
  return FindingSchema.parse({
    dimension: "visual_clarity",
    claim: `${grounded}/${steps.length} actions grounded to verified on-screen targets${bad ? `; first grounding miss: "${(bad.grounding?.reason ?? "").slice(0, 120)}"` : ""}.`,
    evidenceStepIds: requireEvidence([(bad ?? steps[0])?.step_id ?? "", steps[steps.length - 1]?.step_id ?? ""].filter(Boolean), "visual_clarity"),
    score: clampScore(35 + rate * 65),
    severity: rate < 0.5 ? "major" : rate < 0.8 ? "minor" : "info",
  });
}

const SCORERS: Array<(steps: TraceStepType[]) => Finding> = [
  scoreTaskSuccess,
  scoreUsability,
  scoreLearnability,
  scoreNavigation,
  scoreEfficiency,
  scoreErrorRecovery,
  scoreResponsiveness,
  scoreCognitiveLoad,
  scoreTrust,
  scoreExpectationAlignment,
  scoreAccessibility,
  scoreVisualClarity,
];

function gradeFor(overall: number, taskSuccessScore?: number): "A" | "B" | "C" | "D" | "F" {
  // The overall mean must never mask task failure: a trajectory that did
  // not succeed cannot grade above D no matter how clean its UX dimensions.
  // `overall` is a UX rollup, NOT a success measure — consumers must read
  // the task_success finding alongside it.
  let grade: "A" | "B" | "C" | "D" | "F";
  if (overall >= 85) grade = "A";
  else if (overall >= 70) grade = "B";
  else if (overall >= 55) grade = "C";
  else if (overall >= 40) grade = "D";
  else grade = "F";
  if (taskSuccessScore !== undefined && taskSuccessScore < 50 && (grade === "A" || grade === "B" || grade === "C")) {
    grade = "D";
  }
  return grade;
}

/** Score a full trajectory; throws NO_EVIDENCE when there is nothing to score. */
export function scoreExperience(stepsInput: unknown, optsInput: unknown): ExperienceReport {
  const steps = z.array(TraceStep).min(1).parse(stepsInput);
  const opts = z
    .object({
      sessionId: z.string().min(1),
      taskId: z.string().min(1),
      modelVersion: z.string().min(1).default("unknown"),
      environmentVersion: z.string().min(1).default("unknown"),
      judgmentsInput: z.unknown().optional(),
    })
    .parse(optsInput);
  if (opts.judgmentsInput !== undefined) {
    z.array(HumanJudgment).parse(opts.judgmentsInput);
  }
  const findings = SCORERS.map((fn) => fn(steps));
  const overall = clampScore(avg(findings.map((f) => f.score), 0));
  const taskSuccess = findings.find((f) => f.dimension === "task_success")?.score;
  return ExperienceReportSchema.parse({
    reportId: `expr-${steps[0]?.session_id ?? opts.sessionId}-${Date.now().toString(36)}`,
    sessionId: opts.sessionId,
    taskId: opts.taskId,
    overall,
    grade: gradeFor(overall, taskSuccess),
    findings,
    evaluatedAt: nowIso(),
    modelVersion: opts.modelVersion,
    environmentVersion: opts.environmentVersion,
  });
}
