import { promises as fs } from "node:fs";
import { z } from "zod";
import { ActionIR } from "../../protocol/src/index.js";
import { EveError, sha256hex } from "../../core/src/index.js";

// ── Schemas ──────────────────────────────────────────────────────────────────

const TransitionCounts = z.record(z.string(), z.record(z.string(), z.record(z.string(), z.number().int().min(0))));
type TransitionCounts = z.infer<typeof TransitionCounts>;

export const PredictResult = z.object({
  hash: z.string(),
  confidence: z.number().min(0).max(1),
  known: z.boolean(),
});
export type PredictResult = z.infer<typeof PredictResult>;

export const CompareResult = z.object({
  divergence: z.number().min(0).max(1),
  match: z.boolean(),
  explanation: z.string(),
});
export type CompareResult = z.infer<typeof CompareResult>;

export const WorldModelOptions = z.object({
  path: z.string().min(1),
  autosave: z.boolean().default(true),
});
export type WorldModelOptions = z.infer<typeof WorldModelOptions>;

/** Stable hash of a percept frame (frameId + png payload). */
export function hashPercept(input: unknown): string {
  const s = z.string().min(1).max(16777216).parse(input);
  return sha256hex(s);
}

/** Learned transition table: perceptHash -> actionKey -> nextHash -> count. */
export class WorldModel {
  private readonly path: string;
  private readonly autosave: boolean;
  private table: TransitionCounts = {};
  private observations = 0;

  constructor(optsInput: unknown) {
    const opts = WorldModelOptions.parse(optsInput);
    this.path = opts.path;
    this.autosave = opts.autosave;
  }

  static actionKey(actionInput: unknown): string {
    const a = typeof actionInput === "string" ? actionInput : ActionIR.parse(actionInput).type;
    if (typeof actionInput === "string") return z.string().max(512).parse(actionInput);
    const full = ActionIR.parse(actionInput);
    const target = full.target && full.target.kind === "visual-region"
      ? `${full.target.regionId}:${full.target.bbox.join(",")}`
      : "none";
    const textPart = full.text ? `#${sha256hex(full.text).slice(0, 12)}` : "";
    const keyPart = full.keys ? `:${full.keys.join("+")}` : "";
    return `${full.type}@${target}${textPart}${keyPart}`;
  }

  async load(): Promise<{ transitions: number; observations: number }> {
    let raw: string;
    try {
      raw = await fs.readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.table = {};
        this.observations = 0;
        return { transitions: 0, observations: 0 };
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new EveError("WORLD_MODEL_CORRUPT", `World-model file is not JSON: ${this.path}`);
    }
    const doc = z.object({ table: TransitionCounts, observations: z.number().int().min(0) }).parse(parsed);
    this.table = doc.table;
    this.observations = doc.observations;
    return { transitions: this.transitionCount(), observations: this.observations };
  }

  async save(): Promise<void> {
    const doc = JSON.stringify({ table: this.table, observations: this.observations });
    await fs.mkdir(this.path.split(/[/\\]/).slice(0, -1).join("/") || ".", { recursive: true });
    await fs.writeFile(this.path, doc, "utf8");
  }

  async record(perceptHashInput: unknown, actionInput: unknown, nextHashInput: unknown): Promise<void> {
    const p = z.string().min(1).max(128).parse(perceptHashInput);
    const key = WorldModel.actionKey(actionInput);
    const n = z.string().min(1).max(128).parse(nextHashInput);
    if (!this.table[p]) this.table[p] = {};
    const row = this.table[p] as Record<string, Record<string, number>>;
    if (!row[key]) row[key] = {};
    const cell = row[key] as Record<string, number>;
    cell[n] = (cell[n] ?? 0) + 1;
    this.observations++;
    if (this.autosave) await this.save();
  }

  /** Most-likely next state hash; unknown when the transition was never seen. */
  predictNextStateHash(perceptHashInput: unknown, actionInput: unknown): PredictResult {
    const p = z.string().min(1).max(128).parse(perceptHashInput);
    const key = WorldModel.actionKey(actionInput);
    const row = this.table[p]?.[key];
    if (!row) return { hash: "unknown", confidence: 0, known: false };
    let best = "";
    let bestCount = -1;
    let total = 0;
    for (const [h, c] of Object.entries(row)) {
      total += c;
      if (c > bestCount) { bestCount = c; best = h; }
    }
    if (total === 0) return { hash: "unknown", confidence: 0, known: false };
    return {
      hash: best,
      confidence: Math.round((bestCount / total) * 1000) / 1000,
      known: true,
    };
  }

  /**
   * Divergence between predicted and actual next-state hashes: 0 on exact
   * match, otherwise normalized hex hamming distance. Feeds action search
   * (prefer low-divergence plans) and failure diagnosis (high divergence
   * flags a surprising transition worth inspecting).
   */
  compare(predictedInput: unknown, actualInput: unknown): CompareResult {
    const predicted = z.string().min(1).max(128).parse(predictedInput);
    const actual = z.string().min(1).max(128).parse(actualInput);
    if (predicted === actual) {
      return { divergence: 0, match: true, explanation: "actual state matches prediction exactly" };
    }
    if (predicted === "unknown") {
      return { divergence: 1, match: false, explanation: "no learned transition; prediction was unknown" };
    }
    const len = Math.max(predicted.length, actual.length);
    let diff = 0;
    for (let i = 0; i < len; i++) {
      if ((predicted[i] ?? "") !== (actual[i] ?? "")) diff++;
    }
    const divergence = Math.round((diff / len) * 1000) / 1000;
    return {
      divergence,
      match: false,
      explanation: `state mismatch: ${diff}/${len} hash chars differ (divergence ${divergence})`,
    };
  }

  transitionCount(): number {
    let n = 0;
    for (const row of Object.values(this.table)) n += Object.keys(row).length;
    return n;
  }

  observationCount(): number {
    return this.observations;
  }
}
