import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// CLI/VM hygiene gates: crypto randomness in security-adjacent paths, and
// doctor --production failing closed on missing credentials. (Port/image
// checks are covered by the CLI's own check table.)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("crypto hygiene in vm crypto-adjacent paths", () => {
  it("packages/vm uses crypto randomness, not Math.random", () => {
    const src = readFileSync(join(ROOT, "packages", "vm", "src", "index.ts"), "utf8");
    assert.ok(!/Math\.random\s*\(/.test(src), "Math.random must not appear in packages/vm");
    assert.ok(src.includes("randomInt"), "expected node:crypto randomInt usage");
  });
});

describe("doctor --production fails closed", () => {
  it("exits nonzero without credentials", () => {
    const cli = join(ROOT, "dist", "apps", "cli", "src", "index.js");
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== "EVEX_AUTH_TOKEN" && k !== "EVEX_EXPECT_COMMIT") cleanEnv[k] = v;
    }
    let code = 0;
    try {
      execFileSync(process.execPath, [cli, "doctor", "--production"], { stdio: "pipe", env: cleanEnv, timeout: 60000 });
    } catch (err) {
      code = (err as { status?: number }).status ?? 1;
    }
    assert.notEqual(code, 0, "doctor --production without credentials must fail");
  });
});
