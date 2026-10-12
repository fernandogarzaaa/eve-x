import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { buildApp, ensureOptionals, hydrateFromDisk, __clearMemory, verifyReplay } from "../apps/api/src/index.js";

// Adversarial evidence suite: every forgery class must either be blocked
// or surface as an explicit failure/inconclusive condition — never success.
// Covers: trace mutation/reorder/deletion/duplication, stale replay,
// idempotency abuse, unauthorized access, dev-backend transparency, and the
// release fail-closed mechanisms (hermetic temp-repo/git tests).

const MASTER = "test-master-token-adversarial";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
let DATA = "";

describe("trace forgery classes (integration)", () => {
  let base = "";
  let srv: Server | null = null;

  async function api(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: unknown = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json: json as Record<string, unknown> };
  }

  function traceFile(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const objDir = process.env["OBJECT_DIR"] ?? join(DATA, "objects");
    return join(objDir, "traces", `${safe}.jsonl`);
  }

  function rewrite(sessionId: string, fn: (lines: string[]) => string[]): void {
    const p = traceFile(sessionId);
    assert.ok(existsSync(p), "trace file must exist");
    const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim().length > 0);
    writeFileSync(p, fn(lines).join("\n") + "\n", "utf8");
    __clearMemory();
    hydrateFromDisk();
  }

  before(async () => {
    DATA = mkdtempSync(join(tmpdir(), "evex-advers-"));
    process.env["DATA_DIR"] = DATA;
    process.env["EVEX_AUTH_TOKEN"] = MASTER;
    process.env["VM_BACKEND"] = "dev-framebuffer";
    process.env["EVEX_MAX_VMS_PER_TENANT"] = "64";
    process.env["EVEX_MAX_TOTAL_VMS"] = "512";
    process.env["EVEX_MAX_CPU_PER_TENANT"] = "256";
    process.env["EVEX_MAX_MEM_MB_PER_TENANT"] = "524288";
    delete process.env["EVEX_TENANT"];
    await ensureOptionals();
    __clearMemory();
    const app = buildApp();
    hydrateFromDisk();
    const s = createServer(app);
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
    srv = s;
    base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => srv?.close(() => resolve()));
  });

  async function seedActs(n = 3): Promise<{ sessionId: string; stepIds: string[] }> {
    const s = await api("POST", "/v1/sessions", MASTER, { goal: "adversarial case" });
    assert.equal(s.status, 201);
    const sessionId = String(s.json["id"]);
    for (let i = 0; i < n; i += 1) {
      const a = await api("POST", `/v1/computer/${sessionId}/act`, MASTER, { type: "wait", ms: 10, confidence: 0.9 });
      assert.equal(a.status, 200);
    }
    const tr = await api("GET", `/v1/trace/${sessionId}`, MASTER);
    const steps = (tr.json["steps"] as Array<Record<string, unknown>>).map((st) => String(st["step_id"]));
    return { sessionId, stepIds: steps };
  }

  it("mutated step breaks the chain (replay divergent)", async () => {
    const { sessionId } = await seedActs();
    rewrite(sessionId, (lines) => {
      const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
      first["outcome"] = "goal-achieved";
      const out = [...lines];
      out[0] = JSON.stringify(first);
      return out;
    });
    const r = await api("POST", `/v1/replay/${sessionId}`, MASTER);
    assert.equal((r.json as { verdict: string }).verdict, "replay-divergent");
    assert.ok((r.json as { issues: string[] }).issues.some((i) => i.includes("digest mismatch")));
  });

  it("reordered log is divergent (set continuity is not enough)", async () => {
    const { sessionId } = await seedActs();
    rewrite(sessionId, (lines) => [lines[1] as string, lines[0] as string, ...lines.slice(2)]);
    const r = await api("POST", `/v1/replay/${sessionId}`, MASTER);
    assert.equal((r.json as { verdict: string }).verdict, "replay-divergent");
  });

  it("deleted step is a gap (divergent, never silently closed)", async () => {
    const { sessionId } = await seedActs();
    rewrite(sessionId, (lines) => [lines[0] as string, ...lines.slice(2)]);
    const r = await api("POST", `/v1/replay/${sessionId}`, MASTER);
    assert.equal((r.json as { verdict: string }).verdict, "replay-divergent");
    assert.ok((r.json as { issues: string[] }).issues.some((i) => i.includes("gap")));
  });

  it("duplicated seq is divergent", async () => {
    const { sessionId } = await seedActs();
    rewrite(sessionId, (lines) => [...lines, lines[1] as string]);
    const r = await api("POST", `/v1/replay/${sessionId}`, MASTER);
    assert.equal((r.json as { verdict: string }).verdict, "replay-divergent");
    assert.ok((r.json as { issues: string[] }).issues.some((i) => i.includes("duplicate")));
  });

  it("stale perception replay is refused, fresh act succeeds", async () => {
    const s = await api("POST", "/v1/sessions", MASTER, { goal: "stale case" });
    const sid = String(s.json["id"]);
    const stale = await api("POST", `/v1/computer/${sid}/act`, MASTER, { type: "wait", confidence: 0.5, frameId: "f-0-ancient" });
    assert.equal(stale.status, 409);
    assert.equal((stale.json as { error: string }).error, "stale_perception");
    const tr = await api("GET", `/v1/trace/${sid}`, MASTER);
    const steps = tr.json["steps"] as unknown[];
    assert.equal(steps.length, 1, "refused act must not append");
    const fresh = await api("POST", `/v1/computer/${sid}/act`, MASTER, { type: "wait", ms: 5, confidence: 0.5 });
    assert.equal(fresh.status, 200);
  });

  it("idempotency keys cannot multiply steps (abuse returns the original)", async () => {
    const s = await api("POST", "/v1/sessions", MASTER, { goal: "idempotency case" });
    const sid = String(s.json["id"]);
    const b1 = await api("POST", `/v1/computer/${sid}/act`, MASTER, { type: "wait", ms: 5, confidence: 0.5, idempotencyKey: "k-9" });
    assert.equal(b1.status, 200);
    const b2 = await api("POST", `/v1/computer/${sid}/act`, MASTER, { type: "wait", ms: 5, confidence: 0.5, idempotencyKey: "k-9" });
    assert.equal(b2.status, 200);
    assert.deepEqual(b2.json, b1.json);
    const tr = await api("GET", `/v1/trace/${sid}`, MASTER);
    assert.equal((tr.json["steps"] as unknown[]).length, 2, "session-create step + exactly one act step");
  });

  it("dev-backend acts are labeled synthetic:true (backend transparency)", async () => {
    const s = await api("POST", "/v1/sessions", MASTER, { goal: "transparency case" });
    const sid = String(s.json["id"]);
    const a = await api("POST", `/v1/computer/${sid}/act`, MASTER, { type: "wait", ms: 5, confidence: 0.5 });
    assert.equal((a.json as { synthetic: boolean }).synthetic, true);
    const o = await api("GET", `/v1/computer/${sid}/observe`, MASTER);
    assert.equal((o.json as { synthetic: boolean }).synthetic, true);
  });

  it("unauthorized benchmark and validate calls are refused", async () => {
    const prevMode = process.env["EVEX_MODE"];
    const prevToken = process.env["EVEX_AUTH_TOKEN"];
    try {
      process.env["EVEX_MODE"] = "test";
      delete process.env["EVEX_AUTH_TOKEN"];
      const b = await api("POST", "/v1/benchmarks", "", { name: "x", size: 1 });
      assert.equal(b.status, 401);
      const t = await api("POST", "/v1/tasks/start", "", { goal: "x" });
      assert.equal(t.status, 401);
    } finally {
      if (prevMode === undefined) delete process.env["EVEX_MODE"];
      else process.env["EVEX_MODE"] = prevMode;
      if (prevToken === undefined) delete process.env["EVEX_AUTH_TOKEN"];
      else process.env["EVEX_AUTH_TOKEN"] = prevToken;
    }
  });

  it("verifyReplay flags weak legacy digests instead of trusting them", () => {
    const steps = [0, 1].map((seq) => ({
      session_id: "s", task_id: "t", step_id: `step-${seq}`, seq,
      timestamp: new Date().toISOString(), actor: "eve-agent",
      vm_state_before: "RUNNING", screen_before: `f-${seq}`,
      goal: "g", candidate_actions: [],
      provenance: { source: "system", channel: "t", at: new Date().toISOString() },
      model_version: "evex-1", environment_version: "ubuntu-desktop-v1",
      prevDigest: "0".repeat(40), digest: "a".repeat(40),
    }));
    const r = verifyReplay(steps as Array<Record<string, unknown>>);
    assert.equal(r.verdict, "replay-divergent");
    assert.ok(r.issues.some((i) => i.includes("legacy digest")));
  });
});

