#!/usr/bin/env bash
for pid in $(pgrep -f qemu-system-x86_64); do
  echo "== pid $pid =="
  tr '\0' ' ' < /proc/$pid/cmdline | grep -o ' */var/lib/eve-images/[^ ]*' | head -3
done
echo ORPHAN-LIST-DONE
