#!/usr/bin/env node
// §46: build twice from clean, compare dist digests (excluding the
// build-stamped release.gen.js, whose buildTime differs by design).
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "E:\\eve-x";
const run = (cmd) => execSync(cmd, { cwd: ROOT, stdio: "ignore" });
const tree = (dir, base = "") => {
  const out = [];
  for (const e of readdirSync(join(dir, base))) {
    const rel = join(base, e);
    const st = statSync(join(dir, rel));
    if (st.isDirectory()) out.push(...tree(dir, rel));
    // release.gen.* carries buildTime/sourceDigest: measured build facts,
    // excluded from bit-reproducibility by design (proven: the ONLY differ).
    else if (!rel.includes("release.gen.")) out.push(rel);
  }
  return out.sort();
};
const digest = () => {
  const h = createHash("sha256");
  for (const f of tree(join(ROOT, "dist"))) h.update(f + ":" + createHash("sha256").update(readFileSync(join(ROOT, "dist", f))).digest("hex") + "\n");
  return h.digest("hex");
};
run("npm run clean");
run("npm run build");
const a = digest();
run("npm run clean");
run("npm run build");
const b = digest();
console.log("build-1:", a.slice(0, 16));
console.log("build-2:", b.slice(0, 16));
console.log(a === b ? "REPRODUCIBLE (excluding build-stamped identity)" : "MISMATCH");
if (a !== b) process.exit(1);
