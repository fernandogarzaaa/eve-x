import { z } from "zod";
import { EveError, StateMachine, nowIso, uid } from "../../core/src/index.js";
import { ComputerPercept } from "../../protocol/src/index.js";

// ── Human takeover: EVE_RUNNING → EVE_PAUSED → HUMAN_CONTROLS → REOBSERVE →
// RESUMED, with a MANDATORY re-observe between human control and resume.
// Skipping REOBSERVE is rejected. Plus an annotation API. ──

export const TakeoverStateSchema = z.enum(["EVE_RUNNING", "EVE_PAUSED", "HUMAN_CONTROLS", "REOBSERVE", "RESUMED"]);
export type TakeoverState = z.infer<typeof TakeoverStateSchema>;

const TAKEOVER_ALLOWED: Record<TakeoverState, TakeoverState[]> = {
  EVE_RUNNING: ["EVE_PAUSED"],
  EVE_PAUSED: ["HUMAN_CONTROLS", "EVE_RUNNING"],
  HUMAN_CONTROLS: ["REOBSERVE"],
  REOBSERVE: ["RESUMED"],
  RESUMED: ["EVE_RUNNING"],
};

export const TakeoverEventSchema = z.object({
  eventId: z.string(),
  from: TakeoverStateSchema,
  to: TakeoverStateSchema,
  actor: z.string().min(1).max(128),
  reason: z.string().max(1024).default(""),
  at: z.string(),
  reobserveRef: z.string().optional(),
});
export type TakeoverEvent = z.infer<typeof TakeoverEventSchema>;

export const AnnotationKindSchema = z.enum(["note", "correction", "label", "flag", "question"]);
export type AnnotationKind = z.infer<typeof AnnotationKindSchema>;

export const AnnotationSchema = z.object({
  annotationId: z.string(),
  sessionId: z.string().min(1),
  stepId: z.string().min(1).optional(),
  author: z.string().min(1).max(128),
  kind: AnnotationKindSchema,
  body: z.string().min(1).max(4096),
  at: z.string(),
});
export type Annotation = z.infer<typeof AnnotationSchema>;

export const AnnotationInputSchema = z.object({
  sessionId: z.string().min(1),
  stepId: z.string().min(1).optional(),
  author: z.string().min(1).max(128),
  kind: AnnotationKindSchema,
  body: z.string().min(1).max(4096),
});
export type AnnotationInput = z.infer<typeof AnnotationInputSchema>;

export class TakeoverController {
  private sm: StateMachine<TakeoverState>;
  private events: TakeoverEvent[] = [];
  private reobserveDigest: string | null = null;
  private pausedBy: string | null = null;

  constructor() {
    this.sm = new StateMachine<TakeoverState>("EVE_RUNNING", TAKEOVER_ALLOWED);
  }

  get state(): TakeoverState {
    return this.sm.state;
  }

  history(): TakeoverEvent[] {
    return this.events.map((e) => ({ ...e }));
  }

  private record(from: TakeoverState, to: TakeoverState, actor: string, reason: string, reobserveRef?: string): void {
    this.events.push({
      eventId: uid("tk"),
      from,
      to,
      actor: z.string().min(1).max(128).parse(actor),
      reason: z.string().max(1024).parse(reason),
      at: nowIso(),
      ...(reobserveRef !== undefined ? { reobserveRef } : {}),
    });
  }

  /** EVE (or operator) pauses autonomous control. */
  pause(actorInput: unknown, reasonInput: unknown): TakeoverState {
    const actor = z.string().min(1).max(128).parse(actorInput);
    const reason = z.string().max(1024).parse(reasonInput);
    const from = this.sm.state;
    try {
      this.sm.transition("EVE_PAUSED", `paused by ${actor}: ${reason}`);
    } catch {
      throw new EveError("INVALID_TAKEOVER", `Cannot pause from ${from}`);
    }
    this.pausedBy = actor;
    this.record(from, "EVE_PAUSED", actor, reason);
    return this.sm.state;
  }

  /** Human takes the controls; only from EVE_PAUSED. */
  humanTakeover(actorInput: unknown, reasonInput: unknown): TakeoverState {
    const actor = z.string().min(1).max(128).parse(actorInput);
    const reason = z.string().max(1024).parse(reasonInput);
    const from = this.sm.state;
    if (from !== "EVE_PAUSED") throw new EveError("INVALID_TAKEOVER", `Human takeover requires EVE_PAUSED, currently ${from}`);
    this.sm.transition("HUMAN_CONTROLS", `human ${actor} controls: ${reason}`);
    this.reobserveDigest = null; // any prior re-observe is stale once control changes
    this.record(from, "HUMAN_CONTROLS", actor, reason);
    return this.sm.state;
  }

