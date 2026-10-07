#!/usr/bin/env node
// Honesty gates: static prohibitions for production-integrity patterns.
// CI fails on any hit. Each gate names the invariant it protects; suppress
// a gate only by fixing the code, never by editing this file to allow it.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const fail = (gate, where, detail = "") => {
  failures += 1;
  console.error(`HONESTY-FAIL [${gate}] ${where}${detail ? ` :: ${detail}` : ""}`);
};

function walk(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".git" || e === "data" || e === "artifacts") continue;
    const p = join(dir, e);
    let st = null;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|mts|js|mjs|cjs|py|sh)$/.test(e)) out.push(p);
  }
  return out;
}

const prodTs = walk(join(ROOT, "apps")).concat(walk(join(ROOT, "packages")));
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

// 1. No synthetic production execution in the worker.
{
  const src = read(join(ROOT, "apps", "worker", "src", "index.ts"));
  if (/function prng|pngBase64:\s*""/.test(src)) fail("no-synthetic-worker", "apps/worker/src/index.ts", "PRNG perception or empty-pixel frames");
  if (/verified:\s*true/.test(src) || /passed:\s*true/.test(src)) fail("no-self-certifying-worker", "apps/worker/src/index.ts", "worker must never write verified/passed evidence");
}

// 2. No hardcoded task success.
for (const f of prodTs) {
  if (/verdict:\s*["']pass["']/.test(read(f))) fail("no-hardcoded-pass", f);
}

// 3. No fake model readiness/identity in the inference plane.
{
  const src = read(join(ROOT, "ml", "inference", "server.py"));
  if (src.includes('"cua-custom"') || src.includes("'cua-custom'")) fail("no-model-masquerade", "ml/inference/server.py", "auto-claimed model id");
  if (/\.read\(8\)/.test(src)) fail("no-byte-sniff-loading", "ml/inference/server.py", "head-read is not model loading");
  for (const need of ["weights_verified", "action_source", "model-not-loaded", "model_sha256"]) {
    if (!src.includes(need)) fail("model-identity-complete", "ml/inference/server.py", `missing ${need}`);
  }
}

// 4. No basename-only executable authorization / lexical-only jail.
{
  const src = read(join(ROOT, "packages", "guest", "src", "index.ts"));
  if (/\.split\("\/"\)\.pop\(\)/.test(src)) fail("no-basename-authz", "packages/guest/src/index.ts", "naive basename split");
  for (const need of ["resolveExecutable", "canonicalInsideRoot", "O_NOFOLLOW", "recheckContainment"]) {
    if (!src.includes(need)) fail("guest-jail-complete", "packages/guest/src/index.ts", `missing ${need}`);
  }
}

// 5. No mock benchmark evidence reachable from production paths.
{
  const api = read(join(ROOT, "apps", "api", "src", "index.ts"));
  if (/rand\(\)\s*<\s*0\.6/.test(api)) fail("no-inline-bench-agent", "apps/api/src/index.ts", "seeded PRNG agent");
  if (!api.includes("SYNTHETIC_RESULT_REFUSED") && !api.includes("mock_agent_requires_test_only")) {
    fail("bench-mock-gate", "apps/api/src/index.ts", "mock agent must be gated");
  }
  const bench = read(join(ROOT, "packages", "benchmarks", "src", "index.ts"));
  if (!bench.includes("SYNTHETIC_RESULT_REFUSED")) fail("bench-refusal", "packages/benchmarks/src/index.ts");
}

// 6. No toy-hash evidence digests.
for (const f of prodTs) {
  if (/sha1hex\s*\(/.test(read(f))) fail("no-toy-digest", f, "use sha256hex");
}

// 7. No mutable production image tags (qual-desktop is the labeled exception).
for (const f of walk(join(ROOT, "infra"))) {
  const src = read(f);
  if (/:latest/.test(src) && !/TEST-ONLY|test-only/i.test(src)) fail("no-mutable-tags", f);
}
{
  const compose = read(join(ROOT, "infra", "deployment", "docker-compose.yml"));
  for (const weak of [":-change-me}", ":-evex}", ":-test}", ":-password}"]) {
    if (compose.includes(weak)) fail("no-weak-defaults", "docker-compose.yml", weak);
  }
}

// 8. No release-commit override mechanism.
for (const f of walk(join(ROOT, "scripts"))) {
  if (/process\.env\[.EVEX_RELEASE_COMMIT/.test(read(f))) fail("no-release-override", f);
}

// 9. No dev-anon fallback outside the explicit development gate.
{
  const sec = read(join(ROOT, "packages", "security", "src", "index.ts"));
  if (!sec.includes('executionMode() !== "development"')) fail("fail-closed-auth", "packages/security/src/index.ts");
}

// 10. No bearer/secret values interpolated into logs.
for (const f of prodTs) {
  const lines = read(f).split("\n");
  lines.forEach((line, i) => {
    if (/\blog\s*\(/.test(line) && /req\.headers|headers\[.authorization|EVEX_AUTH_TOKEN\]/.test(line)) {
      fail("no-secret-logging", `${f}:${i + 1}`, line.trim().slice(0, 100));
    }
  });
}

// 11. Validate endpoint requires evidence (never manufactures pass).
{
  const api = read(join(ROOT, "apps", "api", "src", "index.ts"));
  if (!api.includes("evidence_required")) fail("validate-needs-evidence", "apps/api/src/index.ts");
}

// 12. Worker control-plane refusal of synthetic backends.
{
  const w = read(join(ROOT, "apps", "worker", "src", "index.ts"));
  for (const need of ["SYNTHETIC_BACKEND_REFUSED", "SYNTHETIC_BACKEND_REJECTED"]) {
    if (!w.includes(need)) fail("worker-refusal", "apps/worker/src/index.ts", `missing ${need}`);
  }
}

if (failures > 0) {
  console.error(`honesty-gates: ${failures} violation(s) — refusing`);
  process.exit(1);
}
console.log("honesty-gates: ok");
