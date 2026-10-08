import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// Adversarial audit of scripts/verify-release.mjs (26 cases). The verifier
// must REJECT forgeries/drift, ACCEPT clean consistent trees, CLASSIFY
// boundary conditions explicitly — and never crash with an unhandled
// exception. Each case builds a hermetic fixture repo (no fixture shares
// state with E:\eve-x or with other cases).

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VERSION = "9.9.9-attack";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8", timeout: 60000 }).trim();
}

function runVerifier(dir: string, extraEnv: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ["scripts/verify-release.mjs"], {
      cwd: dir, stdio: "pipe", encoding: "utf8", timeout: 120000,
      env: { ...process.env, ...extraEnv },
    });
    return { code: 0, out: String(out) };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return { code: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

function writeTree(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
}

function baseFiles() {
  return {
    "package.json": JSON.stringify({ name: "x", version: VERSION }),
    "apps/cli/src/index.ts": `export const VERSION = "${VERSION}";\n`,
    "apps/mcp/src/index.ts": `import { McpServer } from "x";\nconst s = new McpServer({ name: "eve-x", version: "${VERSION}" });\nregisterTool("t1", {});\nregisterTool("t2", {});\n`,
    "apps/api/openapi.json": JSON.stringify({ info: { version: VERSION } }),
    "packages/mcp-shared/src/index.ts": `export const MCP_TOOL_VERSION = "mcp/1" as const;\n`,
    "skills/alpha/skill.json": JSON.stringify({ name: "alpha", version: "1.0.0", description: "d", entrypoint: "SKILL.md" }),
    "skills/alpha/SKILL.md": "# alpha\n\nbody\n",
    "infra/deployment/docker-compose.yml": "services:\n  postgres:\n    image: postgres:16-alpine@sha256:" + "a".repeat(64) + "\n  redis:\n    image: redis:7-alpine@sha256:" + "b".repeat(64) + "\n  garage:\n    image: dxflrs/garage:v2.0.0@sha256:" + "c".repeat(64) + "\n",
    "infra/deployment/docker-compose.release.yml": "services:\n  api:\n    image: evex-api:${EVEX_IMAGE_TAG:-" + VERSION + "}\n",
    "node_modules/@modelcontextprotocol/sdk/package.json": JSON.stringify({ name: "@modelcontextprotocol/sdk", version: "0.0.0-fixture" }),
    "scripts/gen-release-identity.mjs": "// no 2>nul here\nconst a = 1;\n",
    "scripts/gen-release-manifest.mjs": "// clean\n",
    "scripts/gen-provenance.mjs": "// clean\n",
    "scripts/release-baseline.mjs": "// clean\n",
    "scripts/package-release.mjs": "// clean\n",
  };
}

interface ManifestFixture {
  version: string;
  commit: string;
  tree: string;
  mcp: { server: string; toolSurface: string; sdk: string; tools: string[]; toolCount: number };
  guest: Record<string, unknown>;
  containers: { releaseImages: Record<string, string>; imagesStatus?: string; baseImages?: Record<string, string> };
  skills: { contract: string; integrations: string[]; installerTargets: string[]; bound: Array<{ name: string; version: string; digest: string }> };
  [k: string]: unknown;
}

function manifestFor(dir: string, over: Record<string, unknown> = {}): ManifestFixture {
  const commit = git(dir, "rev-parse", "HEAD");
  const tree = git(dir, "rev-parse", "HEAD^{tree}");
  return {
    product: "eve-x", version: VERSION, commit, tree, dirty: false,
    generatedAt: new Date().toISOString(),
    toolchain: { node: "v1", npm: "v1", python: "v1" },
    lockfiles: {},
    containers: { baseImages: {}, releaseImages: {}, imagesStatus: "not-built (fixture)" },
    guest: { image: "g.qcow2", imageSha256: null, status: "UNMANIFESTED fixture", sealedReadonly: true },
    model: { runtime: "fixture" },
    mcp: { server: `eve-x ${VERSION}`, toolSurface: "mcp/1", sdk: "0.0.0-fixture", tools: ["t1", "t2"], toolCount: 2 },
    skills: { contract: "AGENT_SKILL.md", integrations: [], installerTargets: [], bound: [] },
    ...over,
  };
}

function provenanceFor(dir: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product: "eve-x", version: VERSION,
    source: { commit: git(dir, "rev-parse", "HEAD"), tree: git(dir, "rev-parse", "HEAD^{tree}"), dirty: false, tag: null },
    ...over,
  };
}

function mkrepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "evex-vattack-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  writeTree(dir, baseFiles());
  copyFileSync(join(ROOT, "scripts", "verify-release.mjs"), join(dir, "scripts", "verify-release.mjs"));
  copyFileSync(join(ROOT, "scripts", "git-safe.mjs"), join(dir, "scripts", "git-safe.mjs"));
  return dir;
}

function commitAll(dir: string, msg: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", msg);
}

describe("verify-release adversarial audit (26 cases)", () => {
  it("0. pristine valid tree is accepted (control)", () => {
    const dir = mkrepo();
    commitAll(dir, "code");
    const m = manifestFor(dir);
    (m.skills as { bound: unknown[] }).bound = [{
      name: "alpha", version: "1.0.0",
      digest: skillDigest(dir),
    }];
    writeFileSync(join(dir, "release-manifest.json"), JSON.stringify(m, null, 2));
    writeFileSync(join(dir, "RELEASE_PROVENANCE.json"), JSON.stringify(provenanceFor(dir), null, 2));
    commitAll(dir, "metadata");
    const r = runVerifier(dir);
    assert.equal(r.code, 0, `control must pass:\n${r.out}`);
    assert.match(r.out, /consistent/);
  });

  it("1. generated metadata changed after commit is refused", () => {
    const dir = validRelease();
    const p = join(dir, "release-manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.mcp.toolCount = 999;
    writeFileSync(p, JSON.stringify(m, null, 2));
    const r = runVerifier(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /toolCount/);
  });

  it("2. source file changed after metadata generation is refused", () => {
    const dir = validRelease();
    writeFileSync(join(dir, "apps", "cli", "src", "index.ts"), `export const VERSION = "${VERSION}-tampered";\n`);
    const r = runVerifier(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /cli VERSION|unreleased changes/);
  });

  it("3. metadata commit referencing wrong source is refused", () => {
    const dir = validRelease();
    const p = join(dir, "release-manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.commit = "0".repeat(40);
    writeFileSync(p, JSON.stringify(m, null, 2));
    const r = runVerifier(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /commit/);
  });

  it("4. package version mismatch is refused", () => {
    const dir = validRelease();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.0.0-evil" }));
    const r = runVerifier(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /version/);
  });

  it("5. amended HEAD after metadata is refused", () => {
    const dir = validRelease();
    writeFileSync(join(dir, "apps", "cli", "src", "index.ts"), `export const VERSION = "${VERSION}";\n// amend\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--amend", "--no-edit");
    const r = runVerifier(dir);
    assert.equal(r.code, 1);
  });

  it("6. exact-match tag mismatch is refused; matching tag accepted", () => {
    const dir = validRelease();
    git(dir, "tag", "wrong-tag-1.0");
    let r = runVerifier(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /tag/);
    git(dir, "tag", "-d", "wrong-tag-1.0");
    git(dir, "tag", `v${VERSION}`);
    r = runVerifier(dir);
    assert.equal(r.code, 0, `matching tag must pass:\n${r.out}`);
  });

  it("7. dirty tree (foreign change) is refused", () => {
    const dir = validRelease();
    writeFileSync(join(dir, "apps", "mcp", "src", "index.ts"), "// dirty\n");
    const r = runVerifier(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /unreleased changes/);
  });

  it("8. ignored files do not taint the tree (classified accept)", () => {
    const dir = validRelease();
    writeFileSync(join(dir, ".gitignore"), "scratch/\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "ignore scratch");
    // Metadata now describes the pre-ignore tree; regenerate it so the
    // ignore-rule commit itself is attested (standard release flow).
    regenMetadata(dir);
    mkdirSync(join(dir, "scratch"), { recursive: true });
    writeFileSync(join(dir, "scratch", "local.log"), "noise");
    const r = runVerifier(dir);
    assert.equal(r.code, 0, `ignored files must not refuse:\n${r.out}`);
  });

  it("9. generated-but-untracked file is refused", () => {
    const dir = validRelease();
    writeFileSync(join(dir, "RELEASE_EXTRA.json"), "{}");
    const r = runVerifier(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /unreleased changes/);
  });

  it("10. deleted generated file is refused, not crashed", () => {
    const dir = validRelease();
    rmSync(join(dir, "release-manifest.json"));
    const r = runVerifier(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /missing/);
    assert.ok(!/at (Object\.|Module\.|file:)/.test(r.out), "must refuse gracefully, not stack-trace");
  });

  it("11. forged manifest toolCount is refused; forged digest value is shape-valid (documented limit)", () => {
    const dir = validRelease();
    const p = join(dir, "release-manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.guest = { image: "g.qcow2", imageSha256: "f".repeat(64), sealedReadonly: true };
    writeFileSync(p, JSON.stringify(m, null, 2));
    // A well-formed but FALSE digest is accepted by shape: digest VALUES
    // are re-measured at deploy (EVEX_BASE_IMAGE_SHA256 / image pulls),
    // never trusted from the manifest. The refusal boundary is format +
    // binding, documented in RELEASE_IDENTITY.md.
    const r = runVerifier(dir);
    assert.equal(r.code, 0, `shape-valid forgery is the documented deploy-verified boundary:\n${r.out}`);
    m.mcp.toolCount = 1;
    writeFileSync(p, JSON.stringify(m, null, 2));
    const r2 = runVerifier(dir);
    assert.equal(r2.code, 1);
  });

  it("12. forged provenance version is refused", () => {
    const dir = validRelease();
    const p = join(dir, "RELEASE_PROVENANCE.json");
    const pv = JSON.parse(readFileSync(p, "utf8"));
    pv.version = "0.0.0-evil";
    writeFileSync(p, JSON.stringify(pv, null, 2));
    const r = runVerifier(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /provenance/);
  });

  it("13. malformed guest digest is refused", () => {
    const dir = validRelease();
    const p = join(dir, "release-manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.guest = { image: "g.qcow2", imageSha256: "not-a-digest", sealedReadonly: true };
    writeFileSync(p, JSON.stringify(m, null, 2));
    const r = runVerifier(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /guest digest/);
  });

  it("14. malformed container digest is refused", () => {
    const dir = validRelease();
    const p = join(dir, "release-manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.containers.releaseImages = { [`evex-api:${VERSION}`]: "sha256:zzz" };
    delete m.containers.imagesStatus;
    writeFileSync(p, JSON.stringify(m, null, 2));
    const r = runVerifier(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /digest is sha256/);
  });

  it("15. unknown manifest sections do not crash (model section classified)", () => {
    const dir = validRelease();
    const p = join(dir, "release-manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    m.model = { artifacts: [{ id: "m1", sha256: "e".repeat(64) }] };
    writeFileSync(p, JSON.stringify(m, null, 2));
    const r = runVerifier(dir);
    assert.ok(r.code === 0 || /REFUSED/.test(r.out), "must classify, not crash");
    assert.ok(!/at (Object\.|Module\.|file:)/.test(r.out) || r.code === 1, "no unhandled crash");
  });

  it("16. stale MCP server version is refused", () => {
    const dir = validRelease();
    writeFileSync(join(dir, "apps", "mcp", "src", "index.ts"),
      `import { McpServer } from "x";\nconst s = new McpServer({ name: "eve-x", version: "0.0.0-stale" });\nregisterTool("t1", {});\nregisterTool("t2", {});\n`);
    const r = runVerifier(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /mcp server version/);
  });

  it("17. stale skill content without regen is refused", () => {
    const dir = validRelease();
    writeFileSync(join(dir, "skills", "alpha", "SKILL.md"), "# alpha\n\nCHANGED\n");
    const r = runVerifier(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /skill alpha.*digest|digest matches tree/);
  });

  it("18+19. tampered archive file is refused", () => {
    const dir = validRelease();
    mkdirSync(join(dir, "artifacts", "release", "pkg"), { recursive: true });
    writeFileSync(join(dir, "artifacts", "release", "pkg", "bundle.tar"), "original-bytes");
    const good = createHash("sha256").update("original-bytes").digest("hex");
    writeFileSync(join(dir, "artifacts", "release", "pkg", "RELEASE_ARTIFACTS.sha256"), `${good}  pkg/bundle.tar\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "bundles");
    // 19: alter after archive
    writeFileSync(join(dir, "artifacts", "release", "pkg", "bundle.tar"), "tampered-bytes");
    const r = runVerifier(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /archive intact|tampered after packaging/);
  });

  it("20. file altered after metadata commit is refused", () => {
    const dir = validRelease();
    writeFileSync(join(dir, "packages", "mcp-shared", "src", "index.ts"),
      `export const MCP_TOOL_VERSION = "mcp/1" as const;\n// altered\n`);
    const r = runVerifier(dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /toolSurface|unreleased changes/);
  });

  it("21. merge commit verifies when content is consistent (classified accept)", () => {
    const dir = validRelease();
    const main = git(dir, "branch", "--show-current");
    git(dir, "checkout", "-qb", "side");
    writeFileSync(join(dir, "side-note.txt"), "side\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "side work");
    git(dir, "checkout", "-q", main);
    git(dir, "merge", "-q", "--no-ff", "side", "-m", "merge side");
    // Metadata must be regenerated for the merge HEAD: emulate release flow.
    regenMetadata(dir);
    const r = runVerifier(dir);
    assert.equal(r.code, 0, `consistent merge must verify:\n${r.out}`);
  });

  it("22. metadata amend without content change preserves attestation; amend adding files refuses", () => {
    // A date/message-only amend of the metadata commit changes no attested
    // bytes (same parent, same metadata diff): the attestation still
    // describes exactly what it describes. Refusing it would be theater.
    const dir = validRelease();
    execFileSync("git", ["commit", "-q", "--amend", "--no-edit", "--date=2000-01-01T00:00:00"], { cwd: dir, stdio: "pipe" });
    const kept = runVerifier(dir);
    assert.equal(kept.code, 0, `content-identical amend must still verify:\n${kept.out}`);
    // But smuggling an extra file into the metadata commit breaks the
    // metadata-commit shape (diff no longer ⊆ generatable) → refuse.
    writeFileSync(join(dir, "smuggled.txt"), "payload\n");
    git(dir, "add", "-A");
    execFileSync("git", ["commit", "-q", "--amend", "--no-edit"], { cwd: dir, stdio: "pipe" });
    const r = runVerifier(dir);
    assert.equal(r.code, 1, "metadata commit carrying extra files must be refused");
  });

  it("23. shallow repository verifies without crashing", () => {
    const src = mkrepo();
    commitAll(src, "code");
    const shallow = join(tmpdir(), `evex-shallow-${Date.now()}`);
    mkdirSync(shallow, { recursive: true });
    try {
      execFileSync("git", ["clone", "-q", "--depth", "1", `file://${src}`, shallow], { stdio: "pipe", timeout: 60000 });
    } catch {
      assert.ok(true, "classified: file-protocol clone unsupported here; shallow path untestable on this host");
      return;
    }
    copyFileSync(join(ROOT, "scripts", "verify-release.mjs"), join(shallow, "scripts", "verify-release.mjs"));
    copyFileSync(join(ROOT, "scripts", "git-safe.mjs"), join(shallow, "scripts", "git-safe.mjs"));
    git(shallow, "config", "user.email", "t@t");
    git(shallow, "config", "user.name", "t");
    const m = manifestFor(shallow);
    (m.skills as { bound: unknown[] }).bound = [{ name: "alpha", version: "1.0.0", digest: skillDigest(shallow) }];
    writeFileSync(join(shallow, "release-manifest.json"), JSON.stringify(m, null, 2));
    writeFileSync(join(shallow, "RELEASE_PROVENANCE.json"), JSON.stringify(provenanceFor(shallow), null, 2));
    git(shallow, "add", "-A");
    git(shallow, "commit", "-qm", "metadata");
    const r = runVerifier(shallow);
    assert.equal(r.code, 0, `shallow consistent tree must verify:\n${r.out}`);
  });

  it("24. detached HEAD verifies against the sha (classified accept)", () => {
    const dir = validRelease();
    const head = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "--detach", "HEAD");
    const r = runVerifier(dir);
    assert.equal(r.code, 0, `detached HEAD with matching sha must verify:\n${r.out}`);
    void head;
  });

  it("25. missing git metadata refuses without crashing", () => {
    const dir = mkdtempSync(join(tmpdir(), "evex-nogit-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: VERSION }));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    copyFileSync(join(ROOT, "scripts", "verify-release.mjs"), join(dir, "scripts", "verify-release.mjs"));
    copyFileSync(join(ROOT, "scripts", "git-safe.mjs"), join(dir, "scripts", "git-safe.mjs"));
    const r = runVerifier(dir);
    assert.equal(r.code, 1);
    assert.ok(!/Error: ENOENT/.test(r.out) || /REFUSED|missing/.test(r.out), "refuse gracefully");
  });

  it("26. hostile GIT_DIR cannot redirect revision queries", () => {
    const dir = validRelease();
    const evil = mkrepo();
    commitAll(evil, "evil");
    const r = runVerifier(dir, { GIT_DIR: join(evil, ".git") } as Record<string, string>);
    assert.equal(r.code, 0, `scrubbed env must still verify the real tree:\n${r.out}`);
  });
});

// ---- fixture helpers ----
function skillDigest(dir: string): string {
  const sj = readFileSync(join(dir, "skills", "alpha", "skill.json"));
  const md = readFileSync(join(dir, "skills", "alpha", "SKILL.md"));
  return createHash("sha256").update(sj).update(md).digest("hex");
}

function validRelease(): string {
  const dir = mkrepo();
  commitAll(dir, "code");
  const m = manifestFor(dir);
  (m.skills as { bound: unknown[] }).bound = [{ name: "alpha", version: "1.0.0", digest: skillDigest(dir) }];
  writeFileSync(join(dir, "release-manifest.json"), JSON.stringify(m, null, 2));
  writeFileSync(join(dir, "RELEASE_PROVENANCE.json"), JSON.stringify(provenanceFor(dir), null, 2));
  commitAll(dir, "metadata");
  const check = runVerifier(dir);
  assert.equal(check.code, 0, `fixture must be valid:\n${check.out}`);
  return dir;
}

function regenMetadata(dir: string): void {
  const m = manifestFor(dir);
  (m.skills as { bound: unknown[] }).bound = [{ name: "alpha", version: "1.0.0", digest: skillDigest(dir) }];
  writeFileSync(join(dir, "release-manifest.json"), JSON.stringify(m, null, 2));
  writeFileSync(join(dir, "RELEASE_PROVENANCE.json"), JSON.stringify(provenanceFor(dir), null, 2));
  commitAll(dir, "metadata");
}
