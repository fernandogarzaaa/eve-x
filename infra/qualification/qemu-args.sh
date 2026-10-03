#!/usr/bin/env bash
for pid in $(pgrep -f qemu-system-x86_64); do
  echo "== pid $pid =="
  tr '\0' ' ' < /proc/$pid/cmdline | fold -s -w 200 | head -12
done