describe("release fail-closed mechanisms (hermetic)", () => {
  it("gen-release-identity refuses a dirty tree without the dev escape hatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "evex-relmech-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "packages", "core", "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.0.0-test" }));
    copyFileSync(join(ROOT, "scripts", "gen-release-identity.mjs"), join(dir, "scripts", "gen-release-identity.mjs"));
    copyFileSync(join(ROOT, "scripts", "git-safe.mjs"), join(dir, "scripts", "git-safe.mjs"));
    copyFileSync(join(ROOT, "scripts", "release-paths.mjs"), join(dir, "scripts", "release-paths.mjs"));
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
    writeFileSync(join(dir, "dirty.txt"), "uncommitted");
    // Hermetic env: scrub any ambient escape hatches so the mechanism —
    // not the operator's shell — is under test.
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== "EVEX_ALLOW_DIRTY_BUILD") cleanEnv[k] = v;
    }
    let refused = false;
    try {
      execFileSync(process.execPath, ["scripts/gen-release-identity.mjs"], { cwd: dir, stdio: "pipe", env: cleanEnv });
    } catch {
      refused = true;
    }
    assert.equal(refused, true, "dirty tree without EVEX_ALLOW_DIRTY_BUILD=1 must refuse");
    execFileSync(process.execPath, ["scripts/gen-release-identity.mjs"], {
      cwd: dir, stdio: "pipe", env: { ...process.env, EVEX_ALLOW_DIRTY_BUILD: "1" },
    });
    const gen = readFileSync(join(dir, "packages", "core", "src", "release.gen.ts"), "utf8");
    assert.ok(gen.includes("dirty: true"), "dev escape hatch must stamp dirty:true");
  });

  it("verify-release refuses an inconsistent tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "evex-verifymech-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9-drift" }));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    copyFileSync(join(ROOT, "scripts", "verify-release.mjs"), join(dir, "scripts", "verify-release.mjs"));
    copyFileSync(join(ROOT, "scripts", "git-safe.mjs"), join(dir, "scripts", "git-safe.mjs"));
    copyFileSync(join(ROOT, "scripts", "release-paths.mjs"), join(dir, "scripts", "release-paths.mjs"));
    let refused = false;
    let out = "";
    try {
      execFileSync(process.execPath, ["scripts/verify-release.mjs"], { cwd: dir, stdio: "pipe" });
    } catch (err) {
      refused = true;
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      out = String(e.stdout ?? "") + String(e.stderr ?? "");
    }
    assert.equal(refused, true, "inconsistent tree must be refused");
    assert.match(out, /drift\(s\) REFUSED/);
  });
});
