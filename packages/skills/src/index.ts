import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { z } from "zod";

// ── Agent-skill installer / verifier ──
// Installs a skill directory (SKILL.md + assets) onto the well-known paths of
// supported agent platforms, then verifies discovery and runs an invocation
// smoke test. See AGENT_SKILL.md for the on-disk contract.

// Platforms we know how to target. Each entry is the directory (under the
// user's home) that the platform scans for third-party skills.
const PLATFORM_DIRS = {
  "claude-code": ".claude/skills",
  codex: ".codex/skills",
  opencode: ".config/opencode/skills",
  cursor: ".cursor/skills",
  windsurf: ".windsurf/skills",
} as const;

export type SkillPlatform = keyof typeof PLATFORM_DIRS;
export const SKILL_PLATFORMS = Object.keys(PLATFORM_DIRS) as SkillPlatform[];

export const SkillManifest = z.object({
  name: z.string().min(1).max(128).regex(/^[a-z0-9-]+$/, "skill name must be lowercase alphanumeric + hyphens (and match its directory)"),
  version: z.string().min(1).max(64),
  description: z.string().min(1).max(2048),
  entrypoint: z.string().min(1).max(256).default("SKILL.md"),
  tools: z.array(z.string().min(1).max(128)).default([]),
  permissions: z.array(z.string().min(1).max(128)).default([]),
  mcpVersion: z.string().min(1).default("evex-tools/1"),
});
export type SkillManifest = z.infer<typeof SkillManifest>;

/** Agent-Skills frontmatter: the entrypoint must open with a YAML block
 *  carrying at least name + description, with name matching the manifest
 *  (and therefore the directory). Progressive disclosure (references/),
 *  relative links, and a non-monolithic body are checked by convention
 *  tests in tests/skill-compliance.test.ts. */
export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[a-z0-9-]+$/),
  description: z.string().min(1).max(2048),
}).catchall(z.unknown());
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export function parseFrontmatter(body: string): { frontmatter: SkillFrontmatter; rest: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(body);
  if (!m) throw new Error("entrypoint lacks YAML frontmatter (--- name/description block required)");
  const raw: Record<string, unknown> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) {
      const key = kv[1] as string;
      let val = (kv[2] ?? "").trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      raw[key] = val;
    }
  }
  return { frontmatter: SkillFrontmatterSchema.parse(raw), rest: body.slice(m[0].length) };
}

export interface DiscoveryEntry {
  name: string;
  version: string;
  platform: SkillPlatform;
  path: string;
  description: string;
}

export interface InstallOptions {
  overwrite?: boolean;
  homeDir?: string;
  manifestFile?: string;
}

export interface InstallResult {
  skillName: string;
  version: string;
  platform: SkillPlatform;
  installedPath: string;
  filesCopied: number;
  digest: string;
}

export interface VerificationResult {
  installedPath: string;
  manifestValid: boolean;
  entrypointPresent: boolean;
  discoveryVisible: boolean;
  smokePassed: boolean;
  details: string[];
}

export function platformDir(platform: SkillPlatform, homeDir?: string): string {
  const home = homeDir ?? homeDirOf();
  return join(home, PLATFORM_DIRS[platform]);
}

export function homeDirOf(): string {
  const h = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!h) throw new Error("Cannot determine home directory (HOME/USERPROFILE unset)");
  return h;
}

export function readManifest(skillDir: string, manifestFile = "skill.json"): SkillManifest {
  const raw: unknown = JSON.parse(readFileSync(join(skillDir, manifestFile), "utf8"));
  return SkillManifest.parse(raw);
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFilesRecursive(full));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Install a skill directory into a platform's skill path. Returns a digest over copied bytes. */
export function installSkill(sourceDir: string, platform: SkillPlatform, opts: InstallOptions = {}): InstallResult {
  const src = resolve(sourceDir);
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    throw new Error(`Skill source directory not found: ${src}`);
  }
  const manifest = readManifest(src, opts.manifestFile ?? "skill.json");
  const entryAbs = join(src, manifest.entrypoint);
  if (!existsSync(entryAbs) || !statSync(entryAbs).isFile()) {
    throw new Error(`Skill entrypoint missing: ${entryAbs}`);
  }
  const destRoot = platformDir(platform, opts.homeDir);
  const dest = join(destRoot, manifest.name);
  if (existsSync(dest)) {
    if (!opts.overwrite) {
      throw new Error(`Skill already installed at ${dest} (pass overwrite:true to replace)`);
    }
  } else {
    mkdirSync(dest, { recursive: true });
  }
  const files = listFilesRecursive(src).sort();
  const hasher = createHash("sha256");
  let copied = 0;
  for (const full of files) {
    const rel = full.slice(src.length + 1);
    // Never propagate VCS metadata or OS litter into installed skills.
    if (rel.startsWith(".git" + "/") || rel === ".git" || rel.endsWith(".DS_Store")) continue;
    const target = join(dest, rel);
    const parent = target.slice(0, target.length - basename(target).length);
    mkdirSync(parent, { recursive: true });
    const bytes = readFileSync(full);
    writeFileSync(target, bytes);
    hasher.update(rel);
    hasher.update(bytes);
    copied += 1;
  }
  return {
    skillName: manifest.name,
    version: manifest.version,
    platform,
    installedPath: dest,
    filesCopied: copied,
    digest: hasher.digest("hex"),
  };
}

