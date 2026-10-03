import { z } from "zod";

// ── Canonical EVE-X protocol (single schema authority, §53) ──
// Coordinate convention (binding everywhere: perception, grounding,
// ActionIR, verifier IoU, console overlays): BBox is inclusive pixel
// corners [x0, y0, x1, y1]. Point-in-region tests and IoU assume this.
export const Point = z.object({ x: z.number().int().min(0), y: z.number().int().min(0) });
export type Point = z.infer<typeof Point>;
export const BBox = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type BBox = z.infer<typeof BBox>;

export const ActionType = z.enum([
  "click","double_click","move","drag","type","key","hotkey","scroll","wait",
  "observe","zoom","crop","open_application","terminal","tool","ask_human","terminate"
]);
export type ActionType = z.infer<typeof ActionType>;

export const VisualRegion = z.object({
  kind: z.literal("visual-region"),
  regionId: z.string(),
  bbox: BBox,
  label: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export const ActionIR = z.object({
  type: ActionType,
  target: VisualRegion.or(z.object({ kind: z.literal("none") })).optional(),
  text: z.string().max(4096).optional(),
  keys: z.array(z.string().max(64)).max(8).optional(),
  delta: z.object({ dx: z.number(), dy: z.number() }).optional(),
  ms: z.number().int().min(0).max(60000).optional(),
  intent: z.string().max(256).optional(),
  confidence: z.number().min(0).max(1),
  verification: z.object({ passed: z.boolean(), reason: z.string().optional() }).optional(),
  from: Point.optional(), to: Point.optional(),
});
export type ActionIR = z.infer<typeof ActionIR>;

export const Provenance = z.object({
  source: z.enum(["screenshot","guest-agent","evaluator-tool","human","world-model","system"]),
  channel: z.string(),
  at: z.string(),
});
export type Provenance = z.infer<typeof Provenance>;

export const ComputerPercept = z.object({
  frameId: z.string(),
  width: z.number().int(), height: z.number().int(),
  pngBase64: z.string(),
  regions: z.array(z.object({ regionId: z.string(), bbox: BBox, label: z.string(), confidence: z.number() })),
  cursor: Point,
  windows: z.array(z.string()),
  dialogs: z.array(z.string()),
  loading: z.boolean(),
  provenance: Provenance,
});
export type ComputerPercept = z.infer<typeof ComputerPercept>;

export const Actor = z.enum(["host-ai","eve-agent","human","evaluator","system"]);
export type Actor = z.infer<typeof Actor>;

export const TraceStep = z.object({
  session_id: z.string(), task_id: z.string(), step_id: z.string(),
  seq: z.number().int(), timestamp: z.string(),
  actor: Actor,
  vm_state_before: z.string(), screen_before: z.string(),
  goal: z.string(), attention_state: z.string().optional(),
  candidate_actions: z.array(ActionIR),
  selected_action: ActionIR.optional(),
  grounding: z.object({ regionId: z.string().optional(), bbox: BBox.optional(), verified: z.boolean(), reason: z.string().optional() }).optional(),
  prediction: z.string().optional(),
  verification: z.object({ passed: z.boolean(), reason: z.string().optional() }).optional(),
  actual_action: ActionIR.optional(),
  screen_after: z.string().optional(), vm_state_after: z.string().optional(),
  outcome: z.string().optional(), latency_ms: z.number().optional(),
  emotion: z.string().optional(), trust: z.number().optional(), cognitive_load: z.number().optional(),
  human_intervention: z.boolean().default(false), human_judgment: z.string().optional(),
  provenance: Provenance,
  model_version: z.string(), environment_version: z.string(),
});
export type TraceStep = z.infer<typeof TraceStep>;

export const VmSpec = z.object({
  image: z.string().default("ubuntu-desktop-v1"),
  snapshot: z.string().default("clean"),
  cpu: z.number().int().min(1).max(32).default(4),
  memoryMb: z.number().int().min(512).max(65536).default(8192),
  diskGb: z.number().int().min(8).max(512).default(32),
  width: z.number().int().default(1920), height: z.number().int().default(1080),
  locale: z.string().default("en-US"), timezone: z.string().default("UTC"),
  network: z.enum(["none","allowlisted","full"]).default("allowlisted"),
});
export type VmSpec = z.infer<typeof VmSpec>;

export const VmState = z.enum(["CREATING","CREATED","BOOTING","READY","RUNNING","PAUSING","PAUSED","RESTORING","FORKING","STOPPING","STOPPED","FAILED","DESTROYING","DESTROYED"]);
export type VmState = z.infer<typeof VmState>;

export const TaskSpec = z.object({
  taskId: z.string(), goal: z.string(),
  persona: z.string().default("first-time-user"),
  seed: z.number().int().default(42),
  vm: VmSpec, maxSteps: z.number().int().default(60),
  policy: z.object({
    allowDestructive: z.boolean().default(false),
    allowExternalComms: z.boolean().default(false),
    allowCredentialUse: z.boolean().default(false),
    requireApprovalFor: z.array(z.string()).default(["destructive","purchase","data-export"]),
  }).default({}),
});
export type TaskSpec = z.infer<typeof TaskSpec>;

export const HumanJudgment = z.object({
  stepId: z.string(), reviewer: z.string(),
  reasonable: z.boolean(), targetCorrect: z.boolean(),
  understandable: z.boolean(), expected: z.boolean(), recoveryOk: z.boolean(),
  correction: z.string().optional(), note: z.string().optional(),
  blind: z.boolean().default(true), at: z.string(),
});
export type HumanJudgment = z.infer<typeof HumanJudgment>;

export const Capability = z.enum([
  "vm:create","vm:control","vm:destroy","computer:observe","computer:act",
  "human:takeover","trace:read","trace:export","model:invoke","task:execute","admin"
]);
export type Capability = z.infer<typeof Capability>;
