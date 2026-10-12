# RELEASE IDENTITY MODEL

What "EVE-X release X" means, formally, and what each artifact proves.

## Identity tuple

A release is identified by `(product, version, commit, tree)` where:

- `product` is always `"eve-x"`.
- `version` is the `package.json` version, mirrored on every surface
  (CLI, MCP server, OpenAPI, compose tag) — `verify-release` refuses drift.
- `commit` is the git commit the release metadata describes: either HEAD,
  or HEAD's parent when HEAD is exactly a metadata commit touching only
  `release-manifest.json` + `RELEASE_PROVENANCE.json` (the standard
  two-commit release shape).
- `tree` is `commit^{tree}` — the full source tree digest. Commit identity
  without tree binding is worthless after rebases/amends; the verifier
  checks `manifest.tree == rev-parse(commit^{tree})`.

## What each artifact binds

| Artifact | Binds | Verified by | Trust boundary |
|---|---|---|---|
| `release-manifest.json` | version, commit, tree, toolchain, lockfile sha, MCP tool list + versions + SDK, skill name/version/content digests (re-measured against the tree), container base digests, guest status | `verify-release` (44+ checks) | Digest VALUES it records (image/model digests) are claims until re-measured at deploy; SHAPE + binding are verified here |
| `RELEASE_PROVENANCE.json` | version, commit, tree, dependency versions, evidence file shas | `verify-release` | Same value/shape split as the manifest |
| `RELEASE_ARTIFACTS.sha256` | bundle bytes post-packaging | `verify-release` re-hashes every listed file | Catches post-archive tampering; does not attest bundle correctness |
| `packages/core/release.gen.ts` (gitignored) | baked commit/tree/dirty/sourceDigest into every binary | `assertReleaseCommit` at boot, `doctor`, `/version` | Regenerated per build; dirty builds refuse without the dev escape hatch |
| Trace steps (`prevDigest`/`digest`) | per-step SHA-256 chain | `verifyReplay`, `TimelinePlayer`, `EvidenceValidator` | Legacy 40-hex digests flagged, never trusted |
| Skill binding | `skill.json` + entrypoint content digest | `verify-release` re-measures per skill | A changed skill without regen is stale by construction |

## What the model does NOT prove (explicit non-goals)

1. **Digest values are not re-measured here.** A well-formed but false
   `imageSha256` passes shape checks. Digest truth is established at
   DEPLOY time (`EVEX_BASE_IMAGE_SHA256` pin refuses boot on mismatch;
   container pulls resolve digests; inference `--weights-sha256` refuses
   unpinned weights). The manifest is an inventory with bindings, not an
   oracle. (Attack suite case 11 pins this boundary.)
2. **Rebase/amend invalidates attestation** unless the result is exactly
   the metadata-commit shape with identical attested bytes. Hash identity
   is the attestation; rewritten hashes are new claims requiring regen.
3. **Tags are advisory markers**, checked only when an exact-match tag
   exists on HEAD (must equal the version). An absent tag is not a failure.
4. **Ignored files are invisible** by git semantics (build outputs, local
   logs). Untracked non-ignored files refuse. Shallow clones and detached
   HEADs verify against shas, not branches.
5. **Environment is sanitized** (`GIT_DIR` et al. scrubbed via
   `scripts/git-safe.mjs`): revision queries read exactly the tree the
   scripts run in. A hostile env cannot redirect attestation elsewhere.

## Release procedure (normative)

1. Clean tree. `npm run release` (manifest → provenance → packages →
   verify). Fix any refusal; never override.
2. Commit `release-manifest.json` + `RELEASE_PROVENANCE.json` as
   "Release metadata for X".
3. `node scripts/verify-release.mjs` must print `consistent` on the
   resulting HEAD. Anything else is not a release.

## Provenance chain (build → runtime → trace → benchmark)

`release.gen.ts` bakes commit/tree/dirty into every binary → `/version`
and `doctor` report it → benchmark records carry `sourceCommit/sourceTree`
→ trace steps carry the session's model/environment identity → task
validation cites step ids whose digests chain back to genesis. Any link
that cannot be produced is recorded as unknown (`null` with reason),
never invented.
