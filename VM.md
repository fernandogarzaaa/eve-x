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

- `snapshot` captures a named checkpoint (`savevm`); `restore` returns to it
  (`loadvm`). Restore was proven with real filesystem rewind: a file deleted
  after the snapshot reappears after `loadvm`
  (`artifacts/qualification/wsl-kvm-qual.json`, `restore-proof` phase).
- `fork` duplicates a RUNNING guest for parallel branch exploration. Because
  QEMU locks a live image, fork quiesces the source (`stop`), records a
  `savevm` marker, copies the overlay at filesystem level (the golden base is
  shared read-only and never copied), resumes the source, boots the child,
  then `loadvm`s the marker and resumes its CPUs — so the child starts at the
  exact source moment. Branch isolation proven live (independent files per
  branch, `fork-isolation` phase).

## Base images, overlays, and seeds

- Golden base images are read-only (`chmod 444`); every VM boots a private
  CoW overlay (`qemu-img create -b`). Boot re-fingerprints the base
  (size + head/tail sha256) and refuses with `BASE_MUTATED` on drift.
- Each VM gets a per-VM NoCloud `seed.iso` (attached `readonly=on`)
  carrying hostname, optional SSH key, and the per-VM guest-agent HMAC
  secret (`guest-secret`, mode 0600, in the VM workdir; provisioned by
  `provisionGuestSecret`, never logged).
- QEMU boots with `-accel kvm -accel tcg` (repeated flags: QEMU 10 rejects the
  legacy `kvm,tcg` comma form), `-sandbox
  on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny`,
  VNC bound to 127.0.0.1 only, and per-VM user-mode forwards derived from the
  display claim (agent `18080+i`, SSH `22000+i`, VNC `5900+d`).
- Display allocation TCP-probes each candidate triple and skips ports held by
  out-of-band processes (e.g. orphaned QEMU) instead of colliding with them.

## Guest channels

- **QMP** (unix socket): lifecycle (`stop`/`cont`/`system_powerdown`/
  `system_reset`), `screendump`, `savevm`/`loadvm`. Real QMP against QEMU
  10.2.1 qualified live.
- **qemu-guest-agent** (direct virtio-serial channel, `guest-sync` liveness
  proof, then `guest-exec`): filesystem proof, in-guest commands. The direct
  channel is used because QMP guest-exec passthrough is absent on some QEMU
  builds (Debian QEMU 10 registers no `guest-*` QMP commands) and because QGA
  sends no greeting (the client must speak first with `guest-sync`).
- **EVE guest agent** (HTTP + HMAC, port-forwarded per VM): screenshots,
  input injection, clipboard, fs operations. Secret travels only in the seed.

## Sizing and defaults

`VmSpec` defaults: 4 vCPU, 8192 MB RAM, 32 GB disk, 1920×1080, `en-US`/UTC,
`allowlisted` network. Overrides are per-task and validated by the protocol
schemas before any hypervisor call.

## Operations

- `GET /v1/vms` / `POST /v1/vms` — list / provision (capability `vm:create`).
- `GET /v1/vms/{id}` / `GET /v1/vms/{id}/status` — inspection.
- `POST /v1/vms/{id}/snapshot|restore|fork` — snapshot, restore, branch
  (capability `vm:control`; fork needs `vm:create`). 409 on illegal
  transitions; failed restores land in FAILED, never RUNNING.
- `DELETE /v1/vms/{id}` — destroy and reap overlays (capability `vm:destroy`).
- Console surfaces per-VM CPU/memory/disk plus snapshot chains.
