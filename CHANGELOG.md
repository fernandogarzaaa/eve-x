# Changelog

## EVE-X 1.0.2

- Virgin deploy rehearsal fixes: worker/mcp entry paths, MCP port mapping
  + http mode, `docker-compose.release.yml` for prebuilt images, garage
  config renderer. Rehearsal passed on fresh volumes (8/8 services, S3
  round-trip, session + worker + console + MCP).
- Training pipeline: learnable toy signals, full-head checkpoints, phase
  LM weights, trailing-window gate accuracy. Best run r14 (train-acc 1.0,
  fresh MAE 0.057) registered experimental with measured eval scores;
  staging gate holds below IoU bars.
- Model track recorded in PRODUCTION_QUALIFICATION.md §10.

## EVE-X 1.0.1

Patch over 1.0.0 (PR #1, CI-green on ubuntu + windows):

- Sessions whose VM died no longer report RUNNING: dead-VM codes mark the
  session FAILED with persisted reason, a `vm-lost` trace step, and
  broadcast; observe/act answer 503 `vm_unreachable`.
- Post-restart trace amnesia fixed: `mergedTraceSteps()` serves full
  history to session counts, `/trace`, `/report`, `/reviews`, `/replay`.
- CI added (ubuntu + windows): deterministic test entry (no shell glob),
  QMP framing test de-flaked, display-allocator test ports off WinRM range.

## EVE-X 1.0.0

Production VM execution, human console, computer use, human validation,
replay/fork, MCP, Agent Skills, ML pipeline, Genesis assurance, security
hardening, S3-compatible storage (Garage v2), and full production +
release qualification.

### Production VM execution

- Real QEMU/KVM guests via `QemuDriver`: overlay-on-sealed-base provisioning,
  QMP lifecycle, direct QGA channel (guest-sync, no greeting assumption),
  `{return}`-envelope parsers, serial console, savevm/loadvm snapshots,
  quiesced fork (stop → marker → copy → resume → child loadvm + `cont`).
- Sealed graphical desktop base (`eve-desktop-xorg.qcow2`, GNOME/Xorg,
  qemu-guest-agent, Firefox, scrot): per-VM NoCloud `seed.iso` + 0600
  guest secret, `BASE_MUTATED` refusal fail-closed.
- `VmManager`: quotas, leases, QMP-proven reattach after restart,
  synchronous VNC display reservation (TOCTOU fixed + negative-tested).

### Human console

- Static console (timeline, overlays in canonical corner-bbox convention,
  step log) served by `apps/console` with `/health`.
- Human loop: takeover holds control (acts 409), release + re-observe,
  blind-review queue with confidence hidden, judgment unlock.

### Computer use (EVE-CUA)

- Observe → perceive (regions) → ground (point→region, verified/unverified
  recorded honestly) → verify → act via VNC/RFB or guest-exec → re-observe.
- Stale-perception 409s, epoch fencing, order-checked replay.

### Replay / fork

- Step-addressable traces, digest-chained replay, snapshot/restore,
  fork isolation (parent/child branch independence proven live).

### MCP

- 21 tools (`eve_session_*`, `eve_vm_*`, `eve_computer_*`, `eve_human_*`,
  `eve_task_*`, `eve_trace_get`, `eve_replay`, `eve_report`,
  `eve_benchmark`, `eve_model_status`) over stdio + StreamableHTTP (`mcp/1`),
  caller-auth forwarding, typed error classes, 30 s timeouts.

### Agent Skills

- Installer/verifier (`installSkill`, `verifySkill`) for claude-code,
  codex, opencode, cursor, windsurf; `integrations/` ships `mcp.json` for
  claude-code, codex, generic, hermes, openclaw, opencode, pi; skill
  scripts (`observe.mjs`, `act.mjs`, `replay.mjs`) usage-tested offline.

### ML pipeline

- Registry with sha256 checkpoints, benchmark-gated promotion (human
  approval mandatory), retire/rollback; `eval.py` grounding/success/
  recovery metrics with discriminating eval harness; stdlib smoke path.

### Genesis assurance

- Claim/verifier adversarial audit: SOUND on honest claims, EXPLOITABLE on
  forged/mismatched/self-graded; evidence-resolves resolver hook.

### Security hardening

- Bearer auth + capability matrix, tenant isolation, guest escape probes
  clean (metadata/QMP/secrets/loopback blocked), prompt-injection +
  clock-skew + replay test suites, production gate (`doctor --production`)
  failing closed on dirty builds and commit mismatch.

### Storage

- File-primary record (`DATA_DIR`); Postgres/Redis optional with graceful
  fallback; Garage v2 (ADR-14) as the qualified S3-compatible
  artifact/backup target (9/9 object qual, backup/restore byte-identical).

### Production qualification (measured)

- 200/200 unit tests; canonical E2E 28/28 on graphical KVM;
  post-canonical 11/11; concurrency 5/5 with trace isolation; escape
  probes clean; model A→B→rollback verified; DR 32→0→32 sessions.

### Known limitations

- Single-node file-primary record (no distributed DB in 1.0.0).
- Guest images logically reproducible via sealed base digests, not claimed
  bit-for-bit.
- Windows is a client/dev surface; KVM production runs on Linux.
