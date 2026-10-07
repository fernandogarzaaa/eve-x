#!/usr/bin/env node
// Release-consistency verifier: the release metadata must describe the
// ACTUAL release. Compares package.json, app versions, OpenAPI, the
// manifest, provenance, compose references, container pins, guest pins,
// and the MCP tool surface — and refuses inconsistent releases (exit 1
// with every drift listed). Used by `npm run release` and CI.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const ok = [];
const check = (name, cond, detail = "") => {
  if (cond) ok.push(name);
  else failures.push(`${name}${detail ? ` :: ${detail}` : ""}`);
};
const read = (p) => readFileSync(join(ROOT, p), "utf8");
// Missing expected files are refusal (drift), never a crash: a release
// that cannot be fully verified is an unverifiable release.
const readSoft = (p) => {
  try {
    return read(p);
  } catch {
    failures.push(`${p} missing (release cannot be verified without it)`);
    return "";
  }
};
const sh = (cmd) => {
  try { return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
};

const pkg = JSON.parse(read("package.json"));
const version = pkg.version;

// 1. version agreement across every surface
const cliVersion = readSoft("apps/cli/src/index.ts").match(/const VERSION = "([^"]+)"/)?.[1];
check("cli VERSION == package.json", cliVersion === version, `cli=${cliVersion} pkg=${version}`);
const mcpVersion = readSoft("apps/mcp/src/index.ts").match(/new\s+McpServer\(\{\s*name:\s*"eve-x",\s*version:\s*"([^"]+)"/)?.[1];
check("mcp server version == package.json", mcpVersion === version, `mcp=${mcpVersion} pkg=${version}`);
let openapiVersion = null;
try {
  openapiVersion = JSON.parse(readSoft("apps/api/openapi.json")).info.version;
} catch {
  failures.push("apps/api/openapi.json unreadable (release cannot be verified without it)");
}
check("openapi version == package.json", openapiVersion === version, `openapi=${openapiVersion} pkg=${version}`);

// 2. release-manifest.json describes THIS source
if (!existsSync(join(ROOT, "release-manifest.json"))) {
  failures.push("release-manifest.json missing (run npm run release on a clean tree)");
} else {
  const m = JSON.parse(readSoft("release-manifest.json"));
  const head = sh("git rev-parse HEAD");
  const tree = sh('git rev-parse "HEAD^{tree}"');
  const dirty = sh("git status --porcelain").length > 0;
  check("manifest.version == package.json", m.version === version, `manifest=${m.version}`);
  check("manifest.commit == HEAD", m.commit === head, `manifest=${String(m.commit).slice(0, 12)} head=${head.slice(0, 12)}`);
  check("manifest.tree == HEAD^{tree}", m.tree === tree, "tree drift");
  check("release tree is clean", m.dirty === false && dirty === false, "dirty release must never ship");
  check("manifest mcp server matches", String(m.mcp?.server ?? "") === `eve-x ${version}`, `got ${m.mcp?.server}`);
  const shared = readSoft("packages/mcp-shared/src/index.ts").match(/MCP_TOOL_VERSION\s*=\s*"([^"]+)"/)?.[1];
  check("manifest toolSurface == MCP_TOOL_VERSION", m.mcp?.toolSurface === shared, `manifest=${m.mcp?.toolSurface} src=${shared}`);
  try {
    const installedSdk = JSON.parse(readSoft("node_modules/@modelcontextprotocol/sdk/package.json")).version;
    check("manifest mcp.sdk == installed SDK", m.mcp?.sdk === installedSdk, `manifest=${m.mcp?.sdk} installed=${installedSdk}`);
  } catch {
    check("manifest mcp.sdk == installed SDK", m.mcp?.sdk === "unknown", "SDK not installed; manifest must say unknown");
  }
  const mcpSrc = readSoft("apps/mcp/src/index.ts");
  const counted = [...mcpSrc.matchAll(/registerTool\("([^"]+)"/g)].map((x) => x[1]);
  check("manifest toolCount matches source", m.mcp?.toolCount === counted.length, `manifest=${m.mcp?.toolCount} src=${counted.length}`);
  const g = m.guest ?? {};
  if (g.imageSha256 !== null && g.imageSha256 !== undefined) {
    check("manifest guest digest is sha256", /^[0-9a-f]{64}$/i.test(String(g.imageSha256)), `got ${g.imageSha256}`);
  } else {
    check("manifest guest explicitly unmanifested (no stale digest)", /UNMANIFESTED/.test(String(g.status ?? "")), "stale or missing guest digest with no marker");
  }
  for (const [name, digest] of Object.entries(m.containers?.releaseImages ?? {})) {
    check(`release image ${name} carries version`, String(name).includes(version), `got ${name}`);
    check(`release image ${name} digest is sha256`, /^sha256:[0-9a-f]{64}$/i.test(String(digest)), `got ${digest}`);
  }
}

// 3. provenance agreement
if (!existsSync(join(ROOT, "RELEASE_PROVENANCE.json"))) {
  failures.push("RELEASE_PROVENANCE.json missing (run npm run release on a clean tree)");
} else {
  const p = JSON.parse(readSoft("RELEASE_PROVENANCE.json"));
  check("provenance.version == package.json", p.version === version, `prov=${p.version}`);
  check("provenance.commit == HEAD", p.source?.commit === sh("git rev-parse HEAD"), "commit drift");
}

// 4. deployment references match the release
const rel = readSoft("infra/deployment/docker-compose.release.yml");
const tagDefault = rel.match(/EVEX_IMAGE_TAG:-(.*?)}/)?.[1];
check("compose.release EVEX_IMAGE_TAG default == package.json", tagDefault === version, `got ${tagDefault}`);
const compose = readSoft("infra/deployment/docker-compose.yml");
for (const img of ["postgres:16-alpine", "redis:7-alpine", "dxflrs/garage:v2.0.0"]) {
  const line = compose.split("\n").find((l) => l.includes(img));
  check(`compose pins ${img} by digest`, !!line && line.includes("@sha256:"), `got ${(line ?? "").trim()}`);
}
for (const weak of [":-change-me}", ":-evex}", ":-test}", ":-password}"]) {
  check(`compose has no weak default ${weak}`, !compose.includes(weak), "weak default secret");
}

