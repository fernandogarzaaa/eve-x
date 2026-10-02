#!/usr/bin/env bash
# EVE-X Linux doctor: read-only prerequisite diagnostics for KVM production.
# Idempotent and side-effect free (never installs or mutates).
# Exit 0 = KVM-capable host. Exit 2 = usable Linux, no KVM. Exit 3 = wrong OS/tooling.
# Usage: bash infra/linux-doctor.sh [--json]
set -u
JSON=0
[[ "${1:-}" == "--json" ]] && JSON=1

pass=0; fail=0; warn=0
declare -a ROWS
check() { # name, status(PASS|FAIL|WARN), detail
  ROWS+=("$1|$2|$3")
  case "$2" in PASS) pass=$((pass+1));; FAIL) fail=$((fail+1));; *) warn=$((warn+1));; esac
}

[ "$(uname -s)" = "Linux" ] || { echo "NOT-LINUX"; exit 3; }
check "os" PASS "$(uname -srm)"
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
check "ram" "$([ "${mem_kb:-0}" -ge 8000000 ] && echo PASS || echo WARN)" "$((mem_kb/1024/1024)) GiB total"
nproc_bin=$(command -v nproc >/dev/null && nproc || echo 0)
check "cpu" "$([ "${nproc_bin:-0}" -ge 4 ] && echo PASS || echo WARN)" "${nproc_bin} vcpus"
[ -e /dev/kvm ] && check "kvm" PASS "$(ls -la /dev/kvm | awk '{print $1, $3, $4}')" || check "kvm" FAIL "/dev/kvm absent (enable VT-x/AMD-V + nested virt)"
if command -v qemu-system-x86_64 >/dev/null; then
  check "qemu" PASS "$(qemu-system-x86_64 --version | head -1)"
  qemu-system-x86_64 -accel help 2>/dev/null | grep -q kvm \
    && check "qemu-kvm-accel" PASS "kvm accelerator listed" \
    || check "qemu-kvm-accel" WARN "kvm not in -accel help (TCG fallback only)"
else
  check "qemu" FAIL "qemu-system-x86_64 not on PATH"
  check "qemu-kvm-accel" FAIL "no qemu binary"
fi
command -v qemu-img >/dev/null && check "qemu-img" PASS "$(qemu-img --version | head -1)" || check "qemu-img" FAIL "qemu-img missing"
command -v cloud-localds >/dev/null && check "cloud-localds" PASS "$(command -v cloud-localds)" || check "cloud-localds" WARN "no seed-ISO builder (VMs boot seedless)"
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    check "docker" PASS "$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
  else
    check "docker" WARN "client present, daemon unreachable"
  fi
else
  check "docker" WARN "docker client absent"
fi
command -v nvidia-smi >/dev/null && check "gpu" PASS "$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)" || check "gpu" WARN "no NVIDIA GPU"
command -v node >/dev/null && check "node" PASS "$(node --version)" || check "node" FAIL "node missing (>=20 required)"
command -v python3 >/dev/null && check "python3" PASS "$(python3 --version 2>&1)" || check "python3" WARN "python3 missing (ML tooling only)"
[ -e /proc/1/cgroup ] && check "systemd" PASS "init system present" || check "systemd" WARN "no init info"
command -v iptables >/dev/null && check "iptables" PASS "$(iptables --version 2>&1 | head -1)" || check "iptables" WARN "iptables missing (sandbox enforcement unavailable)"
unshare --net true 2>/dev/null && check "netns" PASS "unprivileged netns works" || check "netns" WARN "no unprivileged netns"
df -BG "${EVEX_DATA_DIR:-/var/lib/eve-x}" 2>/dev/null | tail -1 | awk '{print $4}' | grep -q . \
  && check "disk" PASS "$(df -h "${EVEX_DATA_DIR:-/var/lib/eve-x}" 2>/dev/null | tail -1 | awk '{print $4}') free" \
  || check "disk" WARN "data dir not present yet"

if [ "$JSON" = 1 ]; then
  printf '{"pass":%s,"fail":%s,"warn":%s,"checks":[' "$pass" "$fail" "$warn"
  first=1
  for r in "${ROWS[@]}"; do
    IFS='|' read -r n s d <<< "$r"
    [ $first = 0 ] && printf ','
    d_clean=$(printf '%s' "$d" | tr -d '"')
    printf '{"name":"%s","status":"%s","detail":"%s"}' "$n" "$s" "$d_clean"
    first=0
  done
  printf ']}\n'
else
  for r in "${ROWS[@]}"; do echo "$r"; done
  echo "summary: pass=$pass fail=$fail warn=$warn"
fi
[ "$fail" = 0 ]
