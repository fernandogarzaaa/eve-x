#!/usr/bin/env bash
# EVE-X Linux qualification orchestrator: doctor → KVM qual → evidence bundle.
# Idempotent stages; any stage may be skipped with SKIP_<stage>=1.
# Required on the host: node>=20, qemu, qemu-img, cloud-localds (for seeds).
# Env knobs: IMGDIR, BASE_SRC, ARTDIR, REPO (default: script's repo root).
# Usage: sudo -E bash infra/linux-qualification.sh [--repo DIR]
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
ARTDIR="${ARTDIR:-${REPO}/artifacts/qualification}"
IMGDIR="${IMGDIR:-/var/lib/eve-images/qual}"
BASE_SRC="${BASE_SRC:-/var/lib/eve-images/noble-minimal.img}"

pass=0; fail=0
stage() { # name, command...
  local name="$1"; shift
  echo "=== stage: $name ==="
  if "$@"; then echo "STAGE-PASS $name"; pass=$((pass+1)); else echo "STAGE-FAIL $name"; fail=$((fail+1)); fi
}

export IMGDIR BASE_SRC ARTDIR
mkdir -p "$ARTDIR" "$IMGDIR"

[ -z "${SKIP_DOCTOR:-}" ] && stage "doctor" bash "${REPO}/infra/linux-doctor.sh"
[ -z "${SKIP_BUILD:-}" ] && stage "repo-build" bash -c "cd '${REPO}' && npm run build"
if [ -z "${SKIP_KVM:-}" ]; then
  if [ -e /dev/kvm ] && command -v qemu-system-x86_64 >/dev/null; then
    stage "kvm-qual" bash -c "cd '${REPO}' && node infra/qualification/wsl-kvm-qual.mjs"
  else
    echo "STAGE-SKIP kvm-qual (no /dev/kvm or qemu); marking NOT_AVAILABLE"
    echo '{"status":"NOT_AVAILABLE","reason":"no KVM on this host"}' > "${ARTDIR}/kvm-qual-skip.json"
  fi
fi
[ -z "${SKIP_SECRETS:-}" ] && stage "secret-scan" bash -c "cd '${REPO}' && node scripts/security-audit.mjs > '${ARTDIR}/security.json'"

cat > "${ARTDIR}/environment.json" <<EOF
{
  "at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "repo": "${REPO}",
  "kernel": "$(uname -r)",
  "qemu": "$(qemu-system-x86_64 --version 2>/dev/null | head -1)",
  "kvm": "$([ -e /dev/kvm ] && echo present || echo absent)"
}
EOF
echo "stages: pass=$pass fail=$fail; evidence in $ARTDIR"
[ "$fail" = 0 ]