  /** Mandatory fresh observation after human control, before resume is allowed. */
  reobserve(perceptInput: unknown, actorInput: unknown): string {
    const percept = ComputerPercept.parse(perceptInput);
    const actor = z.string().min(1).max(128).parse(actorInput);
    const from = this.sm.state;
    if (from !== "HUMAN_CONTROLS") throw new EveError("INVALID_TAKEOVER", `Re-observe requires HUMAN_CONTROLS, currently ${from}`);
    const digest = `reobs:${percept.frameId}:${percept.provenance.at}:${percept.width}x${percept.height}`;
    this.sm.transition("REOBSERVE", `re-observed frame ${percept.frameId} by ${actor}`);
    this.reobserveDigest = digest;
    this.record(from, "REOBSERVE", actor, `frame ${percept.frameId}`, digest);
    return digest;
  }

  /** Resume autonomous control; only from REOBSERVE with a recorded re-observe. */
  resume(actorInput: unknown, reasonInput: unknown): TakeoverState {
    const actor = z.string().min(1).max(128).parse(actorInput);
    const reason = z.string().max(1024).parse(reasonInput);
    const from = this.sm.state;
    if (from === "HUMAN_CONTROLS") {
      throw new EveError("REOBSERVE_REQUIRED", "Cannot resume directly from HUMAN_CONTROLS: mandatory re-observe missing");
    }
    if (from !== "REOBSERVE") throw new EveError("INVALID_TAKEOVER", `Cannot resume from ${from}`);
    if (this.reobserveDigest === null) throw new EveError("REOBSERVE_REQUIRED", "Resume requires a recorded re-observe digest");
    this.sm.transition("RESUMED", `resumed by ${actor}: ${reason}`);
    this.record(from, "RESUMED", actor, reason, this.reobserveDigest);
    this.reobserveDigest = null;
    return this.sm.state;
  }

  /** Cancel a pause that never escalated to human control. */
  cancelPause(actorInput: unknown, reasonInput: unknown): TakeoverState {
    const actor = z.string().min(1).max(128).parse(actorInput);
    const reason = z.string().max(1024).parse(reasonInput);
    const from = this.sm.state;
    if (from !== "EVE_PAUSED") throw new EveError("INVALID_TAKEOVER", `No pause to cancel from ${from}`);
    this.sm.transition("EVE_RUNNING", `pause cancelled by ${actor}: ${reason}`);
    this.record(from, "EVE_RUNNING", actor, reason);
    this.pausedBy = null;
    return this.sm.state;
  }

  /** Start a fresh autonomous cycle after a completed resume. */
  nextCycle(actorInput: unknown): TakeoverState {
    const actor = z.string().min(1).max(128).parse(actorInput);
    const from = this.sm.state;
    if (from !== "RESUMED") throw new EveError("INVALID_TAKEOVER", `Next cycle requires RESUMED, currently ${from}`);
    this.sm.transition("EVE_RUNNING", `new cycle by ${actor}`);
    this.record(from, "EVE_RUNNING", actor, "new cycle");
    this.pausedBy = null;
    return this.sm.state;
  }
}

export class AnnotationStore {
  private annotations: Annotation[] = [];

  add(raw: unknown): Annotation {
    const input = AnnotationInputSchema.parse(raw);
    const ann = AnnotationSchema.parse({ ...input, annotationId: uid("ann"), at: nowIso() });
    this.annotations.push(ann);
    return { ...ann };
  }

  listBySession(sessionIdInput: unknown): Annotation[] {
    const sessionId = z.string().min(1).parse(sessionIdInput);
    return this.annotations.filter((a) => a.sessionId === sessionId).map((a) => ({ ...a }));
  }

  listByStep(stepIdInput: unknown): Annotation[] {
    const stepId = z.string().min(1).parse(stepIdInput);
    return this.annotations.filter((a) => a.stepId === stepId).map((a) => ({ ...a }));
  }

  listByKind(kindInput: unknown): Annotation[] {
    const kind = AnnotationKindSchema.parse(kindInput);
    return this.annotations.filter((a) => a.kind === kind).map((a) => ({ ...a }));
  }

  count(): number {
    return this.annotations.length;
  }
}
