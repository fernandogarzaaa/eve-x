#!/usr/bin/env node
// Generates release-manifest.json (§16): everything required to identify the
// release in one place. Re-run at RC freeze; values are measured, not asserted.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv } from "./git-safe.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sh = (cmd) => {
  try { return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnv() }).trim(); }
  catch { return ""; }
};
const shaFile = (p) => createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex");
// Release outputs are not source: dirty means foreign (non-regenerable)
// changes only — the same GENERATABLE set verify-release enforces.
const GENERATABLE = ["release-manifest.json", "RELEASE_PROVENANCE.json"];
const sourceDirty = sh("git status --porcelain").split("\n").map((l) => l.trim()).filter(Boolean)
  .some((l) => !GENERATABLE.some((g) => l.endsWith(g)));

// MCP tool inventory straight from source (no stale definitions).
const mcpSrc = readFileSync(join(ROOT, "apps", "mcp", "src", "index.ts"), "utf8");
const tools = [...mcpSrc.matchAll(/registerTool\("([^"]+)"/g)].map((m) => m[1]);
// MCP server + tool-surface versions straight from source (never hardcoded).
const mcpServerVersion = mcpSrc.match(/new\s+McpServer\(\{\s*name:\s*"eve-x",\s*version:\s*"([^"]+)"/)?.[1] ?? "unknown";
const sharedSrc = readFileSync(join(ROOT, "packages", "mcp-shared", "src", "index.ts"), "utf8");
const toolSurface = sharedSrc.match(/MCP_TOOL_VERSION\s*=\s*"([^"]+)"/)?.[1] ?? "unknown";
// SDK line, measured from the installed dependency (never asserted).
let sdkVersion = "unknown";
try {
  sdkVersion = JSON.parse(readFileSync(join(ROOT, "node_modules", "@modelcontextprotocol", "sdk", "package.json"), "utf8")).version;
} catch { /* uninstalled tree: recorded as unknown */ }
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
    baseImages: {
      "node:20-slim": "sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0",
      "python:3.11-slim": "sha256:bab1b7ef4b450c81002278d035eff85ebe394ae94df904f7a3ba14f7e16e487b",
      "dxflrs/garage:v2.0.0": "sha256:15b40e0dddd2e611aa746ff6f7c3bfe9f22735e4a2cc29e0abd89c268e9b79d9",
      "postgres:16-alpine": "sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea",
      "redis:7-alpine": "sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499",
    },
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
  mcp: { server: `eve-x ${mcpServerVersion}`, toolSurface, sdk: sdkVersion, tools, toolCount: tools.length },
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
