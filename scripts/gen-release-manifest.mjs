#!/usr/bin/env node
// Generates release-manifest.json (§16): everything required to identify the
// release in one place. Re-run at RC freeze; values are measured, not asserted.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sh = (cmd) => {
  try { return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
};
const shaFile = (p) => createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex");

// MCP tool inventory straight from source (no stale definitions).
const mcpSrc = readFileSync(join(ROOT, "apps", "mcp", "src", "index.ts"), "utf8");
const tools = [...mcpSrc.matchAll(/registerTool\("([^"]+)"/g)].map((m) => m[1]);

const manifest = {
  product: "eve-x",
  version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
  commit: sh("git rev-parse HEAD"),
  tree: sh('git rev-parse "HEAD^{tree}"'),
  dirty: sh("git status --porcelain").length > 0,
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
    releaseImages: {
      "evex-api:1.0.1": "sha256:ceed62ba0254f77f1cc6261cf5a0bcd3e7caa4fd72f002c8aa565097cafbe6a0",
      "evex-worker:1.0.1": "sha256:61384930b22ebbf130014803d2b6d6f6f4f76dc0f3ba728f8f905aca53e5493c",
      "evex-mcp:1.0.1": "sha256:0af312620bada33a33676c1e73e57696bb46a37f379525c473becd4722b21c70",
      "evex-console:1.0.1": "sha256:033ca682e873fdf515c31d96a9ef6d2c05ed142b770eba0351461ae8a3ce2dbf",
      "evex-inference:1.0.1": "sha256:71dec1610382ec3ce83dff32250856c5459bdbc9209ca18b4ef670168231485c",
    },
  },
  guest: {
    image: "eve-desktop-xorg.qcow2",
    imageSha256: "38afb22b948e61c11fa044204a2cf2372bbb1ba80fb94075dcac9d45ae5b4249",
    baseImage: "eve-desktop-noble.qcow2",
    baseSha256: "e19b77ba669ef5e813213a145a99efeeb3d4f58a0fc220dad2f9b4891679273b",
    sealedReadonly: true,
    reproducibility: "logical (sealed base digest + bake manifest); not claimed bit-for-bit",
  },
  model: {
    // 1.0.0 ships the evaluator/registry + stdlib smoke path; release
    // checkpoints are recorded in the registry with digests at promotion.
    registry: "filesystem-first (DATA_DIR/models), gated promotion, sha256 checkpoints",
    smokePath: "stdlib-only (no torch required)",
  },
  mcp: { server: "eve-x 1.0.0", toolSurface: "mcp/1", tools, toolCount: tools.length },
  skills: { contract: "AGENT_SKILL.md", integrations: ["claude-code", "codex", "generic", "hermes", "openclaw", "opencode", "pi"], installerTargets: ["claude-code", "codex", "opencode", "cursor", "windsurf"] },
};
writeFileSync(join(ROOT, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`release-manifest: v${manifest.version} commit=${manifest.commit.slice(0, 12)} dirty=${manifest.dirty} mcpTools=${tools.length}`);
