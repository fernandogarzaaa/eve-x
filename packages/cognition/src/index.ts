import { z } from "zod";
import { EveError, nowIso, prng, uid } from "../../core/src/index.js";
import { ComputerPercept } from "../../protocol/src/index.js";

// ── EVE-X cognition: persona/goal, working+episodic+semantic+spatial memory,
// attention, expectation engine, trust, emotion, load/fatigue, learning ──

// ── Persona & goal (validated at boundaries) ──
export const PersonaSchema = z.object({
  personaId: z.string().min(1),
  profile: z.string().min(1).default("first-time-user"),
  patience: z.number().min(0).max(1).default(0.6),
  expertise: z.number().min(0).max(1).default(0.3),
  riskTolerance: z.number().min(0).max(1).default(0.4),
  readingSpeedWpm: z.number().int().min(60).max(1200).default(220),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const GoalSchema = z.object({
  goalId: z.string().min(1),
  description: z.string().min(1).max(2048),
  successSignals: z.array(z.string().min(1).max(256)).default([]),
  priority: z.number().min(0).max(1).default(0.5),
});
export type Goal = z.infer<typeof GoalSchema>;

// ── Memory stores ──
export const WorkingMemoryEntrySchema = z.object({
  id: z.string(),
  content: z.string().max(1024),
  salience: z.number().min(0).max(1),
  addedAt: z.string(),
  lastAccessedAt: z.string(),
  accessCount: z.number().int().min(0),
});
export type WorkingMemoryEntry = z.infer<typeof WorkingMemoryEntrySchema>;

export const EpisodicEventSchema = z.object({
  id: z.string(),
  stepId: z.string(),
  seq: z.number().int().min(0),
  summary: z.string().max(1024),
  outcome: z.enum(["success", "partial", "failure", "error"]),
  at: z.string(),
});
export type EpisodicEvent = z.infer<typeof EpisodicEventSchema>;

export const SemanticFactSchema = z.object({
  key: z.string().min(1).max(256),
  value: z.string().max(1024),
  confidence: z.number().min(0).max(1),
  observations: z.number().int().min(1),
  updatedAt: z.string(),
});
export type SemanticFact = z.infer<typeof SemanticFactSchema>;

export const SpatialNodeSchema = z.object({
  regionId: z.string(),
  label: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  visits: z.number().int().min(0),
  lastSeenAt: z.string(),
  stable: z.boolean(),
});
export type SpatialNode = z.infer<typeof SpatialNodeSchema>;

// ── Attention / emotion / expectation ──
export const AttentionStateSchema = z.object({
  focusRegionId: z.string().optional(),
  focusLabel: z.string().optional(),
  selectiveGain: z.number().min(0).max(1),
  scanBreadth: z.number().int().min(1).max(12),
  dwellSteps: z.number().int().min(0),
});
export type AttentionState = z.infer<typeof AttentionStateSchema>;

export const EmotionStateSchema = z.object({
  label: z.enum(["calm", "focused", "curious", "frustrated", "anxious", "satisfied", "confused"]),
  valence: z.number().min(-1).max(1),
  arousal: z.number().min(0).max(1),
});
export type EmotionState = z.infer<typeof EmotionStateSchema>;

export const ExpectationSchema = z.object({
  expectationId: z.string(),
  stepSeq: z.number().int().min(0),
  prediction: z.string().min(1).max(1024),
  actual: z.string().max(1024).optional(),
  matched: z.boolean().optional(),
  surprise: z.number().min(0).max(1).optional(),
  at: z.string(),
});
export type Expectation = z.infer<typeof ExpectationSchema>;

export const CognitionStateSchema = z.object({
  persona: PersonaSchema,
  goal: GoalSchema,
  working: z.array(WorkingMemoryEntrySchema).max(12),
  episodic: z.array(EpisodicEventSchema),
  semantic: z.array(SemanticFactSchema),
  spatial: z.array(SpatialNodeSchema),
  attention: AttentionStateSchema,
  emotion: EmotionStateSchema,
  trust: z.number().min(0).max(1),
  cognitiveLoad: z.number().min(0).max(1),
  fatigue: z.number().min(0).max(1),
  expectations: z.array(ExpectationSchema),
  stepCount: z.number().int().min(0),
  updatedAt: z.string(),
});
export type CognitionState = z.infer<typeof CognitionStateSchema>;

const WORKING_CAPACITY = 7;
const MAX_WORKING = 12;

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length > 2);
}

