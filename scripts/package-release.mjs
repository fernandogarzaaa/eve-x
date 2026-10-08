#!/usr/bin/env node
// Assembles versioned release bundles (§38) into artifacts/release/pkg/:
// source archive, skill package, deployment bundle, docs bundle.
// Container + VM images are built separately (digests in release-manifest).
// Writes RELEASE_ARTIFACTS.sha256 over every bundle.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "artifacts", "release", "pkg");
mkdirSync(PKG, { recursive: true });
// Stale bundles from previous regens are forgery-adjacent clutter (old
// commit tags, superseded digests): clear the dir so the sha file describes
// exactly what this run produced — nothing carried forward.
for (const e of readdirSync(PKG)) {
  const full = join(PKG, e);
  try {
    const st = statSync(full);
    if (st.isFile()) rmSync(full);
  } catch { /* best effort */ }
}
const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const commit = sh("git rev-parse HEAD").slice(0, 12);

const bundles = [];
const add = (name, make) => {
  const p = join(PKG, `${name}-${version}-${commit}.tar`);
  make(p);
  bundles.push(p);
  console.log(`package: ${name} ${(statSync(p).size / 1024).toFixed(0)} KiB`);
};
const tar = (out, paths) => execSync(`tar -cf "${out}" ${paths.join(" ")}`, { cwd: ROOT, stdio: "ignore" });

add("eve-x-source", (p) => execSync(`git archive --format=tar --prefix=eve-x-${version}/ HEAD > "${p}"`, { cwd: ROOT, stdio: "ignore" }));
add("eve-x-skill", (p) => tar(p, ["skills/eve-computer", "AGENT_SKILL.md"]));
add("eve-x-deploy", (p) => tar(p, ["infra/deployment/docker-compose.yml", "infra/docker", "infra/deployment/object-storage/bring-up.sh", "infra/deployment/object-storage/garage.toml.template", "infra/deployment/tls", "infra/deployment/linux-bootstrap.sh", ".env.example"]));
add("eve-x-docs", (p) => tar(p, ["README.md", "CHANGELOG.md", "ARCHITECTURE.md", "DEPLOYMENT.md", "OPERATIONS.md", "SECURITY.md", "THREAT_MODEL.md", "API.md", "CLI.md", "MCP.md", "MODEL.md", "COMPUTER_USE.md", "HUMAN_VALIDATION.md", "BENCHMARKS.md", "DATASETS.md", "TRAINING.md", "OBSERVABILITY.md", "TROUBLESHOOTING.md", "CONTRIBUTING.md", "AGENT_SKILL.md", "PRODUCTION_QUALIFICATION.md", "RELEASE_IDENTITY.md", "release-manifest.json", "RELEASE_PROVENANCE.json", "docs"]));

const lines = [];
for (const p of [...bundles, join(ROOT, "release-manifest.json"), join(ROOT, "RELEASE_PROVENANCE.json")]) {
  if (!existsSync(p)) continue;
  lines.push(`${createHash("sha256").update(readFileSync(p)).digest("hex")}  ${p.split(/[\\/]/).slice(-2).join("/")}`);
}
writeFileSync(join(PKG, "RELEASE_ARTIFACTS.sha256"), lines.join("\n") + "\n");
console.log(`package: ${bundles.length} bundles + RELEASE_ARTIFACTS.sha256`);
