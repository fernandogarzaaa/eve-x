# AGENT_SKILL (Skill Format, Install, Verify)

Skills extend agents with domain know-how. A skill is a directory containing
at minimum `skill.json` (manifest) and an entrypoint markdown file (default
`SKILL.md`); tooling lives in `packages/skills`.

## Manifest (`skill.json`)

```json
{
  "name": "pdf-triage",
  "version": "1.2.0",
  "description": "Extract tables from booted PDF readers via grounded clicks",
  "entrypoint": "SKILL.md",
  "tools": ["computer.observe", "computer.act"],
  "permissions": ["computer:observe", "computer:act"],
  "mcpVersion": "mcp/1"
}
```

Validated by the `SkillManifest` zod schema: name/version/description
required, `tools` and `permissions` default to empty, entrypoint defaults to
`SKILL.md`.

## Install

```ts
import { installSkill } from "../packages/skills/src/index.js";
installSkill("./my-skill", "opencode", { overwrite: false });
```

- Target platforms and their scanned paths (under the user's home):
  `claude-code` → `.claude/skills`, `codex` → `.codex/skills`,
  `opencode` → `.config/opencode/skills`, `cursor` → `.cursor/skills`,
  `windsurf` → `.windsurf/skills`.
- Install validates the manifest, requires the entrypoint file to exist,
  refuses to overwrite unless asked, copies the tree (skipping VCS metadata
  and OS litter), and returns `{installedPath, filesCopied, digest}` with a
  sha256 over names + bytes.

## Verify

```ts
import { verifySkill } from "../packages/skills/src/index.js";
const v = verifySkill("/home/op/.config/opencode/skills/pdf-triage");
// {manifestValid, entrypointPresent, discoveryVisible, smokePassed, details}
```

- **Discovery check** — manifest re-parses at the installed path and the
  entrypoint exists; the platform is inferred from the path suffix.
- **Smoke test** — entrypoint is ≥ 64 chars with at least one markdown
  heading, and every tool named in the manifest is mentioned in the
  entrypoint body (the wiring contract the runtime relies on). No agent is
  launched; the check is pure filesystem I/O.
- `listInstalledSkills(platform)` enumerates valid installs, skipping broken
  entries so one bad skill never hides the rest.
