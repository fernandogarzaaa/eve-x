# VM (Virtualization & Guest Lifecycle)

Guests are QEMU/KVM virtual machines built reproducibly and driven through an
audited state machine.

## Image build (`infra/vm-images/build.sh`)

```
build.sh [--size 32G] [--out images/eve-desktop.qcow2] [--seed ubuntu-22.04]
```

1. Downloads the pinned Ubuntu cloud base image (`$EVEX_BASE_IMAGE_URL`,
   default Jammy) once into `images/seed/base.img`.
2. Writes `user-data` / `meta-data` / `network-config` cloud-init seeds:
   locked `eveagent` account, minimal desktop packages, SSH enabled,
   `/opt/eve-agent` provisioned.
3. Builds `seed.iso` with `cloud-localds`.
4. Converts the base to qcow2, resizes to `--size`, and writes
   `<image>.build.json` with base URL, base sha256, output sha256, and UTC
   build timestamp.

Re-running with the same base URL and size reproduces a bit-identical guest
root modulo cloud-generated host keys (recorded, never baked).

## Lifecycle states

```
CREATING → CREATED → BOOTING → READY ⇄ RUNNING → STOPPING → STOPPED
              ↘ FAILED → DESTROYING → DESTROYED
RUNNING ⇄ PAUSING → PAUSED · RUNNING ⇄ RESTORING · RUNNING ⇄ FORKING
```

Enforced by `VM_TRANSITIONS` in `packages/core` and covered in
`tests/state-machine.test.ts`. Illegal jumps throw `INVALID_TRANSITION` and
are audit-logged with reason strings.

## Snapshots and forks

- `snapshot` captures a named qcow2 overlay checkpoint; `restore` returns to
  it (used for clean-room task starts and incident forensics).
- `fork` clones a running guest via overlay for parallel branch exploration
  during replay (`tests/replay.test.ts`).

## Sizing and defaults

`VmSpec` defaults: 4 vCPU, 8192 MB RAM, 32 GB disk, 1920×1080, `en-US`/UTC,
`allowlisted` network. Overrides are per-task and validated by the protocol
schemas before any hypervisor call.

## Operations

- `GET /v1/vms/{vmId}` — state inspection.
- `POST /v1/vms/{vmId}/control` — `{op, snapshotId?, reason?}`; 409 on
  illegal transitions.
- `DELETE /v1/vms/{vmId}` — destroy and reap overlays.
- Console surfaces per-VM CPU/memory/disk plus snapshot chains.
