#!/usr/bin/env bash
for pid in $(pgrep -f qemu-system-x86_64); do
  echo "== pid $pid =="
  tr '\0' ' ' < /proc/$pid/cmdline | fold -s -w 220 | head -8
done
echo QEMU-LIST-DONE
