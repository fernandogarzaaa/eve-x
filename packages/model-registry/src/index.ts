import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

// ── Model registry: versioned records over filesystem + optional object storage ──
// Records capture {architecture, weights, quantization, lineage, benchmarks,
// config, compat, runtime reqs}. Promotion to production is gated and NEVER
// automatic: promote() requires an explicit human approval token plus passing
// benchmark gates. See MODEL.md.

export const Architecture = z.enum(["vit-ground", "cua-small", "cua-base", "cua-large", "world-lstm", "verifier-xgb"]);
export type Architecture = z.infer<typeof Architecture>;

export const Quantization = z.enum(["none", "fp16", "int8", "int4"]);
export type Quantization = z.infer<typeof Quantization>;

export const LifecycleStage = z.enum(["experimental", "staging", "production", "retired"]);
export type LifecycleStage = z.infer<typeof LifecycleStage>;

export const BenchmarkScore = z.object({
  benchmark: z.string().min(1),
  split: z.enum(["train", "val", "test", "held-out"]),
  successRate: z.number().min(0).max(1),
  groundingAccuracy: z.number().min(0).max(1),
  recoveryRate: z.number().min(0).max(1),
  samples: z.number().int().min(1),
  digest: z.string().min(1),
  at: z.string().min(1),
});
export type BenchmarkScore = z.infer<typeof BenchmarkScore>;

export const RuntimeReqs = z.object({
  accelerator: z.enum(["cpu", "cuda", "rocm"]).default("cpu"),
  minVramMb: z.number().int().min(0).default(0),
  minRamMb: z.number().int().min(0).default(2048),
  maxLatencyMs: z.number().int().min(1).default(15000),
  maxQueueDepth: z.number().int().min(1).default(32),
});
export type RuntimeReqs = z.infer<typeof RuntimeReqs>;

