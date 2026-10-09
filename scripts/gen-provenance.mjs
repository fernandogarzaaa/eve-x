#!/usr/bin/env node
// Generates RELEASE_PROVENANCE.json (§47): what exactly produced this release.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv } from "./git-safe.mjs";
import { isGeneratablePorcelainLine } from "./release-paths.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sh = (cmd) => {
  try { return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnv() }).trim(); }
  catch { return ""; }
};
const shaFile = (p) => createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex");
const shaOpt = (p) => (existsSync(join(ROOT, p)) ? shaFile(p) : null);
// Release outputs are not source (same GENERATABLE set as the manifest,
// matched by exact repo-relative path — never suffix).
const sourceDirty = sh("git status --porcelain").split("\n").map((l) => l.trim()).filter(Boolean)
  .some((l) => !isGeneratablePorcelainLine(l));

const prov = {
  product: "eve-x",
  version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
  source: {
    commit: sh("git rev-parse HEAD"),
    tree: sh('git rev-parse "HEAD^{tree}"'),
    dirty: sourceDirty,
    tag: sh("git describe --tags --exact-match") || null,
  },
  generatedAt: new Date().toISOString(),
  dependencies: {
    "package-lock.json": shaOpt("package-lock.json"),
    node: sh("node --version"),
    npm: sh("npm --version"),
    python: sh("python --version"),
  },
  build: {
    scripts: ["gen-release-identity.mjs", "clean.mjs", "copy-static.mjs", "repro-build.mjs"],
    reproducibility: "bit-identical dist across clean builds except release.gen.* (buildTime stamp)",
  },
  containers: {
    baseDigests: JSON.parse(readFileSync(join(ROOT, "release-manifest.json"), "utf8")).containers.baseImages,
  },
  guest: JSON.parse(readFileSync(join(ROOT, "release-manifest.json"), "utf8")).guest,
  qualification: {
    // Measured 2026-10-08 on the 1.1.1 freeze (Windows + WSL2 Ubuntu host):
    // npm test 382/382 across 83 suites; lint + honesty-gates ok;
    // ml-selftest all suites passed; security-audit ok; npm audit 0 vulns.
    // The KVM/object/backup lines below are CARRIED HISTORY from the 1.0.0
    // qualification campaign, NOT re-measured for 1.1.1: live KVM/QEMU
    // re-qualification and GPU/model qualification remain open evidence
    // boundaries and are not claimed here.
    scope: "freshly measured where labeled 2026-10-08; KVM/object/backup lines are 1.0.0 campaign history, not 1.1.1 re-measurement",
    unitTests: "382/382 node:test (83 suites) — measured 2026-10-08 via `npm test`",
    canonicalE2E: "28/28 graphical KVM (carried from 1.0.0 record; not re-measured for 1.1.1)",
    postCanonical: "11/11 genesis/eval/promotion (carried from 1.0.0 record; not re-measured for 1.1.1)",
    concurrency: "5/5 dual-desktop + trace isolation (carried from 1.0.0 record; not re-measured for 1.1.1)",
    escapeProbes: "clean (carried from 1.0.0 record; not re-measured for 1.1.1)",
    objectQual: "9/9 Garage S3 (carried from 1.0.0 record; not re-measured for 1.1.1)",
    modelRollback: "A→production, B→production, retire B, A sole production (carried from 1.0.0 record; not re-measured for 1.1.1)",
    backupRestore: "Garage byte-identical; DATA_DIR 32→0→32 (carried from 1.0.0 record; not re-measured for 1.1.1)",
    securityAudit: "0 findings — measured 2026-10-08 via `npm run security:audit`",
    npmAudit: "0 vulnerabilities — measured 2026-10-08 via `npm audit --omit=dev`",
  },
  evidence: {
    "artifacts/release/baseline.json": shaOpt("artifacts/release/baseline.json"),
    "artifacts/release/garage-backup-restore.json": shaOpt("artifacts/release/garage-backup-restore.json"),
    "artifacts/release/artifact-integrity.json": shaOpt("artifacts/release/artifact-integrity.json"),
    "release-manifest.json": shaOpt("release-manifest.json"),
    "PRODUCTION_QUALIFICATION.md": shaOpt("PRODUCTION_QUALIFICATION.md"),
  },
};
writeFileSync(join(ROOT, "RELEASE_PROVENANCE.json"), JSON.stringify(prov, null, 2) + "\n");
console.log(`provenance: commit=${prov.source.commit.slice(0, 12)} dirty=${prov.source.dirty}`);
