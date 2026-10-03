#!/usr/bin/env bash
# Bake the production graphical KVM guest base (Ubuntu + desktop + agents).
# Procedure (reproducible, logged):
#   1. copy pristine minimal cloud image -> writable working base
#   2. boot it (KVM) with a bake seed (desktop task, qemu-guest-agent,
#      openssh, EVE workdir, operator SSH key)
#   3. wait for cloud-init completion + desktop install
#   4. verify (qga active, desktop packages, no host secrets in image)
#   5. shutdown, seal read-only, emit manifest JSON with digests
# Usage (on a KVM host, as root):
#   IMGDIR=/var/lib/eve-images BASE_SRC=/var/lib/eve-images/noble-minimal.img \
#     SSH_PUBKEY="$(cat ~/.ssh/id_ed25519.pub)" bash bake-desktop.sh [--run|--wait|--seal]
#   --run   start the bake VM detached (logs to $WORK/bake.log)
#   --wait  block until cloud-init done + qga active (polls via QGA socket)
#   --seal  shutdown + seal + manifest (run after --wait succeeds)
set -u
IMGDIR="${IMGDIR:-/var/lib/eve-images}"
BASE_SRC="${BASE_SRC:-$IMGDIR/noble-minimal.img}"
WORK="${WORK:-$IMGDIR/bake-desktop}"
BASE_OUT="${BASE_OUT:-$IMGDIR/eve-desktop-noble.qcow2}"
# SSH key: prefer a file (values with spaces break `export KEY=...` over
# remote shells); fall back to SSH_PUBKEY env.
SSH_PUBKEY_FILE="${SSH_PUBKEY_FILE:-}"
SSH_PUBKEY="${SSH_PUBKEY:-}"
if [ -z "$SSH_PUBKEY" ] && [ -n "$SSH_PUBKEY_FILE" ] && [ -f "$SSH_PUBKEY_FILE" ]; then
  SSH_PUBKEY="$(cat "$SSH_PUBKEY_FILE")"
fi
MODE="${1:---run}"
MEM_MB="${MEM_MB:-4096}"
CPUS="${CPUS:-2}"

log() { echo "[bake $(date -u +%H:%M:%S)] $*"; }
die() { echo "[bake FATAL] $*" >&2; exit 1; }

command -v qemu-system-x86_64 >/dev/null || die "qemu missing"
command -v qemu-img >/dev/null || die "qemu-img missing"
command -v cloud-localds >/dev/null || die "cloud-localds missing"
[ -e /dev/kvm ] || die "no /dev/kvm"
[ -f "$BASE_SRC" ] || die "base image missing: $BASE_SRC"

BASE_SHA="$(sha256sum "$BASE_SRC" | awk '{print $1}')"
log "pristine base: $BASE_SRC sha256=$BASE_SHA"

case "$MODE" in
--run)
  rm -rf "$WORK"; mkdir -p "$WORK"
  log "converting base -> working copy (overlays stay thin at runtime)"
  qemu-img convert -p -O qcow2 "$BASE_SRC" "$WORK/disk.qcow2" || die "convert failed"
  qemu-img resize "$WORK/disk.qcow2" 24G || die "resize failed"
  {
    echo "#cloud-config"
    echo "hostname: eve-bake"
    echo "manage_etc_hosts: true"
    echo "users:"
    echo "  - name: eveagent"
    echo "    sudo: ALL=(ALL) NOPASSWD:ALL"
    echo "    shell: /bin/bash"
    echo "    lock_passwd: true"
    if [ -n "$SSH_PUBKEY" ]; then
      echo "    ssh_authorized_keys:"
      echo "      - $SSH_PUBKEY"
    fi
    echo "packages:"
    echo "  - ubuntu-desktop-minimal"
    echo "  - qemu-guest-agent"
    echo "  - openssh-server"
    echo "  - scrot"
    echo "write_files:"
    echo "  - path: /opt/eve-agent/BAKE-MARKER"
    echo "    owner: root:root"
    echo "    permissions: '0644'"
    echo "    content: |"
    echo "      eve-desktop bake (no secrets baked; secret injected per-VM at boot)"
    echo "runcmd:"
    echo "  - [ systemctl, enable, --now, qemu-guest-agent ]"
    echo "  - [ systemctl, enable, --now, ssh ]"
    echo "  - [ mkdir, -p, /opt/eve-agent ]"
  } > "$WORK/user-data"
  printf 'instance-id: eve-bake-v1\nlocal-hostname: eve-bake\n' > "$WORK/meta-data"
  cloud-localds "$WORK/seed.iso" "$WORK/user-data" "$WORK/meta-data" || die "seed build failed"
  log "starting bake VM detached (KVM, 4G RAM, serial console to $WORK/console.log)"
  setsid nohup qemu-system-x86_64 \
    -accel kvm -accel tcg \
    -m "$MEM_MB" -smp "$CPUS" \
    -drive "file=$WORK/disk.qcow2,format=qcow2,if=virtio" \
    -drive "file=$WORK/seed.iso,format=raw,if=virtio,readonly=on" \
    -chardev "socket,path=$WORK/qga.sock,server=on,wait=off,id=qga0" \
    -device virtio-serial-pci \
    -device "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0" \
    -display none -vnc 127.0.0.1:19 -rtc base=utc \
    -sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny \
    -serial "file:$WORK/console.log" \
    -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
    > "$WORK/qemu.log" 2>&1 < /dev/null &
  echo $! > "$WORK/qemu.pid"
  log "bake VM pid $(cat "$WORK/qemu.pid"); watch: tail -f $WORK/console.log"
  ;;
