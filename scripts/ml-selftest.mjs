#!/usr/bin/env node
// ML inference self-test runner: executes ml/inference/selftest.py (stdlib
// only, stub-torch load paths + live HTTP checks) with the first available
// interpreter (python3, then python). Fails closed when an interpreter
// exists but the suite fails; reports UNAVAILABLE (exit 2) when no Python
// exists at all so CI/result tables classify the gap instead of hiding it.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(ROOT, "ml", "inference", "selftest.py");
if (!existsSync(target)) {
  console.error(`ml-selftest: missing ${target}`);
  process.exit(1);
}
const candidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
let last = null;
for (const bin of candidates) {
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    last = probe.error ?? new Error(`${bin} --version -> ${probe.status}`);
    continue;
  }
  const r = spawnSync(bin, [target], { cwd: ROOT, stdio: "inherit" });
  process.exit(r.status ?? 1);
}
console.error(`ml-selftest: UNAVAILABLE — no Python interpreter (${String(last)})`);
process.exit(2);