// 5. script hygiene (platform + path bugs that once shipped). The redirect
// token is assembled dynamically so this detector's own source stays clean.
const NUL_TOKEN = ["2>", "nul"].join("");
const nulRe = new RegExp(`'[^'\\n]*${NUL_TOKEN}[^'\\n]*'|"[^"\\n]*${NUL_TOKEN}[^"\\n]*"`, "i");
for (const f of ["scripts/gen-release-identity.mjs", "scripts/gen-release-manifest.mjs", "scripts/gen-provenance.mjs", "scripts/release-baseline.mjs", "scripts/package-release.mjs", "scripts/verify-release.mjs"]) {
  if (!existsSync(join(ROOT, f))) continue;
  const src = read(f);
  // Code-shaped patterns (quoted shell commands / env access), so these
  // very check descriptions — prose, not commands — cannot trip them.
  check(`${f} has no 2>nul redirect`, !nulRe.test(src), "Windows-only redirect creates ./nul on POSIX");
  check(`${f} has no hardcoded windows root`, !/"[A-Z]:\\\\|'[A-Z]:\\\\/.test(src), "non-portable root");
  check(`${f} has no release-commit override`, !/process\.env\[.EVEX_RELEASE_COMMIT/.test(src), "override lets metadata lie about HEAD");
}

console.log(`verify-release: ${ok.length} checks passed`);
if (failures.length > 0) {
  console.error(`verify-release: ${failures.length} drift(s) REFUSED:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("verify-release: consistent");
