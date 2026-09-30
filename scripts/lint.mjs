#!/usr/bin/env node
// Lint: forbid TODO/FIXME/NotImplemented/placeholder in prod paths, ban `any`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] ?? ".";
const PROD_DIRS = ["packages", "apps"];
const FORBIDDEN = [/TODO/i, /FIXME/i, /NotImplemented/i, /Not implemented/i, /placeholder/i];
const ANY_RE = /:\s*any\b|<any>|as\s+any\b/;

let errors = 0;

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    let st = null;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(e)) out.push(p);
  }
  return out;
}

for (const d of PROD_DIRS) {
  for (const f of walk(join(ROOT, d))) {
    let text = "";
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      for (const re of FORBIDDEN) {
        if (re.test(line)) {
          console.error(`FAIL ${f}:${i + 1}: forbidden pattern ${re} :: ${line.trim().slice(0, 120)}`);
          errors += 1;
        }
      }
      const stripped = line.replace(/\/\/.*$/, "");
      if (ANY_RE.test(stripped)) {
        console.error(`FAIL ${f}:${i + 1}: banned 'any' type :: ${line.trim().slice(0, 120)}`);
        errors += 1;
      }
    });
  }
}

if (errors > 0) {
  console.error(`lint: ${errors} violation(s)`);
  process.exit(1);
}
console.log("lint: ok");
