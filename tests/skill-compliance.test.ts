import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readManifest,
  parseFrontmatter,
  discoveryCheck,
  smokeTestSkill,
  verifySkill,
  installSkill,
} from "../packages/skills/src/index.js";

// Agent-Skills compliance: canonical skills carry valid frontmatter,
// manifest names match directories, tools are documented, and install +
// verify round-trip. Negatives prove the validator rejects non-compliant
// skills instead of silently accepting them.

// Tests execute from dist/tests: the repo root is two levels up.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL_DIR = join(ROOT, "skills", "eve-computer");
let HOME = "";
before(() => {
  HOME = mkdtempSync(join(tmpdir(), "evex-skill-"));
});

function makeSkill(name: string, files: Record<string, string>): string {
  const dir = join(HOME, "src", name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content, "utf8");
  }
  return dir;
}

const GOOD_MANIFEST = (name: string) => JSON.stringify({
  name, version: "1.0.0", description: "A compliant test skill for validation",
  entrypoint: "SKILL.md", tools: ["widget.frobnicate"], permissions: [], mcpVersion: "mcp/1",
});
const GOOD_BODY = (name: string) => `---\nname: ${name}\ndescription: A compliant test skill for validation\n---\n\n# Title\n\nUse widget.frobnicate to frob the widget. ${"x".repeat(80)}\n`;

describe("canonical eve-computer skill", () => {
  it("manifest name matches its directory and parses", () => {
    const m = readManifest(SKILL_DIR);
    assert.equal(m.name, "eve-computer");
    assert.ok(m.description.length >= 10);
    assert.ok(m.tools.length > 0);
  });

  it("entrypoint opens with valid name/description frontmatter", () => {
    const body = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
    const { frontmatter, rest } = parseFrontmatter(body);
    assert.equal(frontmatter.name, "eve-computer");
    assert.ok(String(frontmatter.description).length >= 10);
    assert.ok(rest.includes("## Loop"));
  });

  it("teaches the full honest loop (observe/ground/act/re-observe/verify/stop)", () => {
    const body = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8").toLowerCase();
    for (const token of ["re-observe", "verify", "stale_perception", "frameid", "stop conditions", "eve_human_request"]) {
      assert.ok(body.includes(token), `SKILL.md must teach ${token}`);
    }
  });

  it("references resolve to files (progressive disclosure, no dead links)", () => {
    const body = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
    const refs = [...body.matchAll(/`references\/([a-z-]+\.md)`/g)].map((m) => m[1]);
    assert.ok(refs.length > 0);
    for (const r of refs) {
      try {
        readFileSync(join(SKILL_DIR, "references", r), "utf8");
      } catch {
        assert.fail(`dead reference: references/${r}`);
      }
    }
  });

  it("passes discovery + smoke on its own directory", () => {
    const disc = discoveryCheck(SKILL_DIR);
    assert.deepEqual(disc.problems, [], `discovery problems: ${disc.problems.join("; ")}`);
    assert.equal(disc.visible, true);
    const smoke = smokeTestSkill(SKILL_DIR);
    assert.equal(smoke.passed, true, smoke.details.join("; "));
  });

  it("install + verify round-trips into a platform path", () => {
    const res = installSkill(SKILL_DIR, "opencode", { homeDir: HOME, overwrite: true });
    assert.equal(res.skillName, "eve-computer");
    assert.ok(res.filesCopied >= 3, `expected skill tree copied, got ${res.filesCopied}`);
    const v = verifySkill(res.installedPath);
    assert.equal(v.manifestValid, true);
    assert.equal(v.discoveryVisible, true);
    assert.equal(v.smokePassed, true, v.details.join("; "));
  });
});

describe("validator rejects non-compliant skills", () => {
  it("missing frontmatter is a discovery problem", () => {
    const dir = makeSkill("no-front", {
      "skill.json": GOOD_MANIFEST("no-front"),
      "SKILL.md": `# No frontmatter here\n\nUse widget.frobnicate. ${"x".repeat(80)}\n`,
    });
    const disc = discoveryCheck(dir);
    assert.equal(disc.visible, false);
    assert.ok(disc.problems.some((p) => p.includes("frontmatter")), disc.problems.join("; "));
  });

  it("manifest name that mismatches the directory is flagged", () => {
    const dir = makeSkill("real-dir", {
      "skill.json": GOOD_MANIFEST("other-name"),
      "SKILL.md": GOOD_BODY("other-name"),
    });
    const disc = discoveryCheck(dir);
    assert.equal(disc.visible, false);
    assert.ok(disc.problems.some((p) => p.includes("does not match directory")), disc.problems.join("; "));
  });

  it("frontmatter that disagrees with the manifest is flagged", () => {
    const dir = makeSkill("split-brain", {
      "skill.json": GOOD_MANIFEST("split-brain"),
      "SKILL.md": GOOD_BODY("different-name"),
    });
    const disc = discoveryCheck(dir);
    assert.equal(disc.visible, false);
    assert.ok(disc.problems.some((p) => p.includes("disagrees")), disc.problems.join("; "));
  });

  it("undocumented manifest tools fail the smoke test", () => {
    const dir = makeSkill("undoc-tools", {
      "skill.json": JSON.stringify({
        name: "undoc-tools", version: "1.0.0", description: "Tools nobody documented here",
        entrypoint: "SKILL.md", tools: ["widget.nevermentioned"], permissions: [], mcpVersion: "mcp/1",
      }),
      "SKILL.md": GOOD_BODY("undoc-tools"),
    });
    const smoke = smokeTestSkill(dir);
    assert.equal(smoke.passed, false);
    assert.ok(smoke.details.some((d) => d.includes("undocumented")), smoke.details.join("; "));
  });

  it("bad skill names are rejected by the manifest schema", () => {
    const dir = makeSkill("Bad_Name", {
      "skill.json": GOOD_MANIFEST("Bad_Name"),
      "SKILL.md": GOOD_BODY("Bad_Name"),
    });
    assert.throws(() => readManifest(dir), /skill name must be/);
  });
});
