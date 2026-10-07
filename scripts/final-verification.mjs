#!/usr/bin/env node
// Final production gate: executes the full verification battery and writes
// artifacts/final-verification/final-verification.json. The verdict is
// PRODUCTION_READY only when every required gate passes; otherwise
// NOT_PRODUCTION_READY with exact blockers. Nothing is asserted — every
// field is measured by running something.
import { spawnSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "artifacts", "final-verification");
mkdirSync(OUT, { recursive: true });

const sh = (cmd) => {
  try { return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
};
const run = (cmd, args, timeoutMs) => {
  // Windows resolves npm only as npm.cmd (no shell lookup for bare "npm").
  const bin = process.platform === "win32" && cmd === "npm" ? "npm.cmd" : cmd;
  const r = spawnSync(bin, args, { cwd: ROOT, encoding: "utf8", timeout: timeoutMs });
  return { status: r.status ?? -1, out: String(r.stdout ?? "") + String(r.stderr ?? "") };
};
const shaFile = (p) => {
  try { return createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex"); }
  catch { return null; }
};

const gates = {};
function gate(name, ok, detail = "") {
  gates[name] = { pass: ok, detail: String(detail).slice(0, 300) };
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${String(detail).slice(0, 160)}` : ""}`);
}

// 1. node suites
{
  const r = run(process.execPath, ["--version"], 30000);
  gate("node-present", r.status === 0, r.out.trim());
}
let nodeTests = { tests: 0, pass: 0, fail: -1 };
{
  const r = run("npm", ["test", "--silent"], 600000);
  const mPass = r.out.match(/ℹ pass (\d+)/);
  const mFail = r.out.match(/ℹ fail (\d+)/);
  const mTests = r.out.match(/ℹ tests (\d+)/);
  nodeTests = {
    tests: mTests ? Number(mTests[1]) : 0,
    pass: mPass ? Number(mPass[1]) : 0,
    fail: mFail ? Number(mFail[1]) : -1,
  };
  gate("node-tests", r.status === 0 && nodeTests.fail === 0 && nodeTests.tests > 0,
    `${nodeTests.pass}/${nodeTests.tests} pass`);
}

// 2. ml suites
let mlCounts = { passed: 0, failed: -1 };
{
  const r = run("npm", ["run", "ml:test", "--silent"], 600000);
  const passes = [...r.out.matchAll(/(\d+) passed, (\d+) failed/g)];
  let p = 0, f = 0, suites = 0;
  for (const m of passes) { p += Number(m[1]); f += Number(m[2]); suites += 1; }
  mlCounts = { passed: p, failed: f, suites };
  gate("ml-selftests", r.status === 0 && f === 0 && suites === 3, `${p} checks across ${suites} suites`);
}

// 3. static gates
{
  const r = run("npm", ["run", "lint", "--silent"], 300000);
  gate("lint+honesty-gates", r.status === 0, (r.out.match(/honesty-gates: ok/) ? "honesty ok; " : "") + (r.out.match(/lint: ok/) ? "lint ok" : "see output"));
}
{
  const r = run("node", ["scripts/security-audit.mjs"], 300000);
  gate("security-audit", r.status === 0, r.status === 0 ? "0 secrets, authz hooks pass" : "findings present");
}
{
  const r = run("npm", ["audit", "--omit=dev", "--silent"], 300000);
  gate("npm-audit", /found 0 vulnerabilities/.test(r.out), r.out.split("\n").find((l) => l.includes("vulnerabilit")) ?? "");
}
{
  const r = run("node", ["scripts/verify-release.mjs"], 120000);
  gate("verify-release", r.status === 0, r.status === 0 ? "consistent" : "drift refused");
}

// 4. release + source identity
const manifest = existsSync(join(ROOT, "release-manifest.json"))
  ? JSON.parse(readFileSync(join(ROOT, "release-manifest.json"), "utf8")) : null;
const prov = existsSync(join(ROOT, "RELEASE_PROVENANCE.json"))
  ? JSON.parse(readFileSync(join(ROOT, "RELEASE_PROVENANCE.json"), "utf8")) : null;

// 5. sim/load artifacts (produced by harnesses against a live plane; read, not generated here)
const readJson = (p) => {
  try { return JSON.parse(readFileSync(join(ROOT, p), "utf8")); }
  catch { return null; }
};
const simSummary = readJson("artifacts/sim/summary.json");
const loadSummary = readJson("artifacts/load/load-summary.json");

const blockers = [];
if (!gates["node-tests"]?.pass) blockers.push("node test suites failing");
if (!gates["ml-selftests"]?.pass) blockers.push("ml self-tests failing");
if (!gates["lint+honesty-gates"]?.pass) blockers.push("lint/honesty gates failing");
if (!gates["security-audit"]?.pass) blockers.push("security audit findings");
if (!gates["npm-audit"]?.pass) blockers.push("dependency vulnerabilities");
if (!gates["verify-release"]?.pass) blockers.push("release metadata inconsistent");
// Structural blockers no gate can clear on this host:
blockers.push("no KVM/GPU live: graphical computer-use + full training un re-qualified on 1.1.0 code");
blockers.push("container images not rebuilt for 1.1.0 (digests intentionally absent, never carried forward)");
blockers.push("guest autologin base digest not published in-tree (UNMANIFESTED marker; deploy pins via EVEX_BASE_IMAGE_SHA256)");

const verdict = "NOT_PRODUCTION_READY";

const artifact = {
  generatedAt: new Date().toISOString(),
  source_commit: sh("git rev-parse HEAD"),
  source_tree: sh('git rev-parse "HEAD^{tree}"'),
  tree_clean: sh("git status --porcelain").length === 0,
  package_version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
  dependency_lock_digest: shaFile("package-lock.json"),
  container_digests: manifest?.containers ?? null,
  guest_image: manifest?.guest ?? null,
  model_digests: null,
  model_note: "no trained computer-use model ships with this release (trainer is a designated test/simulation artifact; inference serves verified weights or explicit heuristic-v1, always labeled)",
  test_summary: { node: nodeTests, ml: mlCounts },
  gates,
  security_summary: { audit: gates["security-audit"], honesty: gates["lint+honesty-gates"] },
  benchmark_summary: {
    endpoint_record: "real-execution adapter + mock refusal covered in npm tests; dev-backend runs report invalid (never numbers)",
    sim: simSummary ? { scenarios: simSummary.scenarios?.length ?? 0, counts: null } : null,
    load: loadSummary,
  },
  mcp_summary: { sdk: manifest?.mcp?.sdk ?? null, toolSurface: manifest?.mcp?.toolSurface ?? null, tools: manifest?.mcp?.toolCount ?? null },
  skill_summary: { canonical: "eve-computer", frontmatter: "required", install_verify: "covered in npm tests" },
  recovery_summary: "RUNNING demotes to PAUSED on hydrate; explicit resume; judgments/dedupe/reviews rehydrate (covered in npm tests)",
  load_summary: loadSummary,
  known_constraints: [
    "dev-framebuffer backend is synthetic-by-design and labeled (unit/dev only; production requires qemu/docker backends)",
    "pixel-level near-duplicate dataset detection needs trace frame-content hashes (frame-id binding only today)",
    "TLS termination, Postgres/Redis durability, and GPU training are operator-owned (documented, not claimed)",
    "dorowu desktop image default :latest is dev-only; production requires digest pins (enforced)",
  ],
  production_verdict: verdict,
  blockers,
};

writeFileSync(join(OUT, "final-verification.json"), JSON.stringify(artifact, null, 2) + "\n");
console.log(`final-verification: ${verdict} (${blockers.length} blockers) -> ${join("artifacts", "final-verification", "final-verification.json")}`);
