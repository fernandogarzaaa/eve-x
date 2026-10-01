#!/usr/bin/env bash
# EVE-X Linux production bootstrap (Ubuntu 24.04+). Idempotent: safe to re-run.
# Sets up KVM/QEMU, service user + groups, DATA_DIR layout, qcow2 guest image
# hook, systemd units (evex-api/worker/mcp/console), sysctl limits, and a
# verification pass (curl /health + eve-x doctor).
#
# Usage: sudo bash infra/deployment/linux-bootstrap.sh [--repo DIR] [--user evex]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SVC_USER="evex"
DATA_DIR="/var/lib/evex"
OBJECT_DIR="/var/lib/evex/objects"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_DIR="$2"; shift 2 ;;
    --user) SVC_USER="$2"; shift 2 ;;
    -h|--help) echo "usage: linux-bootstrap.sh [--repo DIR] [--user evex]"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { echo "[bootstrap] $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

require_ubuntu() {
  if [[ ! -f /etc/os-release ]]; then echo "refusing: /etc/os-release missing" >&2; exit 1; fi
  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then echo "refusing: ID=${ID:-?} (need ubuntu)" >&2; exit 1; fi
  local major="${VERSION_ID%%.*}"
  if [[ "${major:-0}" -lt 24 ]]; then echo "refusing: Ubuntu ${VERSION_ID} < 24.04" >&2; exit 1; fi
  log "host: ${PRETTY_NAME:-ubuntu}"
}

ensure_user() {
  if ! id -u "$SVC_USER" >/dev/null 2>&1; then
    log "creating user $SVC_USER"
    useradd --system --create-home --home-dir "/home/$SVC_USER" --shell /usr/sbin/nologin "$SVC_USER"
  else
    log "user $SVC_USER exists"
  fi
}

kvm_check() {
  if [[ -e /dev/kvm ]]; then
    log "KVM present (/dev/kvm)"
    return 0
  fi
  log "WARNING: /dev/kvm missing — VMs fall back to process isolation until KVM is enabled (BIOS VT-x/AMD-V)"
  return 1
}

ensure_pkgs() {
  local missing=()
  for pkg in qemu-kvm qemu-utils libvirt-daemon-system curl nodejs npm python3; do
    if dpkg -s "$pkg" >/dev/null 2>&1; then
      log "pkg $pkg present"
    else
      missing+=("$pkg")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    log "installing: ${missing[*]}"
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"
  fi
}

ensure_groups() {
  for grp in kvm libvirt; do
    if getent group "$grp" >/dev/null; then
      if id -nG "$SVC_USER" | tr ' ' '\n' | grep -qx "$grp"; then
        log "$SVC_USER already in $grp"
      else
        log "adding $SVC_USER to $grp"
        usermod -aG "$grp" "$SVC_USER"
      fi
    else
      log "WARNING: group $grp absent (libvirt install creates it)"
    fi
  done
}

hugepages_note() {
  local hugepages
  hugepages="$(cat /proc/sys/vm/nr_hugepages 2>/dev/null || echo 0)"
  log "hugepages: nr_hugepages=$hugepages (optional tuning: sysctl -w vm.nr_hugepages=1024 for large guests)"
}

data_layout() {
  for d in "$DATA_DIR" "$OBJECT_DIR" "$DATA_DIR/control" "$DATA_DIR/traces"; do
    if [[ -d "$d" ]]; then log "dir $d exists"; else log "creating $d"; mkdir -p "$d"; fi
  done
  chown -R "$SVC_USER":"$SVC_USER" "$DATA_DIR"
  chmod 0750 "$DATA_DIR"
}

guest_image() {
  local build="$REPO_DIR/infra/vm-images/build.sh"
  if [[ -x "$build" ]]; then
    log "building/fetching qcow2 image via infra/vm-images/build.sh"
    bash "$build"
  else
    log "WARNING: $build missing or not executable — stage ubuntu-desktop-v1.qcow2 manually"
  fi
}

write_unit() {
  local name="$1"; local desc="$2"; local exec="$3"; local env="$4"
  local path="/etc/systemd/system/${name}.service"
  local tmp="${path}.tmp"
  cat > "$tmp" <<EOF
[Unit]
Description=EVE-X $desc
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$REPO_DIR
Environment=$env
Environment=DATA_DIR=$DATA_DIR
Environment=OBJECT_DIR=$OBJECT_DIR
ExecStart=$exec
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
  if [[ -f "$path" ]] && cmp -s "$tmp" "$path"; then
    log "unit $name unchanged"
    rm -f "$tmp"
  else
    log "installing unit $name"
    mv "$tmp" "$path"
    systemctl daemon-reload
  fi
  if ! systemctl is-enabled -q "$name"; then systemctl enable "$name"; fi
}

sysctl_limits() {
  local conf="/etc/sysctl.d/99-evex.conf"
  local want="fs.file-max = 2097152
net.core.somaxconn = 1024
vm.max_map_count = 262144"
  if [[ -f "$conf" ]] && [[ "$(cat "$conf")" == "$want" ]]; then
    log "sysctl 99-evex.conf unchanged"
  else
    log "writing $conf"
    printf '%s\n' "$want" > "$conf"
    sysctl --system >/dev/null || true
  fi
}

verify() {
  log "verification: curl /health"
  curl -fsS --max-time 10 http://localhost:8080/health || log "WARNING: api /health unreachable (start units: systemctl start evex-api)"
  if [[ -x "$REPO_DIR/dist/apps/cli/src/index.js" ]]; then
    log "verification: eve-x doctor"
    node "$REPO_DIR/dist/apps/cli/src/index.js" doctor || log "WARNING: doctor reported failures (see above)"
  else
    log "WARNING: dist missing — run 'npm run build' in $REPO_DIR, then re-run this script"
  fi
}

main() {
  require_ubuntu
  ensure_user
  kvm_check || true
  ensure_pkgs
  ensure_groups
  hugepages_note
  data_layout
  guest_image
  local node_bin="node"
  write_unit "evex-api" "control-plane API" "$node_bin $REPO_DIR/dist/apps/api/src/index.js" "PORT=8080"
  write_unit "evex-worker" "evaluation worker" "$node_bin $REPO_DIR/dist/apps/worker/src/index.js" "PORT=8080"
  write_unit "evex-mcp" "MCP server (stdio)" "$node_bin $REPO_DIR/dist/apps/mcp/src/index.js" "MCP_PORT=8091"
  write_unit "evex-console" "operator console" "$node_bin $REPO_DIR/dist/apps/console/src/index.js" "CONSOLE_PORT=3000"
  sysctl_limits
  verify
  log "done (re-run anytime; all steps are idempotent)"
}

main "$@"
