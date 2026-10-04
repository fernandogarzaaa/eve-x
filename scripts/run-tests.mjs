#!/usr/bin/env node
// Deterministic test entry: expands dist/tests/*.test.js in-process and
// spawns `node --test` with an explicit file list. Shell glob expansion
// differs across sh/cmd/pwsh (an unexpanded pattern once failed CI with
// "Could not find dist/tests/*.test.js"), so the pattern never reaches
// a shell or the test runner unresolved.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(ROOT, "dist", "tests");
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`run-tests: missing ${dir} — run a build that compiles tests (npm run build && npm test via pretest) first`);
  process.exit(2);
}
const files = readdirSync(dir).filter((f) => f.endsWith(".test.js")).map((f) => join(dir, f)).sort();
if (files.length === 0) {
  console.error(`run-tests: no *.test.js in ${dir} — stale or test-excluding build`);
  process.exit(2);
}
console.log(`run-tests: ${files.length} suites`);
const r = spawnSync(process.execPath, ["--test", ...files], { cwd: ROOT, stdio: "inherit" });
process.exit(r.status ?? 1);
