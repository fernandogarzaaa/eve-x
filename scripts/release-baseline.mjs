#!/usr/bin/env node
// Release baseline capture (§1): immutable starting-state report.
// Writes artifacts/release/baseline.json (gitignored local evidence).
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "E:\\eve-x";
const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();
const sha = (p) => createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex");

const baseline = {
  product: "eve-x",
  release: "1.0.0",
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
    python: sh("python --version"),
    os: "Windows 11 Pro (build host) + WSL2 Ubuntu 24.04 (KVM host)",
  },
  lockfiles: {
    "package-lock.json": sha("package-lock.json"),
    "package.json": sha("package.json"),
  },
};
mkdirSync(join(ROOT, "artifacts", "release"), { recursive: true });
writeFileSync(join(ROOT, "artifacts", "release", "baseline.json"), JSON.stringify(baseline, null, 2));
console.log(JSON.stringify({ head: baseline.git.head, treeClean: baseline.git.treeClean, trackedFiles: baseline.git.trackedFiles }));
