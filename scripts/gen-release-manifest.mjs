#!/usr/bin/env node
// Generates release-manifest.json (§16): everything required to identify the
// release in one place. Re-run at RC freeze; values are measured, not asserted.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv } from "./git-safe.mjs";
import { isGeneratablePorcelainLine } from "./release-paths.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sh = (cmd) => {
  try { return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnv() }).trim(); }
  catch { return ""; }
};
const shaFile = (p) => createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex");
// Release outputs are not source: dirty means foreign (non-regenerable)
// changes only — the same GENERATABLE set verify-release enforces, matched
// by exact repo-relative path (release-paths.mjs), never suffix.
const sourceDirty = sh("git status --porcelain").split("\n").map((l) => l.trim()).filter(Boolean)
  .some((l) => !isGeneratablePorcelainLine(l));

// MCP tool inventory straight from source (no stale definitions).
const mcpSrc = readFileSync(join(ROOT, "apps", "mcp", "src", "index.ts"), "utf8");
const tools = [...mcpSrc.matchAll(/registerTool\("([^"]+)"/g)].map((m) => m[1]);
// MCP server + tool-surface versions straight from source (never hardcoded).
const mcpServerVersion = mcpSrc.match(/new\s+McpServer\(\{\s*name:\s*"eve-x",\s*version:\s*"([^"]+)"/)?.[1] ?? "unknown";
const sharedSrc = readFileSync(join(ROOT, "packages", "mcp-shared", "src", "index.ts"), "utf8");
const toolSurface = sharedSrc.match(/MCP_TOOL_VERSION\s*=\s*"([^"]+)"/)?.[1] ?? "unknown";
// SDK lines, measured from the installed dependencies (never asserted).
// v2 split packages: server + node ship runtime code; client is dev/test.
function depVersion(name) {
  try {
    return JSON.parse(readFileSync(join(ROOT, "node_modules", ...name.split("/"), "package.json"), "utf8")).version;
  } catch { return "unknown"; }
}
const mcpSdks = {
  server: depVersion("@modelcontextprotocol/server"),
  node: depVersion("@modelcontextprotocol/node"),
  client: depVersion("@modelcontextprotocol/client"),
};
// Guest base: an in-tree bake manifest when the bake host published one;
// otherwise an explicit UNMANIFESTED marker (never a stale digest).
let guestManifest = null;
try {
  guestManifest = JSON.parse(readFileSync(join(ROOT, "images", "guest-manifest.json"), "utf8"));
} catch { /* no published bake manifest in-tree */ }

function measureSkills() {
  const out = [];
  let dirs = [];
  try {
    dirs = readdirSync(join(ROOT, "skills")).filter((d) => {
      try { return statSync(join(ROOT, "skills", d)).isDirectory(); } catch { return false; }
    }).sort();
  } catch { return out; }
  for (const d of dirs) {
    try {
      const man = JSON.parse(readFileSync(join(ROOT, "skills", d, "skill.json"), "utf8"));
      const entry = readFileSync(join(ROOT, "skills", d, man.entrypoint ?? "SKILL.md"));
      const digest = createHash("sha256")
        .update(readFileSync(join(ROOT, "skills", d, "skill.json")))
        .update(entry).digest("hex");
      out.push({ name: man.name ?? d, version: man.version ?? "unknown", digest });
    } catch { /* unmeasurable skill dir: omitted (verifier flags drift, not absence) */ }
  }
  return out;
}

// Base-image digests are MEASURED, not asserted: they come from the
// registry-measurement record images/base-digests.json (method + host +
// timestamp recorded there). A ref with no record is UNMEASURED (null
// digest + explicit status) — never a hardcoded constant copied into this
// script. Dockerfile digest pins are frozen snapshots for reproducible
// builds, a different claim from live tag resolution, and are NOT
// presented as measurements here.
let baseRecord = null;
try {
  baseRecord = JSON.parse(readFileSync(join(ROOT, "images", "base-digests.json"), "utf8"));
} catch { /* no measurement record: every ref UNMEASURED */ }
const BASE_REFS = [
  "docker.io/library/node:20-slim",
  "docker.io/library/python:3.11-slim",
  "docker.io/library/postgres:16-alpine",
  "docker.io/library/redis:7-alpine",
  "docker.io/dxflrs/garage:v2.0.0",
];
const baseImages = {};
for (const ref of BASE_REFS) {
  const rec = baseRecord?.images?.[ref];
  baseImages[ref] = (rec && /^sha256:[0-9a-f]{64}$/i.test(rec.digest ?? ""))
    ? { digest: String(rec.digest).toLowerCase(), measuredAt: baseRecord.measuredAt ?? null, method: baseRecord.method ?? baseRecord.measuredBy ?? null }
    : { digest: null, status: "UNMEASURED: no registry measurement recorded in images/base-digests.json for this ref" };
}
const baseRecordSha = existsSync(join(ROOT, "images", "base-digests.json")) ? shaFile("images/base-digests.json") : null;
const manifest = {
  product: "eve-x",
  version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
  commit: sh("git rev-parse HEAD"),
  tree: sh('git rev-parse "HEAD^{tree}"'),
  dirty: sourceDirty,
  generatedAt: new Date().toISOString(),
  toolchain: { node: sh("node --version"), npm: sh("npm --version"), python: sh("python --version") },
  lockfiles: { "package-lock.json": shaFile("package-lock.json") },
  containers: {
    baseImages,
    baseMeasuredFrom: baseRecordSha
      ? { file: "images/base-digests.json", sha256: baseRecordSha, measuredAt: baseRecord?.measuredAt ?? null }
      : { file: "images/base-digests.json", sha256: null, status: "no measurement record in tree" },
    releaseImages: {},
    // No stale digests are ever carried forward: image digests describe
    // BUILT artifacts. This source release did not rebuild containers, so
    // the map stays empty (verified, not omitted) until images are built
    // and their digests measured into it.
    imagesStatus: "not-built for this source release (rebuild container images to populate digests; never copy digests across versions)",
  },
  guest: guestManifest ?? {
    image: "eve-desktop-autologin.qcow2",
    imageSha256: null,
    status: "UNMANIFESTED: no bake manifest published in-tree (images/guest-manifest.json missing) — production boots the sealed base per EVEX_BASE_IMAGE_SHA256, not this file",
    sealedReadonly: true,
    reproducibility: "logical (sealed base digest + bake manifest); not claimed bit-for-bit",
  },
  model: {
    // ModelRuntime (ml/inference/server.py): weights are verified
    // (existence, size, sha256, container format, torch load + parameter
    // census) before ready=true; served actions come from the explicit
    // heuristic-v1 policy (always degraded=true) until a model-forward
    // action path exists. Release checkpoints are recorded in the
    // registry with digests at promotion.
    runtime: "ModelRuntime (verify-then-load; explicit heuristic fallback only)",
    registry: "filesystem-first (DATA_DIR/models), gated promotion, sha256 checkpoints",
    smokePath: "stdlib-only selftest (ml/inference/selftest.py; torch paths via stub injection)",
  },
  mcp: { server: `eve-x ${mcpServerVersion}`, toolSurface, sdks: mcpSdks, tools, toolCount: tools.length },
  // Skills: measured identity per skill dir (name + version + content
  // digest over skill.json + entrypoint). A changed skill without a
  // regenerated manifest is stale by construction — verify-release refuses.
  skills: {
    contract: "AGENT_SKILL.md",
    integrations: ["claude-code", "codex", "generic", "hermes", "openclaw", "opencode", "pi"],
    installerTargets: ["claude-code", "codex", "opencode", "cursor", "windsurf"],
    bound: measureSkills(),
  },
};
writeFileSync(join(ROOT, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`release-manifest: v${manifest.version} commit=${manifest.commit.slice(0, 12)} dirty=${manifest.dirty} mcpTools=${tools.length}`);
