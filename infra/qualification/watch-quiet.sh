#!/usr/bin/env bash
# Watch a VM boot with ZERO API contact: serial tail + qga sync only.
set -u
D="$1"
for i in $(seq 1 30); do
  echo "--- t=$((i*20))s ---"
  tr -d '\000' < "$D/console.log" 2>/dev/null | tail -2 | cut -c1-100
  python3 /root/qga-sync.py "$D/qga.sock" 2>&1 | head -2
  sleep 20
done
echo WATCH-DONE