function keywordOverlap(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit / Math.max(ta.size, tb.size);
}

export interface PerceiveContext {
  stepSeq: number;
  stepId: string;
  goalProgress: string;
}

const PerceiveContextSchema = z.object({
  stepSeq: z.number().int().min(0),
  stepId: z.string().min(1),
  goalProgress: z.string().max(2048),
});

export class CognitiveEngine {
  private state: CognitionState;
  private rand: () => number;

  constructor(personaInput: unknown, goalInput: unknown, seed = 42) {
    const persona = PersonaSchema.parse(personaInput);
    const goal = GoalSchema.parse(goalInput);
    this.rand = prng(seed);
    this.state = {
      persona,
      goal,
      working: [],
      episodic: [],
      semantic: [],
      spatial: [],
      attention: { selectiveGain: 0.5, scanBreadth: 5, dwellSteps: 0 },
      emotion: { label: "calm", valence: 0.1, arousal: 0.3 },
      trust: 0.6,
      cognitiveLoad: 0.15,
      fatigue: 0,
      expectations: [],
      stepCount: 0,
      updatedAt: nowIso(),
    };
  }

  snapshot(): CognitionState {
    return CognitionStateSchema.parse(structuredClone(this.state));
  }

  restore(raw: unknown): void {
    this.state = CognitionStateSchema.parse(raw);
  }

  /** perceive: fold one ComputerPercept into a new cognition state for this step. */
  perceive(perceptInput: unknown, ctxInput: unknown): CognitionState {
    const percept = ComputerPercept.parse(perceptInput);
    const ctx = PerceiveContextSchema.parse(ctxInput);
    const s = this.state;

    // 1. Working memory: note salient regions + progress; evict low salience beyond capacity.
    const now = nowIso();
    const salient = [...percept.regions]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);
    for (const r of salient) {
      const salience = clamp01(0.35 + r.confidence * 0.5 + keywordOverlap(r.label, s.goal.description) * 0.4);
      s.working.push({
        id: uid("wm"),
        content: `saw ${r.label} (${r.regionId}) conf=${r.confidence.toFixed(2)}`,
        salience,
        addedAt: now,
        lastAccessedAt: now,
        accessCount: 0,
      });
    }
    s.working.push({
      id: uid("wm"),
      content: `progress@${ctx.stepSeq}: ${ctx.goalProgress.slice(0, 220)}`,
      salience: 0.8,
      addedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
    });
    // Decay + evict: keep highest salience, hard cap MAX_WORKING.
    for (const w of s.working) w.salience = clamp01(w.salience - 0.03);
    s.working.sort((a, b) => b.salience - a.salience);
    s.working = s.working.slice(0, MAX_WORKING);