/** Discovery check: is the skill visible under the platform path with a valid manifest? */
export function discoveryCheck(installedPath: string): { visible: boolean; entry: DiscoveryEntry | null; problems: string[] } {
  const problems: string[] = [];
  if (!existsSync(installedPath)) return { visible: false, entry: null, problems: [`path does not exist: ${installedPath}`] };
  const manifestPath = join(installedPath, "skill.json");
  if (!existsSync(manifestPath)) {
    return { visible: false, entry: null, problems: [`manifest missing: ${manifestPath}`] };
  }
  let manifest: SkillManifest;
  try {
    manifest = readManifest(installedPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { visible: false, entry: null, problems: [`manifest invalid: ${msg}`] };
  }
  const entryAbs = join(installedPath, manifest.entrypoint);
  if (!existsSync(entryAbs)) problems.push(`entrypoint missing: ${manifest.entrypoint}`);
  // Name must match the installed directory (spec compliance).
  const dirName = installedPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
  if (dirName !== manifest.name) {
    problems.push(`manifest name ${JSON.stringify(manifest.name)} does not match directory ${JSON.stringify(dirName)}`);
  }
  // Entrypoint frontmatter must carry name + description agreeing with the manifest.
  if (existsSync(entryAbs)) {
    try {
      const { frontmatter } = parseFrontmatter(readFileSync(entryAbs, "utf8"));
      if (frontmatter.name !== manifest.name) {
        problems.push(`frontmatter name ${JSON.stringify(frontmatter.name)} disagrees with manifest ${JSON.stringify(manifest.name)}`);
      }
      if (!frontmatter.description || frontmatter.description.length < 10) {
        problems.push("frontmatter description is missing or vacuous");
      }
    } catch (err: unknown) {
      problems.push(`frontmatter invalid: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Infer platform from the path suffix.
  let platform: SkillPlatform = "opencode";
  for (const p of SKILL_PLATFORMS) {
    if (installedPath.includes(PLATFORM_DIRS[p])) platform = p;
  }
  const visible = problems.length === 0;
  return {
    visible,
    entry: visible
      ? { name: manifest.name, version: manifest.version, platform, path: installedPath, description: manifest.description }
      : null,
    problems,
  };
}

/**
 * Invocation smoke test. Loads the entrypoint markdown, requires a non-empty
 * document with at least one heading, and requires every tool named in the
 * manifest to be mentioned in the entrypoint body (the contract the agent
 * runtime relies on to wire tools). Pure filesystem check — no agent launch.
 */
export function smokeTestSkill(installedPath: string): { passed: boolean; details: string[] } {
  const details: string[] = [];
  let manifest: SkillManifest;
  try {
    manifest = readManifest(installedPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { passed: false, details: [`manifest unreadable: ${msg}`] };
  }
  const entryAbs = join(installedPath, manifest.entrypoint);
  if (!existsSync(entryAbs)) return { passed: false, details: [`entrypoint not found: ${manifest.entrypoint}`] };
  const body = readFileSync(entryAbs, "utf8");
  if (body.trim().length < 64) {
    return { passed: false, details: ["entrypoint body too short (<64 chars)"] };
  }
  details.push(`entrypoint bytes=${body.length}`);
  if (!/^#{1,3}\s+\S/m.test(body)) {
    return { passed: false, details: [...details, "entrypoint has no markdown heading"] };
  }
  details.push("entrypoint has headings");
  const missing = manifest.tools.filter((t) => !body.includes(t));
  if (missing.length > 0) {
    return { passed: false, details: [...details, `tools undocumented in entrypoint: ${missing.join(", ")}`] };
  }
  details.push(`tools documented: ${manifest.tools.length}`);
  details.push(`digest=${sha256Hex(body)}`);
  return { passed: true, details };
}

/** Full verify pass: manifest + entrypoint + discovery + smoke test. */
export function verifySkill(installedPath: string): VerificationResult {
  const details: string[] = [];
  let manifestValid = true;
  try {
    readManifest(installedPath);
    details.push("manifest valid");
  } catch (err: unknown) {
    manifestValid = false;
    const msg = err instanceof Error ? err.message : String(err);
    details.push(`manifest invalid: ${msg}`);
  }
  const disc = discoveryCheck(installedPath);
  details.push(...disc.problems.map((p) => `discovery: ${p}`));
  if (disc.visible) details.push(`discovery visible: ${disc.entry?.name}@${disc.entry?.version}`);
  const smoke = disc.visible ? smokeTestSkill(installedPath) : { passed: false, details: ["smoke skipped: not discoverable"] };
  details.push(...smoke.details.map((d) => `smoke: ${d}`));
  // Entrypoint presence is derivable without re-reading the manifest.
  const entrypointPresent = disc.visible || disc.problems.every((p) => !p.startsWith("entrypoint missing"));
  return {
    installedPath,
    manifestValid,
    entrypointPresent,
    discoveryVisible: disc.visible,
    smokePassed: smoke.passed,
    details,
  };
}

/** Enumerate installed skills for one platform (best-effort; skips invalid entries). */
export function listInstalledSkills(platform: SkillPlatform, homeDir?: string): DiscoveryEntry[] {
  const root = platformDir(platform, homeDir);
  if (!existsSync(root)) return [];
  const out: DiscoveryEntry[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
      const disc = discoveryCheck(full);
      if (disc.visible && disc.entry) out.push(disc.entry);
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
