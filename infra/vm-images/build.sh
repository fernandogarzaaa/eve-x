#!/usr/bin/env bash
# EVE-X guest image builder: reproducible Ubuntu Desktop qcow2 + cloud-init seed.
# Requires: qemu-img, qemu-system-x86_64, cloud-localds (cloud-image-utils), xorriso.
# Usage: infra/vm-images/build.sh [--size 32G] [--out images/eve-desktop.qcow2] [--seed ubuntu-22.04]
set -euo pipefail

SIZE="32G"
OUT="images/eve-desktop.qcow2"
SEED_OS="ubuntu-22.04"
BASE_URL="${EVEX_BASE_IMAGE_URL:-https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SEED_DIR="${REPO_ROOT}/images/seed"

usage() {
  echo "usage: build.sh [--size 32G] [--out images/eve-desktop.qcow2] [--seed ubuntu-22.04]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --size) SIZE="${2:?}"; shift 2 ;;
    --out) OUT="${2:?}"; shift 2 ;;
    --seed) SEED_OS="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required tool missing: $1" >&2
    exit 2
  fi
}
need qemu-img
need cloud-localds

mkdir -p "$(dirname "${REPO_ROOT}/${OUT}")" "${SEED_DIR}"
BASE_IMG="${SEED_DIR}/base.img"
if [[ ! -f "${BASE_IMG}" ]]; then
  echo "downloading base image from ${BASE_URL}"
  curl -fSL --retry 3 -o "${BASE_IMG}" "${BASE_URL}"
fi
BASE_SHA="$(sha256sum "${BASE_IMG}" | awk '{print $1}')"
echo "base sha256: ${BASE_SHA}"

# cloud-init seed: unprivileged guest agent account, desktop packages on
# first boot. Privilege separation: eveagent has NO sudo (sudo: false);
# privileged maintenance runs via the root QGA channel, never the agent
# account. There is intentionally no NOPASSWD blanket grant.
cat > "${SEED_DIR}/user-data" <<'EOF'
#cloud-config
hostname: eve-guest
manage_etc_hosts: true
users:
  - name: eveagent
    sudo: false
    shell: /bin/bash
    lock_passwd: true
packages:
  - ubuntu-desktop-minimal
  - python3
  - curl
  - openssh-server
runcmd:
  - [ systemctl, enable, ssh ]
  - [ mkdir, -p, /opt/eve-agent ]
  - [ chmod, "0755", /opt/eve-agent ]
power_state:
  mode: reboot
  condition: true
EOF
cat > "${SEED_DIR}/meta-data" <<EOF
instance-id: eve-guest-v1
local-hostname: eve-guest
EOF
cat > "${SEED_DIR}/network-config" <<'EOF'
version: 2
ethernets:
  eth0:
    dhcp4: true
EOF

cloud-localds "${SEED_DIR}/seed.iso" "${SEED_DIR}/user-data" "${SEED_DIR}/meta-data" --network-config="${SEED_DIR}/network-config"
echo "seed iso: ${SEED_DIR}/seed.iso"

TARGET="${REPO_ROOT}/${OUT}"
qemu-img convert -p -O qcow2 "${BASE_IMG}" "${TARGET}.tmp"
qemu-img resize "${TARGET}.tmp" "${SIZE}"
mv "${TARGET}.tmp" "${TARGET}"

BUILD_SHA="$(sha256sum "${TARGET}" | awk '{print $1}')"
cat > "${TARGET}.build.json" <<EOF
{
  "image": "${OUT}",
  "seed_os": "${SEED_OS}",
  "size": "${SIZE}",
  "base_url": "${BASE_URL}",
  "base_sha256": "${BASE_SHA}",
  "image_sha256": "${BUILD_SHA}",
  "seed_iso": "images/seed/seed.iso",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "built ${TARGET} sha256=${BUILD_SHA}"
qemu-img info "${TARGET}"
