# Changelog

## EVE-X 1.1.1 — release-integrity hardening (no architecture changes)

Targeted finalization of the 1.1.0 hardening branch. No product behavior
changes except where integrity requires refusal:

- Release path logic: generatable-file matching is exact repo-relative
  equality (`scripts/release-paths.mjs`), never suffix matching — a nested
  `attacker/release-manifest.json` is foreign, not generatable (P1 fix).
- Base-image digests are measured into `images/base-digests.json` via live
  registry resolution (method/host/timestamp recorded); the manifest copies
  that record with provenance instead of asserting hardcoded constants.
  This pass caught one real rot: the `python:3.11-slim` tag moved since the
  old constant was copied (Dockerfile digest pins remain frozen snapshots).
- Release images must be bound records (`digest` + `builtFromCommit` +
  `builtFromTree` equal to the release commit/tree); bare digests copied
  from another release are refused by `verify-release`.
- Attack suite grows 26 → 32 cases: nested-basename collisions (untracked
  and smuggled into the metadata commit), cross-release digest reuse
  (bare and foreign-bound), and unit coverage of the exact-path rule.
- Case #22 git operations are hermetic (explicit identity via the shared
  helper) so CI passes without a configured committer.
- Trace chain: `TraceStore.fromJsonl` verifies chained digests on load
  (new `appendVerified`) instead of silently re-stamping; `TimelinePlayer`
  reports `SESSION_SPLIT` before digest mismatch on merged logs;
  `verifyReplay` takes an expected count so truncation is flagged.
- Guest jail: NFKC normalization (fullwidth-dot smuggling refused),
  hardlink-to-outside refusal, swap-symlink containment, no-shell exec
  proof, wrapper-script identity refusal.
- Source identity reconciled to 1.1.1 across package, CLI, MCP server,
  OpenAPI, compose tags, manifest, and provenance.

## EVE-X 1.1.0 — evidence-integrity rebuild (BREAKING where honesty requires it)

Verification over agent self-report, enforced in code and CI:

- Worker: the synthetic PRNG observe/plan/act loop is deleted. The
  production worker is a control-plane orchestrator (lease -> fresh real
  percept -> inference suggest -> server-side act with grounding/safety/
  stale enforcement -> evidence steps written by the plane). It never
  writes `verified`/`passed`/synthetic perception; synthetic backends are
  refused structurally (`SYNTHETIC_BACKEND_REFUSED`) and on the wire.
- Task validation: `POST /v1/tasks/:id/validate` no longer sets pass on
  request. An `EvidenceBundle` (session + cited steps + oracle assertions +
  judgments) is required; verdicts are PASS / FAILED / INCONCLUSIVE /
  INVALID_EVIDENCE with the exact causing evidence named. Tampered,
  unknown, or unchained evidence is INVALID_EVIDENCE; uncertainty is never
  collapsed into success. (Breaking: empty bodies now 400.)
- Benchmarks: the seeded inline agent is deleted. `POST /v1/benchmarks`
  executes each task against a real session/VM via the RealAgentAdapter and
  scores server-written trajectories with the IndependentEvaluator
  (decision-point grounding, temporal recovery, signal + verification
  success rule). Mock agents require `agent: mock-test-only` +
  `testOnly: true` and stamp records synthetic/test_only, which production
  consumers refuse. Records carry verdict counts, Wilson 95% CIs, agent +
  model + environment identity, and evidence digests.
- Inference ModelRuntime: weights are verified (existence, size, sha256,
  container format, manifest agreement, torch load + parameter census)
  before `ready=true`; every result carries model_id/version/sha256,
  architecture, device, action_source, degraded, weights_verified,
  latency, frame_id. Served actions come from the explicit `heuristic-v1`
  policy (always degraded=true) until a model-forward path exists;
  unready planes answer 503, never heuristic-as-model. Bearer auth on
  `/infer` + `/model-info` when configured; internal-only topology.
- Trace chain: SHA-256 append-only digests stamped by the control plane on
  every step (the `sha1hex` toy hash is deleted); replay and the timeline
  player verify full-content chains; the trace merge preserves file order
  (reorder tampering stays detectable). Unknown sessions fail closed on
  trace/replay/report reads.
- Guest security: canonical fs jail (lexical gate + symlink-refusing walk
  + O_NOFOLLOW open + post-open containment re-check), canonical
  executable identity (allowlist + trusted dirs + realpath, no PATH or
  basename trust), and an unprivileged agent account (`sudo: false` in all
  seeds; maintenance via the root QGA channel).
- Fail-closed modes (`EVEX_MODE` development/test/production): no dev-anon
  auth outside development; `startApi` refuses production boot unless the
  posture evaluates production-safe; production VM images must be
  digest-pinned (`EVEX_BASE_IMAGE_SHA256`, `requirePinnedDockerImage`);
  secrets are required, never defaulted (`change-me`/`evex` defaults
  removed; `eve-x init` mints a random token).
- Full SHA-256 base-image pins (size+mtime fast path, re-hash on change,
  boot refusal on drift, multi-region tamper tests); containers pinned by
  digest; release scripts rebuilt (no commit override, dirty fails closed,
  measured manifest, `verify-release` consistency gate, `nul` bug fixed).
- MCP: SDK 1.31 line pinned (registry latest is 1.32.x which requires zod
  v4 — no v2 line exists upstream; migration tracked separately);
  protocol versions negotiated honestly with tests; HTTP auth gating,
  per-caller rate limit, session isolation tests.
- Skills: `SKILL.md` frontmatter (name/description) + `skill.json`
  required and validated (name==directory, tools documented, install +
  verify round-trip); the canonical skill teaches the full honest loop.
- Evaluation: eval-v2 scoring (decision-point grounding, verified success,
  temporal recovery, inconclusive/invalid accounting); datasets bind
  fingerprints to visual state with label provenance and split digests.
- Recovery: restart demotes unproven RUNNING to PAUSED (explicit resume);
  WS streams carry HTTP-equivalent auth + ownership + flood caps;
  `/metrics` exposes failure/behavior counters.
- CI enforces honesty statically (`honesty-gates`: no synthetic worker,
  no hardcoded pass, no model masquerade, no basename authz, no mock
  benchmarks, no toy digests, no mutable tags, no weak defaults, no
  secret logging)   plus the ML self-tests (65 checks on real Python).

## EVE-X 1.0.3

- Advisory inference loop: `POST /v1/computer/:id/suggest` proposes an
  action from the inference plane (model_id + degraded reported, never
  actuated, trace untouched, explicit 502/503 fallbacks). Proven live
  against r16-serving inference on a real guest.
- Training pipeline: learnable toy signals, full-head checkpoints, phase
  LM weights, trailing-window gate accuracy (r16 experimental, gates hold).

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
