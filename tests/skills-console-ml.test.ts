import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp, ensureOptionals, __clearMemory } from "../apps/api/src/index.js";

// skills-console-ml: skill script surfaces, integration configs, server-side
// blind review flow, ML smoke + requirements, Dockerfiles, bootstrap syntax.

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");

function pyCandidates(): string[] {
  return process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
}

function findPython(): string | null {
  for (const bin of pyCandidates()) {
    try {
      const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15000 });
      if (r.status === 0) return bin;
    } catch {
      // try next
    }
  }
  return null;
}

function findBash(): string | null {
  const cands = process.platform === "win32"
    ? ["bash", "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"]
    : ["bash", "/bin/bash", "/usr/bin/bash"];
  for (const bin of cands) {
    try {
      const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15000 });
      if (r.status === 0) return bin;
    } catch {
      // try next
    }
  }
  return null;
}

describe("skill scripts: usage surface without network", () => {
  for (const name of ["observe.mjs", "act.mjs", "replay.mjs"]) {
    it(`${name} --help exits 2 with usage, no crash`, () => {
      const r = spawnSync("node", [join(ROOT, "skills", "eve-computer", "scripts", name), "--help"], {
        encoding: "utf8", timeout: 15000,
        env: { ...process.env, EVEX_API_URL: "http://127.0.0.1:9" },
      });
      assert.equal(r.status, 2, `${name} --help should exit 2, got ${r.status}: ${r.stderr}`);
      assert.match(String(r.stderr), /usage:/i);
    });
    it(`${name} with no args exits 2 with usage, no crash`, () => {
      const r = spawnSync("node", [join(ROOT, "skills", "eve-computer", "scripts", name)], {
        encoding: "utf8", timeout: 15000,
        env: { ...process.env, EVEX_API_URL: "http://127.0.0.1:9" },
      });
      assert.equal(r.status, 2, `${name} (no args) should exit 2, got ${r.status}`);
      assert.match(String(r.stderr), /usage:/i);
    });
  }
});

