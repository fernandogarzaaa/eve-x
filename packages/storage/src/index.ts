import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, basename } from "node:path";

// NOTE: optional `pg`/`redis` driver types live in ./opt-deps.d.ts (ambient,
// global script). Runtime always resolves lazily with file fallback.

// ── EVE-X storage: DataDir JSON collections + object blobs, optional pg/redis ──
// Large binaries are NEVER stored inside JSON: use putBlob() and keep {blobId,kind,bytes}
// pointer records in collection documents.

export type CollectionName =
  | "sessions" | "tasks" | "vms" | "users" | "models"
  | "experiments" | "judgments" | "trace-meta" | "benchmarks" | "leases";

export type BlobKind = "screenshot" | "recording" | "snapshot" | "report" | "dataset" | "trace" | "misc";

export interface BlobPointer {
  blobId: string;
  kind: BlobKind;
  bytes: number;
  path: string;
}

const COLLECTIONS: CollectionName[] = [
  "sessions", "tasks", "vms", "users", "models",
  "experiments", "judgments", "trace-meta", "benchmarks", "leases",
];

function dataDir(): string {
  return process.env["DATA_DIR"] ?? "./data";
}

function objectDir(): string {
  return process.env["OBJECT_DIR"] ?? join(dataDir(), "objects");
}

function collDir(coll: CollectionName): string {
  return join(dataDir(), coll);
}

function docPath(coll: CollectionName, id: string): string {
  const safe = basename(id).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128) || "doc";
  return join(collDir(coll), `${safe}.json`);
}

