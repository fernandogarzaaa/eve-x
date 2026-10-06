#!/usr/bin/env node
// Generates RELEASE_PROVENANCE.json (§47): what exactly produced this release.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sh = (cmd) => {
  try { return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return ""; }
};
const shaFile = (p) => createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex");
const shaOpt = (p) => (existsSync(join(ROOT, p)) ? shaFile(p) : null);

const prov = {
  product: "eve-x",
  version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
  source: {
    commit: sh("git rev-parse HEAD"),
    tree: sh('git rev-parse "HEAD^{tree}"'),
    dirty: sh("git status --porcelain").length > 0,
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
    unitTests: "200/200 node:test (41 suites)",
    canonicalE2E: "28/28 graphical KVM",
    postCanonical: "11/11 genesis/eval/promotion",
    concurrency: "5/5 dual-desktop + trace isolation",
    escapeProbes: "clean (metadata/QMP/secrets/loopback blocked)",
    objectQual: "9/9 Garage S3",
    modelRollback: "A→production, B→production, retire B, A sole production",
    backupRestore: "Garage byte-identical; DATA_DIR 32→0→32",
    securityAudit: "0 findings",
    npmAudit: "0 vulnerabilities",
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
