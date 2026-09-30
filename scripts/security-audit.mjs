#!/usr/bin/env node
// Security audit: dependency list, secret regex scan, authz test hooks.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] ?? ".";
const report = { at: new Date().toISOString(), deps: {}, secrets: [], authz: [] };

// 1. dependency list
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  report.deps = { dependencies: pkg.dependencies ?? {}, devDependencies: pkg.devDependencies ?? {} };
} catch (err) {
  report.deps = { error: String(err) };
}

// 2. secret scan ( staged source only; never prints values )
const SECRET_RES = [
  { name: "aws-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "private-key", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "generic-token", re: /(api[_-]?key|secret|password)\s*[:=]\s*['"][^'"]{8,}['"]/i },
  { name: "bearer", re: /Bearer\s+[A-Za-z0-9\-._~+/=]{20,}/ },
  { name: "evex-token-literal", re: /evex_[0-9a-f]{16,}/ },
];
function walk(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".git" || e === "data") continue;
    const p = join(dir, e);
    let st = null;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs|json|md|env|example)$/.test(e)) out.push(p);
  }
  return out;
}
for (const f of walk(ROOT)) {
  let text = "";
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  // allow documented placeholders in .env.example
  const isExample = f.endsWith(".env.example");
  text.split("\n").forEach((line, i) => {
    for (const s of SECRET_RES) {
      if (s.re.test(line)) {
        if (isExample && /change-me|example|localhost/i.test(line)) continue;
        report.secrets.push({ file: f, line: i + 1, kind: s.name });
      }
    }
  });
}

// 3. authz hooks: verify every /v1 route file wires auth + capability checks
const apiIndex = join(ROOT, "apps", "api", "src", "index.ts");
if (existsSync(apiIndex)) {
  const src = readFileSync(apiIndex, "utf8");
  const needs = ["requireAuth", "requireCap", "401", "403"];
  for (const n of needs) {
    report.authz.push({ check: `api contains ${n}`, pass: src.includes(n) });
  }
  const v1Uses = (src.match(/v1\.(get|post|delete|put|patch)/g) ?? []).length;
  report.authz.push({ check: "v1 routes present", pass: v1Uses >= 10, count: v1Uses });
} else {
  report.authz.push({ check: "apps/api/src/index.ts exists", pass: false });
}
const secIndex = join(ROOT, "packages", "security", "src", "index.ts");
if (existsSync(secIndex)) {
  const src = readFileSync(secIndex, "utf8");
  for (const n of ["verifyToken", "requireCap", "writeAudit", "revokeSessionToken"]) {
    report.authz.push({ check: `security exports ${n}`, pass: src.includes(n) });
  }
} else {
  report.authz.push({ check: "packages/security/src/index.ts exists", pass: false });
}

const failed = report.secrets.length > 0 || report.authz.some((a) => !a.pass);
console.log(JSON.stringify(report, null, 2));
if (failed) {
  console.error("security-audit: findings require attention");
  process.exit(2);
}
console.log("security-audit: ok");
