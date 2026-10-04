# EVE-X 1.0.0 FINAL RELEASE REPORT

**Status: RELEASE QUALIFIED**

## Version

- Version: 1.0.0
- Commit: `ce81acf4dfcecef40a25666f61f1ee0168e26ad3`
- Tag: `v1.0.0` (annotated; `v1.0.0^{commit}` == HEAD at tag time)
- Tree: `f63d1c6c373c48a29080bfab345fc09095b0c965`, clean
- Release string: `eve-x 1.0.0+ce81acf4dfce` (via `eve-x version`, `/version`, `/health`, `doctor --production`)

## Build reproducibility

- `npm ci` → `npm run clean` → `npm run build` → `npm test` from scratch: green.
- dist bit-identical across clean builds except `release.gen.*` (buildTime stamp by design) — proven by double-build digest comparison.
- Tag integrity: fresh worktree @ v1.0.0 → `npm ci` → clean → build → **200/200**, identity reports the tag commit, `dirty:false`.

## Clean-machine result

- Tag worktree: 142 packages installed via lockfile, 200/200 tests, no global deps required (node builtins + npm only; Python stdlib for harnesses; boto3 only for S3 qual probes).
- Full clean-room deployment (virgin host) was not available; bounded equivalent executed: digest-pinned images built from clean tree, container boot + `/version` verified, empty-DATA_DIR boot + backup restore rehearsed.

## Dependency identity

- `package-lock.json` sha256 `81ef2884be6e3109a974f861fc6f1b6db3c9acbdba41255d3c0823fb0f8ff9dd` (4 prod deps: express, ws, zod, @modelcontextprotocol/sdk; zero vulns `npm audit`).
- Python: stdlib-only product paths (`train.py --smoke`, `eval.py`, inference server); `ml/requirements.txt` ranges documented, torch optional.
- Base images digest-pinned: node:20-slim `sha256:2cf067…`, python:3.11-slim `sha256:bab1b7…`, garage `sha256:15b40e0…`, postgres `sha256:721873…`, redis `sha256:858f00…`.

## Container identity

| Image | Digest |
|---|---|
| evex-api:1.0.0 | sha256:3e52592b965c11ca57035d1794bcf74d2638ed4bd017c8b5af04445777abb3a8 |
| evex-worker:1.0.0 | sha256:34b4a1e7f6e91ed9c57d005320ed2e5183d83f65d048d2302c2e3130f684e6f9 |
| evex-mcp:1.0.0 | sha256:7a6c25edc174ff893467a337b67f4b357a2f210b19b73e16966d0069271f1097 |
| evex-console:1.0.0 | sha256:0c256235aba5f4b87cecd675db9ba01929430b68a4a38828ff12902f4c85bab7 |
| evex-inference:1.0.0 | sha256:56ca1a13158be3486a412aeaa570443b6b690ce8a19fb2a1f1643ebdb52d0209 |

- `npm ci --omit=dev` inside images (was `npm install`); no source trees copied (dist only); non-root `evex` user; image filesystem scanned (no .env/keys/certs).
- Live proof: `evex-api:1.0.0` booted → `/version` reports commit `ce81acf4…`, `dirty:false`.
- Environment note: Docker Desktop + WSL2 localhost relay squats some host ports (observed: wslrelay on 18080/18081 RSTs probes); use fresh host ports for container probing.

## VM image identity

- Release guest: `eve-desktop-xorg.qcow2`, sha256 `38afb22b948e61c11fa044204a2cf2372bbb1ba80fb94075dcac9d45ae5b4249` (matches seal manifest — untouched).
- Base: `eve-desktop-noble.qcow2`, sha256 `e19b77ba669ef5e813213a145a99efeeb3d4f58a0fc220dad2f9b4891679273b`.
- Sealed read-only, no baked secrets (per-VM seed.iso + 0600 guest-secret at provision), `BASE_MUTATED` fails closed.
- Reproducibility: logical via sealed base digests + bake manifest; bit-for-bit not claimed.

## Model identity

- 1.0.0 ships the registry + stdlib smoke/eval path; no trained checkpoint is promoted to production (recorded in release-manifest).
- Registry proven: A→production, B→production, retire B → A sole production; weights sha256 + benchmark gates enforced; tampered weights refused.

## Production deployment

- KVM: WSL2 Ubuntu 24.04, kernel 6.18.33.2, QEMU 10.2.1, /dev/kvm.
- QEMU: overlay-on-sealed-base, QMP lifecycle, direct QGA channel.
- Guest: eve-desktop-xorg (GNOME/Xorg, agent, Firefox, scrot), 1280x800 lazy enforcement.
- VNC: RFB input with pixel proof; display allocator TOCTOU fixed (8-way collision negative-tested).
- EVE-CUA: observe → regions → point→region grounding (verified/unverified honest) → verifier → act → re-observe.
- Human console: timeline/overlays/log, takeover, blind review, judgment unlock.

## Storage