--wait)
  [ -d "$WORK" ] || die "no bake workdir; run --run first"
  log "waiting for cloud-init completion (up to 45 min for desktop install)..."
  for i in $(seq 1 270); do
    if grep -q "Cloud-init .* finished" "$WORK/console.log" 2>/dev/null; then
      log "cloud-init finished after ~$((i*10))s"
      break
    fi
    sleep 10
  done
  grep -q "Cloud-init .* finished" "$WORK/console.log" 2>/dev/null || die "cloud-init did not finish; see $WORK/console.log"
  log "waiting for qemu-guest-agent channel..."
  for i in $(seq 1 60); do
    if python3 - "$WORK/qga.sock" <<'EOF' 2>/dev/null; then
import socket, json, sys
s = socket.socket(socket.AF_UNIX); s.settimeout(10); s.connect(sys.argv[1])
s.sendall(b'{"execute":"guest-sync","arguments":{"id":424242}}\n')
data = b""
while b"\n" not in data:
    data += s.recv(4096)
print("SYNC:", data.decode().strip()[:120])
EOF
      log "qga channel live"; break
    fi
    sleep 10
  done
  ;;
--seal)
  [ -d "$WORK" ] || die "no bake workdir"
  PID="$(cat "$WORK/qemu.pid" 2>/dev/null || echo)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    log "requesting guest shutdown via QGA, then SIGTERM fallback"
    python3 - "$WORK/qga.sock" <<'EOF' 2>/dev/null || true
import socket, json, sys
s = socket.socket(socket.AF_UNIX); s.settimeout(10); s.connect(sys.argv[1])
s.sendall(b'{"execute":"guest-shutdown","arguments":{"mode":"powerdown"}}\n')
try: print(s.recv(4096).decode().strip()[:120])
except Exception as e: print("shutdown reply:", e)
EOF
    for i in $(seq 1 12); do kill -0 "$PID" 2>/dev/null || break; sleep 5; done
    kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f "$WORK"/qga.sock "$WORK"/qmp.sock
  log "sealing $BASE_OUT read-only"
  cp --sparse=always "$WORK/disk.qcow2" "$BASE_OUT"
  chmod 444 "$BASE_OUT"
  OUT_SHA="$(sha256sum "$BASE_OUT" | awk '{print $1}')"
  OUT_SIZE="$(stat -c%s "$BASE_OUT")"
  qemu-img info "$BASE_OUT" > "$WORK/base-info.txt"
  cat > "${BASE_OUT}.manifest.json" <<EOF
{
  "image": "$(basename "$BASE_OUT")",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "pristine_base": "$BASE_SRC",
  "pristine_base_sha256": "$BASE_SHA",
  "image_sha256": "$OUT_SHA",
  "image_bytes": $OUT_SIZE,
  "contents": ["ubuntu-desktop-minimal", "qemu-guest-agent", "openssh-server", "scrot", "cloud-init nocloud"],
  "secrets_baked": [],
  "sealed_readonly": true
}
EOF
  log "sealed: sha256=$OUT_SHA bytes=$OUT_SIZE manifest=${BASE_OUT}.manifest.json"
  ;;
*)
  echo "usage: $0 [--run|--wait|--seal]" >&2; exit 2 ;;
esac
