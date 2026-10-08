#!/usr/bin/env node
// Single definition of which repo-relative paths are regenerable release
// outputs. Matching is EXACT normalized equality — never suffix matching.
// A nested path like attacker/release-manifest.json ends with the
// generatable basename but is NOT the release manifest: suffix matching
// would launder a foreign file into a "clean tree" verdict (P1).
export const GENERATABLE = new Set(["release-manifest.json", "RELEASE_PROVENANCE.json"]);

/** Extract the repo-relative path a porcelain line refers to. Handles the
 *  XY status prefix, rename/copy arrows (the new side is what the tree
 *  contains), git quoting of special-char paths, and separators. */
export function porcelainPath(line) {
  let p = String(line).replace(/^([AMDRCU?!]{1,2})\s+/, "");
  const arrow = p.indexOf(" -> ");
  if (arrow !== -1) p = p.slice(arrow + 4);
  p = p.trim();
  if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) {
    p = p.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return p.replace(/\\/g, "/");
}

/** True only for a porcelain line touching a root-level generatable file. */
export function isGeneratablePorcelainLine(line) {
  return GENERATABLE.has(porcelainPath(line));
}
