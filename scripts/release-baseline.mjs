#!/usr/bin/env node
// Release baseline capture: immutable starting-state report.
// Writes artifacts/release/baseline.json (gitignored local evidence).
// Portable: derives ROOT from the script location (no hardcoded paths),
// version from package.json (no hardcoded releases).
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv } from "./git-safe.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sh = (cmd) => {
  try { return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnv() }).trim(); }
  catch { return ""; }
};
const sha = (p) => createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex");

const baseline = {
  product: "eve-x",
  release: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
  capturedAt: new Date().toISOString(),
  git: {
    head: sh("git rev-parse HEAD"),
    headShort: sh("git rev-parse --short HEAD"),
    logOne: sh("git log -1 --oneline"),
    status: sh("git status --short"),
    treeClean: sh("git status --porcelain").length === 0,
    trackedFiles: sh("git ls-files").split("\n").filter(Boolean).length,
  },
  toolchain: {
    node: sh("node --version"),
    npm: sh("npm --version"),
    python: sh("python --version") || sh("python3 --version"),
    os: process.platform,
  },
  lockfiles: {
    "package-lock.json": sha("package-lock.json"),
    "package.json": sha("package.json"),
  },
};
mkdirSync(join(ROOT, "artifacts", "release"), { recursive: true });
writeFileSync(join(ROOT, "artifacts", "release", "baseline.json"), JSON.stringify(baseline, null, 2));
console.log(JSON.stringify({ head: baseline.git.head, treeClean: baseline.git.treeClean, trackedFiles: baseline.git.trackedFiles }));