- Record: filesystem `DATA_DIR` (sessions/VMs/tasks/traces/registry/audit). Postgres optional mirror, Redis ephemeral coordination w/ file-lease fallback.
- Garage v2 qualified S3 target (9/9 object qual; backup/restore byte-identical `fbbab289…`; DR rehearsed). MinIO documented as supported alternative only.

## Security

- Authentication: bearer + capability matrix; old qual token rotated (401s), Garage qual keys created→deleted per run.
- Authorization: tenant isolation unit-tested; escape probes clean on release build.
- Sandbox/Network: NAT-only guests, metadata blocked, no QMP/host secrets in guest, host loopback blocked.
- Secrets: `security-audit` 0 findings across tree; git history scanned (4 commits, no keys — only the scanner's own regex); images scanned clean; rendered secrets gitignored.
- TLS: nginx sidecar TLS 1.3 verified (`tls-check.mjs`).

## MCP

- 21 tools live via stdio against the release build (inventory recorded); StreamableHTTP with caller-auth forwarding; typed errors; 30 s timeouts.

## Agent Skills

- Installer/verifier for claude-code/codex/opencode/cursor/windsurf; `integrations/` mcp.json for 7 platforms (parse-tested); skill scripts usage-tested offline.

## Human validation

- Blind review hides confidence; judgment unlocks; takeover holds + denies acts (409) + releases + re-observes — all in canonical 28/28.

## Takeover / Replay / Fork

- Takeover → release → re-observe; replay 6/6 with digest chain + order checks; snapshot/restore; fork child RUNNING with branch isolation.

## Genesis

- SOUND on honest, EXPLOITABLE on forged/mismatched/self-graded; evidence-resolves hook; 4/4 on release trace.

## Benchmarks

- `eval.py` exact=1.0 / shifted=0.0 (discriminating); benchmark-run artifact in canonical; promotion gates (approval + test + held-out) enforced, refusals held.

## Concurrency

- 5/5 dual-desktop: create/observe/act/destroy + trace isolation on 9.6 GB host.

## Failure recovery

- API kill → rehydrate (29–32 sessions, QMP-proven reattach); DR wipe → 0 → restore → 32 sessions, identity intact; Garage destroy → restore byte-identical.

## Backup/restore

- `DATA_DIR` tar rehearsed; Garage data+meta rehearsed; evidence JSONs in `artifacts/release/`.

## Observability

- `/health` + `/version` carry release identity; `x-request-id` on responses; JSONL logs with requestId; trace steps carry session/step/actor/model/timestamps; no secret leakage (audited).

## Tests

- 200/200 (41 suites) on frozen commit AND on tag worktree; typecheck, lint, security-audit, npm audit (0 vulns) all green. No test weakened.

## Release artifacts

- `artifacts/release/pkg/RELEASE_ARTIFACTS.sha256`: source/skill/deploy/docs bundles + manifest + provenance; bundles uploaded to Garage `release/1.0.0/` with retrieve-digest verification, keys revoked.
- Garage `release/1.0.0-rc/release-evidence.tar` (evidence bundle).

## Checksums

See `artifacts/release/pkg/RELEASE_ARTIFACTS.sha256` and `release-manifest.json` / `RELEASE_PROVENANCE.json`.

## Known limitations

- Single-node file-primary record (no distributed DB in 1.0.0).
- Guest images logically (not bit-) reproducible.
- No trained weights checkpoint promoted in 1.0.0 (registry + smoke path ship).
- Windows is client/dev surface; KVM production is Linux-only.
- Full virgin-host deployment not rehearsed (bounded equivalents executed and recorded).
- Soak: ~21 min sustained under full qual load (mem 4702→4387 MB, API fds 24→24, no QEMU strays) — no multi-hour soak.

## Remaining risks

- Host undersizing (quotas vs RAM) remains operator responsibility (`doctor --production` warns).
- WSL2 localhost relay can squat probed host ports — use fresh ports.
- The committed pre-rotation qual bearer is inert (live deployments rotated) but present in history; history not rewritten to preserve the qualification lineage.

## Production qualification

`PRODUCTION_QUALIFICATION.md`: no NOT_AVAILABLE rows on the Linux/KVM path.

## Release qualification

This report + `RELEASE_PROVENANCE.json` + `release-manifest.json` + `artifacts/release/` evidence.

## Evidence locations

- Repo: `release-manifest.json`, `RELEASE_PROVENANCE.json`, `PRODUCTION_QUALIFICATION.md`, `CHANGELOG.md`, `FINAL_RELEASE_REPORT.md` (this file).
- Gitignored local: `artifacts/release/` (baseline, garage-backup-restore, artifact-integrity, release-upload, pkg + checksums).
- Garage `evex` bucket: `release/1.0.0/*`, `release/1.0.0-rc/*`, `qual/*`.
- WSL host: `/root/evex-prod/artifacts/qualification/` (canonical/post-canonical/concurrency/eval/escape JSONs + PNGs).