export const ModelRecord = z.object({
  modelId: z.string().min(1),
  version: z.string().min(1),
  architecture: Architecture,
  weights: z.object({
    uri: z.string().min(1),
    sha256: z.string().min(1),
    bytes: z.number().int().min(0),
    quantization: Quantization,
  }),
  lineage: z.object({
    configHash: z.string().min(1),
    datasetDigest: z.string().min(1),
    codeDigest: z.string().min(1),
    parentModelId: z.string().nullable().default(null),
    trainedAt: z.string().min(1),
    trainedBy: z.string().min(1),
  }),
  benchmarks: z.array(BenchmarkScore).default([]),
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  compat: z.object({
    protocolVersion: z.string().min(1),
    mcpVersion: z.string().min(1),
    minApiVersion: z.string().min(1),
  }),
  runtime: RuntimeReqs,
  stage: LifecycleStage.default("experimental"),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type ModelRecord = z.infer<typeof ModelRecord>;

export const PromoteGate = z.object({
  minSuccessRate: z.number().min(0).max(1).default(0.8),
  minGroundingAccuracy: z.number().min(0).max(1).default(0.85),
  minRecoveryRate: z.number().min(0).max(1).default(0.6),
  requireHeldOut: z.boolean().default(true),
  approvalToken: z.string().min(8),
});
export type PromoteGate = z.infer<typeof PromoteGate>;

export interface RegistryOptions {
  dir: string;
  objectStorage?: ObjectStorageConfig | null;
}

export interface ObjectStorageConfig {
  endpoint: string;
  bucket: string;
  token: string;
  prefix?: string;
}

export interface CreateRecordInput {
  version: string;
  architecture: Architecture;
  weightsUri: string;
  weightsSha256: string;
  weightsBytes: number;
  quantization: Quantization;
  configHash: string;
  datasetDigest: string;
  codeDigest: string;
  parentModelId?: string | null;
  trainedBy: string;
  config: Record<string, string | number | boolean>;
  protocolVersion?: string;
  mcpVersion?: string;
  minApiVersion?: string;
  runtime?: Partial<RuntimeReqs>;
}

function utcNow(): string {
  return new Date().toISOString();
}

function modelFileName(modelId: string): string {
  return `${modelId.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`;
}

export class ModelRegistry {
  readonly dir: string;
  private readonly objects: ObjectStorageConfig | null;

  constructor(opts: RegistryOptions) {
    this.dir = resolve(opts.dir);
    this.objects = opts.objectStorage ?? null;
    mkdirSync(join(this.dir, "records"), { recursive: true });
    mkdirSync(join(this.dir, "weights"), { recursive: true });
  }

  private recordPath(modelId: string): string {
    return join(this.dir, "records", modelFileName(modelId));
  }

  createRecord(input: CreateRecordInput): ModelRecord {
    const modelId = `model-${randomUUID().slice(0, 8)}`;
    const at = utcNow();
    const record = ModelRecord.parse({
      modelId,
      version: input.version,
      architecture: input.architecture,
      weights: {
        uri: input.weightsUri,
        sha256: input.weightsSha256,
        bytes: input.weightsBytes,
        quantization: input.quantization,
      },
      lineage: {
        configHash: input.configHash,
        datasetDigest: input.datasetDigest,
        codeDigest: input.codeDigest,
        parentModelId: input.parentModelId ?? null,
        trainedAt: at,
        trainedBy: input.trainedBy,
      },
      benchmarks: [],
      config: input.config,
      compat: {
        protocolVersion: "1",
        mcpVersion: "mcp/1",
        minApiVersion: "v1",
      },
      runtime: RuntimeReqs.parse(input.runtime ?? {}),
      stage: "experimental",
      createdAt: at,
      updatedAt: at,
    });
    // Merge caller compat overrides when provided.
    if (input.protocolVersion) record.compat.protocolVersion = input.protocolVersion;
    if (input.mcpVersion) record.compat.mcpVersion = input.mcpVersion;
    if (input.minApiVersion) record.compat.minApiVersion = input.minApiVersion;
    writeFileSync(this.recordPath(modelId), JSON.stringify(record, null, 2), "utf8");
    return record;
  }

  getRecord(modelId: string): ModelRecord {
    const p = this.recordPath(modelId);
    if (!existsSync(p)) throw new Error(`Model not found: ${modelId}`);
    const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
    return ModelRecord.parse(raw);
  }

  listRecords(stage?: LifecycleStage): ModelRecord[] {
    const dir = join(this.dir, "records");
    const out: ModelRecord[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const raw: unknown = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const rec = ModelRecord.parse(raw);
      if (stage && rec.stage !== stage) continue;
      out.push(rec);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Attach a benchmark result measured by ml/evaluation/eval.py. Never invents numbers. */
  recordBenchmark(modelId: string, score: BenchmarkScore): ModelRecord {
    const parsed = BenchmarkScore.parse(score);
    const rec = this.getRecord(modelId);
    rec.benchmarks.push(parsed);
    rec.updatedAt = utcNow();
    writeFileSync(this.recordPath(modelId), JSON.stringify(ModelRecord.parse(rec), null, 2), "utf8");
    return rec;
  }

  latestBenchmark(rec: ModelRecord, benchmark: string, split: BenchmarkScore["split"]): BenchmarkScore | null {
    const matches = rec.benchmarks.filter((b) => b.benchmark === benchmark && b.split === split);
    if (matches.length === 0) return null;
    return matches[matches.length - 1] as BenchmarkScore;
  }

  /**
   * Promote a model toward production. Gating rules:
   *  - target must be staging or production explicitly requested by a human;
   *  - an approval token (min 8 chars, human-issued) is mandatory — the
   *    registry never promotes on its own, there is no auto path;
   *  - the named benchmark must have passing test-split scores, and when
   *    requireHeldOut is set, a held-out score above the same bar.
   * Returns the updated record. Throws on every gate failure with the reason.
   */
  promote(modelId: string, target: "staging" | "production", gate: PromoteGate, benchmark: string): ModelRecord {
    const parsedGate = PromoteGate.parse(gate);
    const rec = this.getRecord(modelId);
    if (target === "production" && rec.stage !== "staging") {
      throw new Error(`Refusing production promotion: model ${modelId} is at stage ${rec.stage}, must be staging first`);
    }
    if (target === "staging" && rec.stage !== "experimental") {
      throw new Error(`Refusing staging promotion: model ${modelId} is at stage ${rec.stage}, must be experimental`);
    }
    if (!parsedGate.approvalToken || parsedGate.approvalToken.trim().length < 8) {
      throw new Error("Refusing promotion: human approval token required");
    }
    // Weights integrity: a corrupt or missing local checkpoint must never
    // promote. file:// URIs and plain paths are verified (existence, size,
    // sha256); remote URIs are out of scope for local verification and are
    // recorded as unverified (a separate supply-chain check owns them).
    const wuri = rec.weights.uri;
    const localPath = wuri.startsWith("file://") ? wuri.slice("file://".length) : (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(wuri) ? null : wuri);
    if (localPath !== null) {
      const st = weightsStat(localPath);
      if (!st.exists || st.bytes === 0) {
        throw new Error(`Refusing promotion: weights missing or empty at ${localPath}`);
      }
      if (st.bytes !== rec.weights.bytes) {
        throw new Error(`Refusing promotion: weights size ${st.bytes} != recorded ${rec.weights.bytes} (corrupt or replaced)`);
      }
      const actual = sha256File(localPath);
      if (actual !== rec.weights.sha256) {
        throw new Error("Refusing promotion: weights sha256 mismatch (corrupt or replaced)");
      }
    }
    const test = this.latestBenchmark(rec, benchmark, "test");
    if (!test) throw new Error(`Refusing promotion: no test-split score for benchmark ${benchmark}`);
    const failures: string[] = [];
    if (test.successRate < parsedGate.minSuccessRate) failures.push(`successRate ${test.successRate} < ${parsedGate.minSuccessRate}`);
    if (test.groundingAccuracy < parsedGate.minGroundingAccuracy) {
      failures.push(`groundingAccuracy ${test.groundingAccuracy} < ${parsedGate.minGroundingAccuracy}`);
    }
    if (test.recoveryRate < parsedGate.minRecoveryRate) failures.push(`recoveryRate ${test.recoveryRate} < ${parsedGate.minRecoveryRate}`);
    if (parsedGate.requireHeldOut) {
      const held = this.latestBenchmark(rec, benchmark, "held-out");
      if (!held) failures.push("held-out score required but missing");
      else {
        if (held.successRate < parsedGate.minSuccessRate) failures.push(`held-out successRate ${held.successRate} < ${parsedGate.minSuccessRate}`);
        if (held.groundingAccuracy < parsedGate.minGroundingAccuracy) {
          failures.push(`held-out groundingAccuracy ${held.groundingAccuracy} < ${parsedGate.minGroundingAccuracy}`);
        }
      }
    }
    if (failures.length > 0) {
      throw new Error(`Refusing promotion of ${modelId}: ${failures.join("; ")}`);
    }
    rec.stage = target;
    rec.updatedAt = utcNow();
    writeFileSync(this.recordPath(modelId), JSON.stringify(ModelRecord.parse(rec), null, 2), "utf8");
    return rec;
  }

  retire(modelId: string): ModelRecord {
    const rec = this.getRecord(modelId);
    rec.stage = "retired";
    rec.updatedAt = utcNow();
    writeFileSync(this.recordPath(modelId), JSON.stringify(ModelRecord.parse(rec), null, 2), "utf8");
    return rec;
  }

  /** Compatibility check for a client speaking a given protocol/mcp/api triple. */
  checkCompat(modelId: string, client: { protocolVersion: string; mcpVersion: string; apiVersion: string }): { ok: boolean; reasons: string[] } {
    const rec = this.getRecord(modelId);
    const reasons: string[] = [];
    if (client.protocolVersion !== rec.compat.protocolVersion) {
      reasons.push(`protocol ${client.protocolVersion} != ${rec.compat.protocolVersion}`);
    }
    if (client.mcpVersion !== rec.compat.mcpVersion) reasons.push(`mcp ${client.mcpVersion} != ${rec.compat.mcpVersion}`);
    if (client.apiVersion < rec.compat.minApiVersion) {
      reasons.push(`api ${client.apiVersion} < minimum ${rec.compat.minApiVersion}`);
    }
    return { ok: reasons.length === 0, reasons };
  }

  /** Store a weights blob locally and return its sha256 + byte length. */
  storeWeightsLocal(modelId: string, bytes: Buffer, quantization: Quantization): { uri: string; sha256: string; bytes: number } {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const uri = `file:weights/${modelId}.${quantization}.bin`;
    writeFileSync(join(this.dir, "weights", `${modelId}.${quantization}.bin`), bytes);
    return { uri, sha256: digest, bytes: bytes.length };
  }

  hasWeightsLocal(modelId: string, quantization: Quantization): boolean {
    return existsSync(join(this.dir, "weights", `${modelId}.${quantization}.bin`));
  }

  // ── Optional object storage (S3-compatible, plain fetch, no SDK) ──

  async pushRecordToObjects(modelId: string): Promise<string> {
    if (!this.objects) throw new Error("Object storage not configured for this registry");
    const rec = this.getRecord(modelId);
    const key = `${this.objects.prefix ?? "models"}/${modelFileName(modelId)}`;
    await this.objectPut(key, Buffer.from(JSON.stringify(rec, null, 2), "utf8"), "application/json");
    return this.objectUrl(key);
  }

  async pullRecordFromObjects(modelId: string): Promise<ModelRecord> {
    if (!this.objects) throw new Error("Object storage not configured for this registry");
    const key = `${this.objects.prefix ?? "models"}/${modelFileName(modelId)}`;
    const bytes = await this.objectGet(key);
    const raw: unknown = JSON.parse(bytes.toString("utf8"));
    const rec = ModelRecord.parse(raw);
    writeFileSync(this.recordPath(modelId), JSON.stringify(rec, null, 2), "utf8");
    return rec;
  }

  private objectUrl(key: string): string {
    const cfg = this.objects as ObjectStorageConfig;
    return `${cfg.endpoint.replace(/\/+$/, "")}/${cfg.bucket}/${key}`;
  }

  private async objectPut(key: string, body: Buffer, contentType: string): Promise<void> {
    const cfg = this.objects as ObjectStorageConfig;
    const res = await fetch(this.objectUrl(key), {
      method: "PUT",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": contentType },
      body: new Uint8Array(body),
    });
    if (!res.ok) throwError(await res.text(), res.status);
  }

  private async objectGet(key: string): Promise<Buffer> {
    const cfg = this.objects as ObjectStorageConfig;
    const res = await fetch(this.objectUrl(key), {
      headers: { authorization: `Bearer ${cfg.token}` },
    });
    if (!res.ok) throwError(await res.text(), res.status);
    return Buffer.from(await res.arrayBuffer());
  }
}

function throwError(body: string, status: number): never {
  throw new Error(`Object storage request failed with ${status}: ${body.slice(0, 512)}`);
}

export function registryDigest(rec: ModelRecord): string {
  return createHash("sha256").update(JSON.stringify(rec)).digest("hex");
}

export function isProduction(rec: ModelRecord): boolean {
  return rec.stage === "production";
}

/** Helper for tests: does a weights file exist and is it non-empty? */
export function weightsStat(weightsPath: string): { exists: boolean; bytes: number } {
  if (!existsSync(weightsPath)) return { exists: false, bytes: 0 };
  const st = statSync(weightsPath);
  return { exists: st.isFile(), bytes: st.size };
}

/** sha256 of a local file (promotion gate integrity check). */
export function sha256File(weightsPath: string): string {
  return createHash("sha256").update(readFileSync(weightsPath)).digest("hex");
}
