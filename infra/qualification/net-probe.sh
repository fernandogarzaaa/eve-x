#!/usr/bin/env bash
# Probe Windows-host service reachability from inside WSL2.
for spec in "5433 pg" "6380 redis" "3900 garage"; do
  set -- $spec
  if timeout 5 bash -c "echo > /dev/tcp/127.0.0.1/$1" 2>/dev/null; then
    echo "$2-REACHABLE"
  else
    echo "$2-BLOCKED"
  fi
done
ip route show default 2>/dev/null | head -1
