import { z } from "zod";
import { EveError, nowIso, prng, uid } from "../../core/src/index.js";
import {
  ActionIR,
  ActionType,
  ComputerPercept,
  TraceStep,
  type ActionIR as ActionIRType,
  type ComputerPercept as ComputerPerceptType,
  type TraceStep as TraceStepType,
} from "../../protocol/src/index.js";

// ── EVE-X CUA agent: OBSERVE→INTERPRET→PLAN→GROUND→VERIFY→ACT→
// OBSERVE RESULT→COMPARE→UPDATE, with active perception & recovery ──

// Minimal structural runtime interface (local; no cross-package dep).
export interface ActResult {
  screenAfter: string;
  vmStateAfter: string;
  outcome: string;
  latencyMs: number;
}

export interface ComputerRuntimeLike {
  observe(): Promise<ComputerPerceptType>;
  act(action: ActionIRType): Promise<ActResult>;
  currentVmState(): string;
}

const ActResultSchema = z.object({
  screenAfter: z.string().min(1),
  vmStateAfter: z.string().min(1),
  outcome: z.string().min(1),
  latencyMs: z.number().min(0),
});

export const AgentConfigSchema = z.object({
  agentId: z.string().min(1),
  modelVersion: z.string().min(1).default("eve-cua-1.0.0"),
  environmentVersion: z.string().min(1).default("ubuntu-desktop-v1"),
  maxSteps: z.number().int().min(1).max(500).default(60),
  confidenceThreshold: z.number().min(0).max(1).default(0.45),
  requireGrounding: z.boolean().default(true),
  allowAskHuman: z.boolean().default(true),
  seed: z.number().int().default(42),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const AgentTaskSchema = z.object({
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  goal: z.string().min(1).max(2048),
  successSignals: z.array(z.string().min(1).max(256)).default([]),
  maxSteps: z.number().int().min(1).max(500).optional(),
});
export type AgentTask = z.infer<typeof AgentTaskSchema>;

export const TrajectoryPhaseSchema = z.enum([
  "OBSERVE",
  "INTERPRET",
  "PLAN",
  "GROUND",
  "VERIFY",
  "ACT",
  "OBSERVE_RESULT",
  "COMPARE",
  "UPDATE",
  "RECOVER",
  "DONE",
]);
export type TrajectoryPhase = z.infer<typeof TrajectoryPhaseSchema>;

export interface TrajectoryState {
  phase: TrajectoryPhase;
  seq: number;
  goal: string;
  lastPrediction: string | null;
  lastSelected: ActionIRType | null;
  consecutiveFailures: number;
  done: boolean;
  outcome: string | null;
}

const TERMINAL_HINTS = ["terminal", "cli", "command", "shell", "ssh", "bash", "console command"];
const TOOL_HINTS = ["api", "tool", "evaluator", "script", "download", "upload", "query"];
const DESTRUCTIVE_HINTS = ["delete", "format", "rm -rf", "drop", "destroy", "purchase", "payment"];

function includesHint(text: string, hints: string[]): boolean {
  const lower = text.toLowerCase();
  return hints.some((h) => lower.includes(h));
}

function centerOf(bbox: [number, number, number, number]): { x: number; y: number } {
  return { x: Math.round((bbox[0] + bbox[2]) / 2), y: Math.round((bbox[1] + bbox[3]) / 2) };
}

export class EveCuaAgent {
  readonly config: AgentConfig;
  private rand: () => number;

  constructor(configInput: unknown) {
    this.config = AgentConfigSchema.parse(configInput);
    this.rand = prng(this.config.seed);
  }

  /** INTERPRET: summarize what the screen affords relative to the goal. */
  interpret(perceptInput: unknown, goalInput: unknown): string {
    const percept = ComputerPercept.parse(perceptInput);
    const goal = z.string().min(1).max(2048).parse(goalInput);
    const top = [...percept.regions].sort((a, b) => b.confidence - a.confidence).slice(0, 5);
    const names = top.map((r) => `${r.label}(${r.confidence.toFixed(2)})`).join(", ") || "no labeled regions";
    const flags: string[] = [];
    if (percept.loading) flags.push("page/app loading");
    if (percept.dialogs.length > 0) flags.push(`dialogs: ${percept.dialogs.join("; ").slice(0, 160)}`);
    if (percept.windows.length > 0) flags.push(`windows: ${percept.windows.slice(0, 4).join(", ")}`);
    return `goal="${goal.slice(0, 180)}" affords=[${names}]${flags.length > 0 ? ` notes=${flags.join(" | ")}` : ""}`;
  }

  /** PLAN: candidate actions ranked; modality = GUI | CLI | TOOL. */
  proposeCandidates(perceptInput: unknown, goalInput: unknown): ActionIRType[] {
    const percept = ComputerPercept.parse(perceptInput);
    const goal = z.string().min(1).max(2048).parse(goalInput);
    const candidates: ActionIRType[] = [];
    const useCli = includesHint(goal, TERMINAL_HINTS);
    const useTool = !useCli && includesHint(goal, TOOL_HINTS);

    if (percept.loading) {
      candidates.push({ type: "wait", ms: 1500, intent: "wait for load", confidence: 0.85 });
      candidates.push({ type: "observe", intent: "re-observe after load", confidence: 0.7 });
    }
    const rankedRegions = [...percept.regions].sort((a, b) => b.confidence - a.confidence).slice(0, 6);
    if (rankedRegions.length === 0) {
      // Sparse screen: active perception before acting.
      candidates.push({ type: "zoom", intent: "zoom to inspect sparse screen", confidence: 0.55 });
      candidates.push({ type: "observe", intent: "systematic re-scan", confidence: 0.5 });
      if (useCli) {
        candidates.push({ type: "terminal", text: "ls", intent: "cli fallback listing", confidence: 0.5 });
      }
    }
    for (const r of rankedRegions) {
      const goalHit =
        goal.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2).length > 0 &&
        goal.toLowerCase().includes(r.label.toLowerCase().split(" ")[0] ?? "");
      const c = centerOf(r.bbox);
      candidates.push({
        type: "click",
        target: { kind: "visual-region", regionId: r.regionId, bbox: r.bbox, label: r.label, confidence: r.confidence },
        from: { x: percept.cursor.x, y: percept.cursor.y },
        to: { x: c.x, y: c.y },
        intent: `click ${r.label} toward goal`,
        confidence: Math.min(0.95, r.confidence * (goalHit ? 1 : 0.8) + (goalHit ? 0.1 : 0)),
      });
    }
    if (useCli) {
      candidates.push({ type: "terminal", text: goal.slice(0, 200), intent: "cli modality for terminal goal", confidence: 0.72 });
    } else if (useTool) {
      candidates.push({ type: "tool", text: goal.slice(0, 200), intent: "tool modality for api/script goal", confidence: 0.68 });
    } else {
      candidates.push({ type: "scroll", delta: { dx: 0, dy: -320 }, intent: "reveal more content", confidence: 0.4 });
      candidates.push({ type: "type", text: goal.slice(0, 120), intent: "type goal into focused field", confidence: 0.38 });
    }
    if (this.config.allowAskHuman) {
      candidates.push({ type: "ask_human", text: `Need guidance for: ${goal.slice(0, 140)}`, intent: "escalate ambiguity", confidence: 0.25 });
    }
    candidates.push({ type: "terminate", intent: "abandon: goal unreachable", confidence: 0.1 });
    // Deterministic tie-break by seeded jitter, then confidence desc.
    return candidates
      .map((c) => ({ c, jitter: this.rand() * 0.02 }))
      .sort((a, b) => b.c.confidence + b.jitter - (a.c.confidence + a.jitter))
      .map((r) => ActionIR.parse(r.c));
  }

  /** Active perception: zoom/crop/wait/ask_human emitted as trace actions when needed. */
  activePerceptionDecision(perceptInput: unknown): ActionIRType | null {
    const percept = ComputerPercept.parse(perceptInput);
    if (percept.loading) {
      return ActionIR.parse({ type: "wait", ms: 2000, intent: "active-perception: await load", confidence: 0.9 });
    }
    if (percept.regions.length === 0) {
      return ActionIR.parse({ type: "zoom", intent: "active-perception: zoom on empty screen", confidence: 0.6 });
    }
    const lowConf = percept.regions.filter((r) => r.confidence < this.config.confidenceThreshold);
    if (lowConf.length > 0 && lowConf.length === percept.regions.length && percept.regions.length <= 3) {
      const first = lowConf[0];
      if (!first) return null;
      return ActionIR.parse({
        type: "crop",
        target: { kind: "visual-region", regionId: first.regionId, bbox: first.bbox, label: first.label, confidence: first.confidence },
        intent: "active-perception: crop ambiguous region",
        confidence: 0.62,
      });
    }
    return null;
  }

  /** GROUND: verify the selected action resolves to a real on-screen region/bounds. */
  ground(actionInput: unknown, perceptInput: unknown): { verified: boolean; reason: string; regionId?: string } {
    const action = ActionIR.parse(actionInput);
    const percept = ComputerPercept.parse(perceptInput);
    if (action.type === "wait" || action.type === "observe" || action.type === "terminate" || action.type === "ask_human") {
      return { verified: true, reason: `${action.type} needs no spatial grounding` };
    }
    if (action.type === "terminal" || action.type === "tool" || action.type === "type" || action.type === "key" || action.type === "hotkey") {
      return { verified: true, reason: `${action.type} grounded to focused context` };
    }
    const t = action.target;
    if (!t || t.kind !== "visual-region") {
      return { verified: false, reason: "spatial action missing visual-region target" };
    }
    const region = percept.regions.find((r) => r.regionId === t.regionId);
    if (!region) return { verified: false, reason: `region ${t.regionId} not present in current frame ${percept.frameId}` };
    const [x1, y1, x2, y2] = t.bbox;
    if (x1 < 0 || y1 < 0 || x2 > percept.width || y2 > percept.height || x2 <= x1 || y2 <= y1) {
      return { verified: false, reason: `bbox [${x1},${y1},${x2},${y2}] outside ${percept.width}x${percept.height}` };
    }
    if (region.confidence < this.config.confidenceThreshold * 0.6) {
      return { verified: false, reason: `region confidence ${region.confidence} below floor` };
    }
    return { verified: true, reason: `grounded to ${region.regionId} (${region.label})`, regionId: region.regionId };
  }

  /** VERIFY: policy + safety gate before acting. */
  verify(actionInput: unknown, goalInput: unknown): { passed: boolean; reason: string } {
    const action = ActionIR.parse(actionInput);
    const goal = z.string().min(1).max(2048).parse(goalInput);
    const text = `${action.text ?? ""} ${action.intent ?? ""} ${goal}`;
    if (action.type === "terminate") return { passed: true, reason: "termination always permitted" };
    if (includesHint(text, DESTRUCTIVE_HINTS)) {
      return { passed: false, reason: "destructive/external action requires human approval" };
    }
    if (action.confidence < this.config.confidenceThreshold && action.type !== "wait" && action.type !== "observe") {
      return { passed: false, reason: `confidence ${action.confidence.toFixed(2)} below threshold ${this.config.confidenceThreshold}` };
    }
    return { passed: true, reason: "policy + confidence gate passed" };
  }

  /** Full loop over a runtime; emits one evidence TraceStep per iteration. */
  async execute(taskInput: unknown, runtime: ComputerRuntimeLike): Promise<{ steps: TraceStepType[]; outcome: string; success: boolean }> {
    const task = AgentTaskSchema.parse(taskInput);
    const maxSteps = task.maxSteps ?? this.config.maxSteps;
    const steps: TraceStepType[] = [];
    const state: TrajectoryState = {
      phase: "OBSERVE",
      seq: 0,
      goal: task.goal,
      lastPrediction: null,
      lastSelected: null,
      consecutiveFailures: 0,
      done: false,
      outcome: null,
    };

    for (let seq = 0; seq < maxSteps && !state.done; seq += 1) {
      state.seq = seq;
      const startedAt = Date.now();
      state.phase = "OBSERVE";
      const screenBefore = runtime.currentVmState();
      const percept = await runtime.observe();

      state.phase = "INTERPRET";
      const interpretation = this.interpret(percept, task.goal);

      state.phase = "PLAN";
      const active = this.activePerceptionDecision(percept);
      let candidates = this.proposeCandidates(percept, task.goal);
      if (active) candidates = [active, ...candidates.filter((c) => c.type !== active.type || c.intent !== active.intent)];

      // Select first candidate passing VERIFY; prefer grounded ones.
      state.phase = "GROUND";
      let selected: ActionIRType | null = null;
      let grounding: TraceStepType["grounding"] = undefined;
      let verification: { passed: boolean; reason: string } = { passed: false, reason: "no candidate" };
      for (const cand of candidates) {
        const g = this.ground(cand, percept);
        if (this.config.requireGrounding && !g.verified && (cand.type === "click" || cand.type === "drag" || cand.type === "move")) {
          continue;
        }
        const v = this.verify(cand, task.goal);
        if (!v.passed) continue;
        selected = cand;
        grounding = { regionId: g.regionId, verified: g.verified, reason: g.reason };
        if (cand.target !== undefined && cand.target.kind === "visual-region") {
          grounding = { regionId: g.regionId ?? cand.target.regionId, bbox: cand.target.bbox, verified: g.verified, reason: g.reason };
        }
        verification = v;
        break;
      }

      state.phase = "VERIFY";
      if (selected === null) {
        // RECOVER: nothing passed the gate → wait + re-observe, or escalate.
        state.phase = "RECOVER";
        state.consecutiveFailures += 1;
        if (this.config.allowAskHuman && state.consecutiveFailures >= 3) {
          selected = ActionIR.parse({ type: "ask_human", text: `Stuck on: ${task.goal.slice(0, 160)}`, intent: "recovery escalation", confidence: 0.5 });
          verification = { passed: true, reason: "recovery escalation to human" };
          grounding = { verified: true, reason: "no grounding needed for ask_human" };
        } else {
          selected = ActionIR.parse({ type: "wait", ms: 1200, intent: "recovery: pause and re-observe", confidence: 0.7 });
          verification = { passed: true, reason: "recovery wait permitted" };
          grounding = { verified: true, reason: "no grounding needed for wait" };
        }
      }

      // Prediction for COMPARE step.
      const prediction =
        selected.type === "terminate"
          ? "session ends"
          : `after ${selected.type} ${selected.intent ?? ""}, screen advances toward goal`.slice(0, 280);
      state.lastPrediction = prediction;
      state.lastSelected = selected;

      state.phase = "ACT";
      const screenBeforeRef = `${task.sessionId}:frame:${percept.frameId}`;
      let result: ActResult;
      try {
        const raw = await runtime.act(selected);
        result = ActResultSchema.parse(raw);
        if (selected.type === "terminate") {
          state.done = true;
          state.outcome = "terminated by agent";
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "unknown act error";
        result = { screenAfter: screenBeforeRef, vmStateAfter: screenBefore, outcome: `error: ${msg}`.slice(0, 280), latencyMs: Date.now() - startedAt };
        state.consecutiveFailures += 1;
      }

      state.phase = "OBSERVE_RESULT";
      const lowered = result.outcome.toLowerCase();
      const signalHit = task.successSignals.some((s) => lowered.includes(s.toLowerCase()) || result.screenAfter.toLowerCase().includes(s.toLowerCase()));
      const failed = lowered.startsWith("error") || lowered.includes("fail");

      state.phase = "COMPARE";
      const matchedPrediction = !failed && (signalHit || lowered.includes("success") || lowered.includes("advance"));
      if (failed) state.consecutiveFailures += 1;
      else if (signalHit) state.consecutiveFailures = 0;

      state.phase = "UPDATE";
      if (signalHit || lowered.includes("goal achieved") || lowered.includes("task complete")) {
        state.done = true;
        state.outcome = result.outcome;
      } else if (selected.type === "ask_human") {
        state.done = true;
        state.outcome = `awaiting human: ${selected.text ?? ""}`.slice(0, 280);
      }

      const stepId = uid("step");
      const latency = result.latencyMs !== undefined ? result.latencyMs : Date.now() - startedAt;
      const stepRaw = {
        session_id: task.sessionId,
        task_id: task.taskId,
        step_id: stepId,
        seq,
        timestamp: nowIso(),
        actor: "eve-agent" as const,
        vm_state_before: screenBefore,
        screen_before: screenBeforeRef,
        goal: `${task.goal} | ${interpretation}`.slice(0, 500),
        candidate_actions: candidates.slice(0, 8),
        selected_action: { ...selected, verification },
        grounding,
        prediction,
        verification,
        actual_action: selected,
        screen_after: result.screenAfter,
        vm_state_after: result.vmStateAfter,
        outcome: state.phase === "UPDATE" ? result.outcome : result.outcome,
        latency_ms: latency,
        trust: matchedPrediction ? 0.7 : 0.45,
        cognitive_load: Math.min(1, 0.2 + candidates.length / 20),
        human_intervention: selected.type === "ask_human",
        provenance: { source: "guest-agent" as const, channel: "eve-cua-agent", at: nowIso() },
        model_version: this.config.modelVersion,
        environment_version: this.config.environmentVersion,
      };
      const parsed = TraceStep.parse(stepRaw);
      void ActionType;
      steps.push(parsed);
    }

    const lastOutcome = state.outcome ?? (steps.length > 0 ? (steps[steps.length - 1]?.outcome ?? "budget exhausted") : "no steps");
    const success = /success|achieved|complete/i.test(lastOutcome) && !/fail|error/i.test(lastOutcome);
    if (steps.length === 0) throw new EveError("NO_TRAJECTORY", "Agent produced no steps within budget");
    return { steps, outcome: lastOutcome, success };
  }
}
