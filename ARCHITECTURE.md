# ARCHITECTURE

## System overview

EVE-X is a single-npm-package TypeScript monorepo plus a Python ML track.
Four runtime planes cooperate:

```
                    ┌─────────────┐
                    │   Console   │  operator UI (review, takeover, releases)
                    └──────┬──────┘
                           │  REST /v1 (openapi.json)
┌──────────┐  MCP mcp/1  ┌─┴──────────┐   traces   ┌───────────┐
│  Agents  │◄───────────►│ Control    │◄──────────►│ Postgres  │
│ (skills) │             │ Plane API  │            │ + objects │
└──────────┘             └─┬───┬──┬───┘            └───────────┘
                           │   │  │
              ┌────────────┘   │  └────────────┐
              ▼                ▼               ▼
        ┌──────────┐    ┌───────────┐    ┌────────────┐
        │ Worker   │    │ Inference │    │ VM fleet   │
        │ (tasks)  │    │ :8090     │    │ qcow2/QEMU │
        └──────────┘    └───────────┘    └────────────┘
```

- **Control plane (`apps/api`)** — owns REST `/v1`, auth, capability authz,
  policy gates, the trace ledger, and task orchestration.
- **Worker (`apps/worker`)** — executes seeded tasks step-by-step: observe →
  model.invoke → verify → act → record. One task = one session = one VM.
- **Inference (`ml/inference/server.py`)** — screenshot+context → ActionIR
  JSON with confidence. Stdlib-only HTTP service with `/health`, `/ready`,
  `/metrics`, `/infer`, bounded queue, and degraded heuristic mode.
- **VM fleet** — QEMU guests built by `infra/vm-images/build.sh` from a
  pinned base image + cloud-init seed; snapshots give clean-room starts.

## Data flow of one step

1. Worker captures the guest frame (`computer.observe`).
2. Region detector + world model produce `ComputerPercept` (protocol schema).
3. Inference returns a ranked `candidate_actions` list with confidences.
4. The **verifier** grounds the top candidate: region must exist, bbox inside
   the frame, confidence above threshold (tested in
   `tests/verifier-grounding.test.ts`).
5. The **policy gate** checks destructive/comms/credential rules against the
   task policy; denials and escalations are recorded, never silent.
6. The action executes with an idempotency key; before/after screens and the
   outcome append to the trace ledger (`tests/trace.test.ts`).

## Packages

- `protocol` — zod schemas only, no logic. Imported by every other package.
- `core` — `uid`, `nowIso`, `EveError`, seeded `prng` (mulberry32),
  generic audited `StateMachine`, `VM_TRANSITIONS`.
- `mcp-shared` — MCP tool input schemas (`TOOL_SCHEMAS`, version `mcp/1`)
  plus `ControlPlaneClient`: fetch wrapper with Bearer auth, per-request
  `AbortController` timeouts, idempotency-key header, typed helpers per route.
- `skills` — skill installer/verifier: manifest validation, platform-path
  install, discovery check, entrypoint smoke test.
- `model-registry` — filesystem-backed version records with benchmark
  history, compat triples, runtime requirements, and a gated `promote()`
  that refuses production without staging + approval token + held-out scores.

## Persistence

- Postgres: VMs, tasks, sessions, trace steps, judgments, model records index.
- Object storage (MinIO/S3-compatible): screenshots, weight blobs, exports.
- Filesystem registry layout (`packages/model-registry`): `records/*.json`
  plus `weights/` blobs; optional push/pull to object storage over plain
  fetch (no SDK), Bearer-authenticated.

## Decisions

All structural choices are recorded in `docs/adr/ADR-*.md` (virtualization,
guest OS, streaming, transport, storage, backbone, action IR, grounding,
world model, MCP versioning, auth, snapshots, takeover).