function ensureDirs(): void {
  mkdirSync(dataDir(), { recursive: true });
  mkdirSync(objectDir(), { recursive: true });
  for (const c of COLLECTIONS) mkdirSync(collDir(c), { recursive: true });
  for (const k of ["screenshots", "recordings", "snapshots", "reports", "datasets", "traces", "misc"]) {
    mkdirSync(join(objectDir(), k), { recursive: true });
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export interface StoreDoc {
  id: string;
  [key: string]: unknown;
}

export class DataStore {
  readonly root: string;
  constructor(root?: string) {
    this.root = root ?? dataDir();
    ensureDirs();
  }

  list(coll: CollectionName, limit = 200): StoreDoc[] {
    ensureDirs();
    let files: string[] = [];
    try {
      files = readdirSync(collDir(coll)).filter((f) => f.endsWith(".json")).slice(0, limit);
    } catch {
      return [];
    }
    const out: StoreDoc[] = [];
    for (const f of files) {
      const doc = readJson<StoreDoc>(join(collDir(coll), f));
      if (doc) out.push(doc);
    }
    return out;
  }

  get(coll: CollectionName, id: string): StoreDoc | null {
    return readJson<StoreDoc>(docPath(coll, id));
  }

  put(coll: CollectionName, doc: StoreDoc): StoreDoc {
    ensureDirs();
    if (!doc.id) throw new Error("doc.id required");
    const stamped = { ...doc, updatedAt: new Date().toISOString() };
    atomicWriteJson(docPath(coll, doc.id), stamped);
    return stamped;
  }

  insert(coll: CollectionName, doc: Omit<StoreDoc, "id"> & { id?: string }): StoreDoc {
    const full: StoreDoc = { ...doc, id: doc.id ?? `${coll.slice(0, 4)}-${randomUUID().slice(0, 8)}` };
    return this.put(coll, full);
  }

  update(coll: CollectionName, id: string, patch: Record<string, unknown>): StoreDoc | null {
    const cur = this.get(coll, id);
    if (!cur) return null;
    return this.put(coll, { ...cur, ...patch, id });
  }

  remove(coll: CollectionName, id: string): boolean {
    try {
      const p = docPath(coll, id);
      if (!existsSync(p)) return false;
      rmSync(p);
      return true;
    } catch {
      return false;
    }
  }

  // ── trace JSONL (one file per session under objects/traces) ──
  tracePath(sessionId: string): string {
    ensureDirs();
    const safe = basename(sessionId).replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(objectDir(), "traces", `${safe}.jsonl`);
  }

  appendTrace(sessionId: string, step: Record<string, unknown>): void {
    ensureDirs();
    appendFileSync(this.tracePath(sessionId), JSON.stringify(step) + "\n", "utf8");
  }

  readTrace(sessionId: string, limit = 1000): Array<Record<string, unknown>> {
    const p = this.tracePath(sessionId);
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    const tail = lines.slice(Math.max(0, lines.length - limit));
    const out: Array<Record<string, unknown>> = [];
    for (const l of tail) {
      try {
        out.push(JSON.parse(l) as Record<string, unknown>);
      } catch {
        continue;
      }
    }
    return out;
  }

  // ── object blobs ──
  putBlob(kind: BlobKind, bytes: Uint8Array | Buffer, ext = "bin"): BlobPointer {
    ensureDirs();
    const blobId = `${kind.slice(0, 4)}-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const sub = kind === "screenshot" ? "screenshots"
      : kind === "recording" ? "recordings"
      : kind === "snapshot" ? "snapshots"
      : kind === "report" ? "reports"
      : kind === "dataset" ? "datasets"
      : kind === "trace" ? "traces" : "misc";
    const rel = join(sub, `${blobId}.${ext}`);
    const full = join(objectDir(), rel);
    writeFileSync(full, bytes);
    const st = statSync(full);
    return { blobId, kind, bytes: st.size, path: rel };
  }

  blobFullPath(pointerOrRel: BlobPointer | string): string {
    const rel = typeof pointerOrRel === "string" ? pointerOrRel : pointerOrRel.path;
    return join(objectDir(), rel);
  }

  blobExists(pointerOrRel: BlobPointer | string): boolean {
    return existsSync(this.blobFullPath(pointerOrRel));
  }
}

export const store = new DataStore();

// ── Optional Postgres / Redis with graceful file fallback ──
// No static driver imports: drivers resolve lazily via dynamic import so the
// package works with zero optional deps installed.

export interface PgStatus {
  configured: boolean;
  connected: boolean;
  mode: "postgres" | "file";
  detail: string;
}

let pgLogged = false;

export async function pgStatus(): Promise<PgStatus> {
  const url = process.env["DATABASE_URL"] ?? "";
  if (!url) return { configured: false, connected: false, mode: "file", detail: "DATABASE_URL unset; using file store" };
  try {
    // Optional peer dep: typed as unknown at runtime; ts-ignore keeps typecheck green when it is absent.
    // @ts-ignore: 'pg' is an optional peer dependency and may not be installed.
    const mod = await import("pg").catch(() => null) as unknown as {
      Client?: new (opts: { connectionString: string; connectionTimeoutMillis: number }) => {
        connect: () => Promise<void>; query: (q: string) => Promise<unknown>; end: () => Promise<void>;
      };
    } | null;
    if (!mod || !mod.Client) {
      return { configured: true, connected: false, mode: "file", detail: "pg driver not installed; using file store" };
    }
    const client = new mod.Client({ connectionString: url, connectionTimeoutMillis: 1500 });
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    return { configured: true, connected: true, mode: "postgres", detail: "postgres reachable" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!pgLogged) {
      pgLogged = true;
      process.stderr.write(`[storage] postgres unavailable, file fallback: ${msg}\n`);
    }
    return { configured: true, connected: false, mode: "file", detail: `postgres unreachable (${msg}); using file store` };
  }
}

export interface RedisStatus {
  configured: boolean;
  connected: boolean;
  mode: "redis" | "memory";
  detail: string;
}

export async function redisStatus(): Promise<RedisStatus> {
  const url = process.env["REDIS_URL"] ?? "";
  if (!url) return { configured: false, connected: false, mode: "memory", detail: "REDIS_URL unset; using in-memory pub/sub" };
  try {
    // Optional peer dep: typed as unknown at runtime; ts-ignore keeps typecheck green when it is absent.
    // @ts-ignore: 'redis' is an optional peer dependency and may not be installed.
    const mod = await import("redis").catch(() => null) as unknown as {
      createClient?: (opts: { url: string; socket?: { connectTimeout: number } }) => {
        connect: () => Promise<void>; ping: () => Promise<string>; quit: () => Promise<void>;
      };
    } | null;
    if (!mod || !mod.createClient) {
      return { configured: true, connected: false, mode: "memory", detail: "redis driver not installed; using in-memory" };
    }
    const client = mod.createClient({ url, socket: { connectTimeout: 1200 } });
    await client.connect();
    await client.ping();
    await client.quit();
    return { configured: true, connected: true, mode: "redis", detail: "redis reachable" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[storage] redis unavailable, memory fallback: ${msg}\n`);
    return { configured: true, connected: false, mode: "memory", detail: `redis unreachable (${msg}); using in-memory` };
  }
}

export async function backendSummary(): Promise<{ pg: PgStatus; redis: RedisStatus; dataDir: string; objectDir: string }> {
  const [pg, redis] = await Promise.all([pgStatus(), redisStatus()]);
  return { pg, redis, dataDir: dataDir(), objectDir: objectDir() };
}
