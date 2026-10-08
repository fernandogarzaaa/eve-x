#!/usr/bin/env node
// Release-consistency verifier: the release metadata must describe the
// ACTUAL release. Compares package.json, app versions, OpenAPI, the
// manifest, provenance, compose references, container pins, guest pins,
// and the MCP tool surface — and refuses inconsistent releases (exit 1
// with every drift listed). Used by `npm run release` and CI.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { gitEnv } from "./git-safe.mjs";

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
  // Hostile-environment hardening lives in git-safe.mjs (GIT_DIR etc.
  // would redirect revision queries at a different repository).
  try { return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnv() }).trim(); }
  catch { return ""; }
};

const pkg = (() => {
  try {
    return JSON.parse(read("package.json"));
  } catch {
    console.error("verify-release: package.json missing/unreadable — no identifiable release to verify");
    process.exit(1);
  }
})();
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
  // Standard release shape: code commit, then a metadata commit touching
  // ONLY the regenerated files. Accept manifest.commit == HEAD, or the
  // parent when HEAD is exactly such a metadata commit — anything else is
  // a manifest describing somebody else's tree.
  const GENERATABLE = new Set(["release-manifest.json", "RELEASE_PROVENANCE.json"]);
  let commitOk = m.commit === head;
  if (!commitOk) {
    const parent = sh("git rev-parse HEAD~1");
    const diffNames = sh("git diff-tree --no-commit-id --name-only -r HEAD")
      .split("\n").map((l) => l.trim()).filter(Boolean);
    if (m.commit === parent && diffNames.length > 0 && diffNames.every((f) => GENERATABLE.has(f))) {
      commitOk = true;
    }
  }
  const dirtyFiles = sh("git status --porcelain").split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => l.replace(/^([AMDRCU?!]{1,2})\s+/, "").replace(/"/g, ""));
  const foreignDirty = dirtyFiles.filter((f) => !GENERATABLE.has(f));
  check("manifest.version == package.json", m.version === version, `manifest=${m.version}`);
  check("manifest.commit describes HEAD (or its release-metadata commit)", commitOk, `manifest=${String(m.commit).slice(0, 12)} head=${head.slice(0, 12)}`);
  check("manifest.tree matches its commit's tree", m.tree === sh(`git rev-parse "${m.commit}^{tree}"`), "tree drift: manifest tree does not match its own commit");
  check("only regenerated release files are dirty", foreignDirty.length === 0, `unreleased changes: ${foreignDirty.slice(0, 5).join(", ")}`);
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
  // Release images: an empty map is honest ONLY with an imagesStatus note
  // (source release, images not rebuilt). Non-empty entries must be
  // version-matched sha256 digests — never carried-forward stale digests.
  const relImgs = m.containers?.releaseImages ?? {};
  const relKeys = Object.keys(relImgs);
  if (relKeys.length === 0) {
    check("empty releaseImages carries an imagesStatus note", typeof m.containers?.imagesStatus === "string" && m.containers.imagesStatus.length > 0, "omission without explanation");
  }
  for (const [name, digest] of Object.entries(relImgs)) {
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
  // Same release-metadata-commit accommodation as the manifest: the
  // provenance is generated before the metadata commit lands.
  let provOk = p.source?.commit === sh("git rev-parse HEAD");
  if (!provOk) {
    const parent = sh("git rev-parse HEAD~1");
    const diffNames = sh("git diff-tree --no-commit-id --name-only -r HEAD")
      .split("\n").map((l) => l.trim()).filter(Boolean);
    const GENERATABLE2 = new Set(["release-manifest.json", "RELEASE_PROVENANCE.json"]);
    if (p.source?.commit === parent && diffNames.length > 0 && diffNames.every((f) => GENERATABLE2.has(f))) {
      provOk = true;
    }
  }
  check("provenance.commit describes HEAD (or its release-metadata commit)", provOk, "commit drift");
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

// 4b. skills bound to measured identity (name + version + content digest).
// A changed skill without a regenerated manifest is stale by construction.
{
  let manifestDoc = null;
  try {
    manifestDoc = JSON.parse(readSoft("release-manifest.json"));
  } catch {
    failures.push("release-manifest.json unreadable for skill binding check");
  }
  const bound = manifestDoc !== null && Array.isArray(manifestDoc.skills?.bound) ? manifestDoc.skills.bound : null;
  if (!bound) {
    failures.push("manifest skills.bound missing (skills unbound to release)");
  } else {
    for (const s of bound) {
      check(`skill ${s.name} has version + digest`, typeof s.version === "string" && /^[0-9a-f]{64}$/i.test(String(s.digest ?? "")), JSON.stringify(s).slice(0, 120));
    }
    // Bound skills must still match the tree: re-measure one digest per skill.
    for (const s of bound) {
      try {
        const dir = join(ROOT, "skills", String(s.name));
        if (!statSync(dir).isDirectory()) {
          failures.push(`bound skill missing from tree: ${s.name}`);
          continue;
        }
        const man = JSON.parse(readFileSync(join(dir, "skill.json"), "utf8"));
        const entry = readFileSync(join(dir, man.entrypoint ?? "SKILL.md"));
        const recomputed = createHash("sha256")
          .update(readFileSync(join(dir, "skill.json")))
          .update(entry).digest("hex");
        check(`skill ${s.name}@${s.version} digest matches tree`, recomputed === String(s.digest).toLowerCase(), "skill changed without manifest regen (stale binding)");
      } catch {
        failures.push(`bound skill unreadable: ${s.name}`);
      }
    }
  }
}

// 4c. exact-match tag on HEAD must equal the package version. Tags are
// human-applied release markers; a mismatched tag ships the wrong story.
{
  const tag = sh("git describe --tags --exact-match");
  if (tag) {
    check("HEAD tag == package.json version", tag === version || tag === `v${version}`, `tag=${tag} pkg=${version}`);
  } else {
    ok.push("no exact-match tag on HEAD (untagged release commit)");
  }
}

// 4d. release archives: every file listed in RELEASE_ARTIFACTS.sha256 must
// exist with the recorded digest (catches post-archive tampering). Absent
// bundle dir (source-only checkout) is skipped, not failed.
{
  const shaPath = join(ROOT, "artifacts", "release", "pkg", "RELEASE_ARTIFACTS.sha256");
  if (existsSync(shaPath)) {
    const lines = readSoft("artifacts/release/pkg/RELEASE_ARTIFACTS.sha256").split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
        const mline = line.match(/^([0-9a-f]{64})\s+(.+)$/i);
        if (!mline) {
          failures.push(`malformed archive digest line: ${line.slice(0, 80)}`);
          continue;
        }
        const [, digest, rel] = mline;
        const full = join(ROOT, "artifacts", "release", rel);
        let actual = null;
        try {
          actual = createHash("sha256").update(readFileSync(full)).digest("hex");
        } catch { /* missing below */ }
        check(`archive intact: ${rel}`, actual === digest?.toLowerCase(), actual === null ? "file missing after archive" : "digest mismatch (tampered after packaging)");
      }
  } else {
    ok.push("no release bundle dir (source-only checkout; archives unverified)");
  }
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
  // Every script that shells out to git must scrub hostile env first.
  if (/execSync\(cmd/.test(src)) {
    check(`${f} scrubs git env`, src.includes("gitEnv()"), "GIT_DIR-style poisoning of revision queries");
  }
}

console.log(`verify-release: ${ok.length} checks passed`);
if (failures.length > 0) {
  console.error(`verify-release: ${failures.length} drift(s) REFUSED:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("verify-release: consistent");
