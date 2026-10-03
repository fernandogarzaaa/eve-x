#!/usr/bin/env bash
set -u
D="$1"
echo "== workdir: $D =="
ls "$D/" | head -16
echo "== user-data =="
cat "$D/user-data" 2>/dev/null | head -30
echo "== console tail =="
tr -d '\000' < "$D/console.log" 2>/dev/null | tail -6
