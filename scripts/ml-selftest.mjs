#!/usr/bin/env node
// ML self-test runner: executes every ml/*_selftest.py suite (stdlib only;
// torch paths via stub injection, live HTTP checks against ephemeral
// servers) with the first available interpreter (python3, then python).
// Fails closed when an interpreter exists but a suite fails; reports
// UNAVAILABLE (exit 2) when no Python exists at all so CI/result tables
// classify the gap instead of hiding it.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  join(ROOT, "ml", "inference", "selftest.py"),
  join(ROOT, "ml", "evaluation", "eval_selftest.py"),
  join(ROOT, "ml", "datasets", "build_selftest.py"),
];
for (const target of targets) {
  if (!existsSync(target)) {
    console.error(`ml-selftest: missing ${target}`);
    process.exit(1);
  }
}
const candidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
let last = null;
for (const bin of candidates) {
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    last = probe.error ?? new Error(`${bin} --version -> ${probe.status}`);
    continue;
  }
  let failed = 0;
  for (const target of targets) {
    console.log(`ml-selftest: ${target}`);
    const r = spawnSync(bin, [target], { cwd: ROOT, stdio: "inherit" });
    if ((r.status ?? 1) !== 0) failed += 1;
  }
  if (failed > 0) {
    console.error(`ml-selftest: ${failed} suite(s) FAILED`);
    process.exit(1);
  }
  console.log("ml-selftest: all suites passed");
  process.exit(0);
}
console.error(`ml-selftest: UNAVAILABLE — no Python interpreter (${String(last)})`);
process.exit(2);