describe("integrations: mcp.json parses with real entry points", () => {
  const dirs = readdirSync(join(ROOT, "integrations"), { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort();
  assert.ok(dirs.length >= 7, `expected >=7 integration dirs, got ${dirs.join(",")}`);
  for (const dir of dirs) {
    it(`${dir}/mcp.json parses with required fields`, () => {
      const p = join(ROOT, "integrations", dir, "mcp.json");
      assert.ok(existsSync(p), `${p} missing`);
      const doc = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      const servers = (doc["mcpServers"] ?? doc["mcp"]) as Record<string, unknown> | undefined;
      assert.ok(servers && typeof servers === "object", `${dir}: needs mcpServers or mcp`);
      for (const [name, entry] of Object.entries(servers)) {
        const e = entry as Record<string, unknown>;
        if (typeof e["url"] === "string") {
          assert.match(String(e["url"]), /:8091\/mcp$/, `${dir}/${name}: http url must be :8091/mcp`);
        } else {
          const cmd = e["command"];
          const cmdArr = Array.isArray(cmd) ? cmd.join(" ") : String(cmd ?? "");
          assert.match(cmdArr, /(^|\s)node(\s|$)/, `${dir}/${name}: stdio command must run node`);
          const args = Array.isArray(e["args"]) ? (e["args"] as unknown[]).join(" ")
            : Array.isArray(cmd) ? (cmd as unknown[]).join(" ") : "";
          assert.ok(args.includes("dist/apps/mcp/src/index.js"),
            `${dir}/${name}: entry must be dist/apps/mcp/src/index.js, got ${args}`);
        }
      }
    });
  }
});

describe("blind review flow (server-side)", () => {
  const MASTER = "test-blind-master-token";
  let base = "";
  let srv: Server | null = null;
  let prevBackend: string | undefined;
  const prevQuota: Record<string, string | undefined> = {};

  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${MASTER}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  }

  function assertNoBlindLeak(v: unknown, trail = "$"): void {
    if (Array.isArray(v)) {
      v.forEach((e, i) => assertNoBlindLeak(e, `${trail}[${i}]`));
      return;
    }
    if (v !== null && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const low = k.toLowerCase();
        assert.ok(!low.includes("confiden"),
          `blind artifact leaks confidence-like key ${trail}.${k}`);
        assert.ok(!["rationale", "prediction", "verification", "evaluation", "score", "scores"].includes(low),
          `blind artifact leaks ${trail}.${k}`);
        assertNoBlindLeak(val, `${trail}.${k}`);
      }
    }
  }

  before(async () => {
    process.env["DATA_DIR"] = mkdtempSync(join(tmpdir(), "evex-blind-"));
    process.env["EVEX_AUTH_TOKEN"] = MASTER;
    delete process.env["EVEX_TENANT"];
    // Pin dev backend (see api-hardening.test.ts): API-behavior tests must
    // not depend on whatever hypervisor happens to be reachable.
    prevBackend = process.env["VM_BACKEND"];
    process.env["VM_BACKEND"] = "dev-framebuffer";
    for (const [k, v] of Object.entries({
      EVEX_MAX_VMS_PER_TENANT: "64",
      EVEX_MAX_TOTAL_VMS: "512",
      EVEX_MAX_CPU_PER_TENANT: "256",
      EVEX_MAX_MEM_MB_PER_TENANT: "524288",
    })) {
      prevQuota[k] = process.env[k];
      process.env[k] = v;
    }
    await ensureOptionals();
    __clearMemory();
    const app = buildApp();
    const s = createServer(app);
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
    srv = s;
    base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => srv?.close(() => resolve()));
    if (prevBackend === undefined) delete process.env["VM_BACKEND"];
    else process.env["VM_BACKEND"] = prevBackend;
    for (const [k, v] of Object.entries(prevQuota)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("enqueue strips confidence keys, submit unlocks full, double-submit 409s", async () => {
    const sess = await api("POST", "/v1/sessions", { goal: "blind flow case" });
    assert.equal(sess.status, 201);
    const sid = String(sess.json.id);
    const act = await api("POST", `/v1/computer/${sid}/act`, { type: "click", x: 50, y: 60, confidence: 0.9 });
    assert.equal(act.status, 200);

    const trace = await api("GET", `/v1/trace/${sid}`);
    const steps = trace.json.steps as Array<Record<string, unknown>>;
    const target = steps[steps.length - 1] as Record<string, unknown>;
    const stepId = String(target["step_id"]);

    const enq = await api("POST", "/v1/reviews", { sessionId: sid, stepId });
    assert.equal(enq.status, 201, `enqueue failed: ${JSON.stringify(enq.json)}`);
    assert.ok(typeof enq.json.reviewId === "string" && enq.json.reviewId.length > 0);
    assertNoBlindLeak(enq.json.blind);
    // Screen/timeline evidence survives blinding (the human judges the visible interaction).
    const blindStr = JSON.stringify(enq.json.blind);
    assert.ok(blindStr.includes("screen_before") || blindStr.includes("screen_after"),
      "blind artifact must keep screen evidence");

    const judge = {
      stepId, reviewer: "blind-tester",
      reasonable: true, targetCorrect: true, understandable: true, expected: true, recoveryOk: true,
      reviewId: String(enq.json.reviewId),
    };
    const sub = await api("POST", "/v1/judgments", judge);
    assert.equal(sub.status, 201, `submit failed: ${JSON.stringify(sub.json)}`);
    assert.ok(sub.json.full, "submit with reviewId must unlock the FULL step");
    assert.equal((sub.json.full.selected_action as Record<string, unknown>)?.["confidence"], 0.9);

    const dup = await api("POST", "/v1/judgments", { ...judge, reviewer: "blind-tester-2" });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error, "duplicate");

    const emptyReviewer = await api("POST", "/v1/judgments", { ...judge, reviewer: "  " });
    void emptyReviewer;
  });

  it("empty reviewer identity is rejected with 400", async () => {
    const bad = await api("POST", "/v1/judgments", {
      stepId: "step-never", reviewer: "   ",
      reasonable: true, targetCorrect: true, understandable: true, expected: true, recoveryOk: true,
    });
    assert.equal(bad.status, 400);
  });
});

describe("ml training + requirements", () => {
  it("train.py --help exits 0", function (t) {
    const py = findPython();
    if (!py) { t.skip("no python on PATH"); return; }
    const r = spawnSync(py, [join(ROOT, "ml", "training", "train.py"), "--help"], {
      encoding: "utf8", timeout: 60000,
    });
    assert.equal(r.status, 0, `--help failed: ${r.stderr}`);
    assert.match(String(r.stdout), /--smoke/);
    assert.match(String(r.stdout), /--resume-from/);
    assert.match(String(r.stdout), /--max-epochs/);
  });

  it("--smoke writes lineage with code commit field", function (t) {
    const py = findPython();
    if (!py) { t.skip("no python on PATH"); return; }
    const out = mkdtempSync(join(tmpdir(), "evex-smoke-"));
    const r = spawnSync(py, [join(ROOT, "ml", "training", "train.py"), "--smoke", "--out", out], {
      encoding: "utf8", timeout: 120000,
    });
    assert.equal(r.status, 0, `smoke failed: ${r.stderr}`);
    for (const f of ["model.json", "metrics.json", "lineage.json", "checkpoint.json"]) {
      assert.ok(existsSync(join(out, f)), `${f} missing after --smoke`);
    }
    const lineage = JSON.parse(readFileSync(join(out, "lineage.json"), "utf8")) as Record<string, unknown>;
    assert.ok(typeof lineage["code_commit"] === "string" && String(lineage["code_commit"]).length > 0,
      "lineage must carry a code_commit field");
    assert.ok(typeof lineage["config_hash"] === "string" && String(lineage["config_hash"]).length > 0);
  });

  it("requirements.txt exists with pinned majors", () => {
    const p = join(ROOT, "ml", "requirements.txt");
    assert.ok(existsSync(p), "ml/requirements.txt missing");
    const txt = readFileSync(p, "utf8");
    assert.match(txt, /torch/);
    assert.match(txt, /numpy/);
    assert.match(txt, /pillow/i);
  });
});

describe("dockerfiles + bootstrap", () => {
  for (const name of ["Dockerfile.api", "Dockerfile.worker", "Dockerfile.mcp", "Dockerfile.console", "Dockerfile.inference"]) {
    it(`${name} exists with non-root USER + HEALTHCHECK`, () => {
      const p = join(ROOT, "infra", "docker", name);
      assert.ok(existsSync(p), `${p} missing`);
      const txt = readFileSync(p, "utf8");
      assert.match(txt, /^USER /m, `${name} must set a non-root USER`);
      assert.ok(!/^USER root$/m.test(txt), `${name} must not run as root`);
      assert.match(txt, /^HEALTHCHECK /m, `${name} must declare a HEALTHCHECK`);
    });
  }

  it("linux-bootstrap.sh passes bash -n", function (t) {
    const bash = findBash();
    if (!bash) { t.skip("no bash on PATH"); return; }
    const r = spawnSync(bash, ["-n", join(ROOT, "infra", "deployment", "linux-bootstrap.sh")], {
      encoding: "utf8", timeout: 60000,
    });
    assert.equal(r.status, 0, `bash -n failed: ${r.stderr}`);
  });
});
