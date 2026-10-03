#!/usr/bin/env bash
set -u
D="$1"
echo "== files =="; ls -la "$D/" | head -14
echo "== qga listener =="; ss -x 2>/dev/null | grep -m2 qga || echo "no ss; trying netstat"; netstat -x 2>/dev/null | grep -m2 qga || true
echo "== qemu cmdline tail =="; tr '\0' ' ' < /proc/$(pgrep -f "$D/disk" | head -1)/cmdline 2>/dev/null | fold -s -w 200 | grep -m2 -o "virtserialport[^ ]*\|chardev[^ ]*qga[^ ]*\|-device VGA[^ ]*" | head -5