    // 2. Spatial memory: upsert region nodes, mark stable after 3 visits with same label.
    for (const r of percept.regions) {
      const node = s.spatial.find((n) => n.regionId === r.regionId);
      if (node) {
        node.visits += 1;
        node.lastSeenAt = now;
        if (node.label === r.label && node.visits >= 3) node.stable = true;
        else if (node.label !== r.label) {
          node.label = r.label;
          node.stable = false;
        }
        node.bbox = [r.bbox[0], r.bbox[1], r.bbox[2], r.bbox[3]];
      } else {
        s.spatial.push({
          regionId: r.regionId,
          label: r.label,
          bbox: [r.bbox[0], r.bbox[1], r.bbox[2], r.bbox[3]],
          visits: 1,
          lastSeenAt: now,
          stable: false,
        });
      }
    }
    if (s.spatial.length > 64) {
      s.spatial.sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? -1 : 1));
      s.spatial = s.spatial.slice(s.spatial.length - 64);
    }

    // 3. Attention: focus highest goal-relevant confident region; dwell or shift.
    let bestId: string | undefined;
    let bestLabel: string | undefined;
    let bestScore = -1;
    for (const r of percept.regions) {
      const score = r.confidence * 0.6 + keywordOverlap(r.label, s.goal.description) * 0.4;
      if (score > bestScore) {
        bestScore = score;
        bestId = r.regionId;
        bestLabel = r.label;
      }
    }
    if (bestId !== undefined && bestId === s.attention.focusRegionId) {
      s.attention.dwellSteps += 1;
      s.attention.selectiveGain = clamp01(s.attention.selectiveGain + 0.05);
    } else {
      s.attention.focusRegionId = bestId;
      s.attention.focusLabel = bestLabel;
      s.attention.dwellSteps = 0;
      s.attention.selectiveGain = clamp01(0.4 + Math.max(0, bestScore) * 0.4);
    }
    const loadPressure = s.working.length / WORKING_CAPACITY;
    s.attention.scanBreadth = Math.max(1, Math.min(12, Math.round(7 - loadPressure * 4)));
    void this.rand();

    // 4. Load & fatigue recompute.
    const novelRegions = percept.regions.filter(
      (r) => !s.spatial.some((n) => n.regionId === r.regionId && n.visits > 1),
    ).length;
    s.cognitiveLoad = clamp01(
      0.12 + (s.working.length / MAX_WORKING) * 0.5 + (novelRegions / 8) * 0.25 + (percept.loading ? 0.12 : 0),
    );
    s.fatigue = clamp01(s.fatigue + 0.012 + s.cognitiveLoad * 0.008 - s.persona.patience * 0.004);

    s.stepCount += 1;
    s.updatedAt = now;
    return this.snapshot();
  }

  /** Register a prediction about the next observation; returns the expectation id. */
  predict(predictionInput: unknown, stepSeq: number): string {
    const parsed = z.string().min(1).max(1024).parse(predictionInput);
    if (!Number.isInteger(stepSeq) || stepSeq < 0) throw new EveError("INVALID_SEQ", "stepSeq must be a non-negative integer");
    const id = uid("exp");
    this.state.expectations.push({ expectationId: id, stepSeq, prediction: parsed, at: nowIso() });
    if (this.state.expectations.length > 200) this.state.expectations = this.state.expectations.slice(-200);
    this.state.updatedAt = nowIso();
    return id;
  }

  /** Expectation engine: compare prediction vs actual, update surprise/trust/emotion. */
  compareExpectation(expectationIdInput: unknown, actualInput: unknown): Expectation {
    const expectationId = z.string().min(1).parse(expectationIdInput);
    const actual = z.string().min(1).max(1024).parse(actualInput);
    const exp = this.state.expectations.find((e) => e.expectationId === expectationId);
    if (!exp) throw new EveError("UNKNOWN_EXPECTATION", `No expectation ${expectationId}`);
    if (exp.matched !== undefined) throw new EveError("EXPECTATION_SETTLED", `Expectation ${expectationId} already compared`);
    const overlap = keywordOverlap(exp.prediction, actual);
    const matched = overlap >= 0.4 || exp.prediction.trim().toLowerCase() === actual.trim().toLowerCase();
    const surprise = clamp01(matched ? (1 - overlap) * 0.5 : 0.55 + (1 - overlap) * 0.45);
    exp.actual = actual;
    exp.matched = matched;
    exp.surprise = surprise;
    // Trust: EMA toward 1 on match, toward 0.15 on mismatch; surprise dampens.
    const target = matched ? 1 : 0.15;
    const rate = matched ? 0.18 : 0.3;
    this.state.trust = clamp01(this.state.trust + (target - this.state.trust) * rate * (1 - surprise * 0.4));
    // Emotion shift.
    this.shiftEmotion(matched ? 0.12 : -0.18, surprise * 0.5);
    this.state.updatedAt = nowIso();
    return { ...exp };
  }

  /** Outcome update: trust/emotion/fatigue + episodic + semantic learning. */
  updateAfterOutcome(
    outcomeInput: unknown,
    summaryInput: unknown,
    stepRefInput: unknown,
  ): CognitionState {
    const outcome = z.enum(["success", "partial", "failure", "error"]).parse(outcomeInput);
    const summary = z.string().min(1).max(1024).parse(summaryInput);
    const stepRef = z.object({ stepId: z.string().min(1), seq: z.number().int().min(0) }).parse(stepRefInput);
    const s = this.state;
    const now = nowIso();
    s.episodic.push({ id: uid("ep"), stepId: stepRef.stepId, seq: stepRef.seq, summary, outcome, at: now });
    if (s.episodic.length > 500) s.episodic = s.episodic.slice(-500);

    if (outcome === "success") {
      s.trust = clamp01(s.trust + (1 - s.trust) * 0.12);
      s.fatigue = clamp01(s.fatigue - 0.03);
      this.shiftEmotion(0.15, -0.05);
    } else if (outcome === "partial") {
      s.trust = clamp01(s.trust - 0.03);
      this.shiftEmotion(0.02, 0.08);
    } else {
      s.trust = clamp01(s.trust - (outcome === "error" ? 0.14 : 0.09));
      s.fatigue = clamp01(s.fatigue + 0.03);
      this.shiftEmotion(-0.14, 0.18);
    }
    this.learnFromSummary(summary, outcome);
    s.stepCount += 0; // step count advances in perceive(); outcome update keeps cadence explicit.
    s.updatedAt = now;
    return this.snapshot();
  }

  private shiftEmotion(dValence: number, dArousal: number): void {
    const e = this.state.emotion;
    e.valence = clamp01((e.valence + 1) / 2 + dValence * 0.5) * 2 - 1;
    e.valence = Math.min(1, Math.max(-1, e.valence));
    e.arousal = clamp01(e.arousal + dArousal);
    e.label =
      e.valence > 0.35 && e.arousal < 0.6 ? "satisfied"
      : e.valence < -0.4 && e.arousal > 0.6 ? "frustrated"
      : e.valence < -0.25 ? "anxious"
      : e.arousal > 0.65 ? "confused"
      : e.arousal < 0.35 ? "calm"
      : this.state.cognitiveLoad > 0.6 ? "focused"
      : "curious";
  }

  /** Learning update: extract stable key=value observations into semantic memory. */
  private learnFromSummary(summary: string, outcome: "success" | "partial" | "failure" | "error"): void {
    const facts = extractFacts(summary);
    for (const f of facts) {
      const existing = this.state.semantic.find((k) => k.key === f.key);
      if (existing) {
        existing.observations += 1;
        if (existing.value === f.value) {
          existing.confidence = clamp01(existing.confidence + 0.1);
        } else if (outcome === "success") {
          existing.value = f.value;
          existing.confidence = clamp01(0.5);
        } else {
          existing.confidence = clamp01(existing.confidence - 0.08);
        }
        existing.updatedAt = nowIso();
      } else {
        this.state.semantic.push({
          key: f.key,
          value: f.value,
          confidence: outcome === "success" ? 0.65 : 0.4,
          observations: 1,
          updatedAt: nowIso(),
        });
      }
    }
    if (this.state.semantic.length > 300) {
      this.state.semantic.sort((a, b) => a.confidence - b.confidence);
      this.state.semantic = this.state.semantic.slice(this.state.semantic.length - 300);
    }
  }

  recallWorking(queryInput: unknown, topK = 5): WorkingMemoryEntry[] {
    const query = z.string().min(1).max(1024).parse(queryInput);
    const k = Math.max(1, Math.min(12, topK));
    return [...this.state.working]
      .map((w) => ({ w, score: keywordOverlap(w.content, query) * 0.7 + w.salience * 0.3 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((r) => {
        r.w.accessCount += 1;
        r.w.lastAccessedAt = nowIso();
        return { ...r.w };
      });
  }
}

function extractFacts(summary: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  // Pattern 1: "label X is at ..." / "X = value" style pairs.
  const eqRe = /([a-zA-Z][a-zA-Z0-9 _-]{2,40})\s*[:=]\s*([a-zA-Z0-9 _\-./]{1,80})/g;
  let m: RegExpExecArray | null;
  while ((m = eqRe.exec(summary)) !== null) {
    const key = (m[1] ?? "").trim().toLowerCase().replace(/\s+/g, "_");
    const value = (m[2] ?? "").trim();
    if (key && value) out.push({ key, value });
    if (out.length >= 5) break;
  }
  // Pattern 2: clicked/opened landmarks become location facts.
  const landmarkRe = /(?:clicked|opened|focused)\s+([a-zA-Z][a-zA-Z0-9 _-]{2,40})/gi;
  while ((m = landmarkRe.exec(summary)) !== null) {
    const name = (m[1] ?? "").trim().toLowerCase().replace(/\s+/g, "_");
    if (name) out.push({ key: `landmark:${name}`, value: "interacted" });
    if (out.length >= 8) break;
  }
  return out;
}
