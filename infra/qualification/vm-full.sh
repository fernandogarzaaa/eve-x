#!/usr/bin/env bash
set -u
D="$1"
echo "== files =="; ls "$D/" | head -14
echo "== user-data =="; cat "$D/user-data" 2>/dev/null | head -28
echo "== console tail =="; tr -d '\000' < "$D/console.log" 2>/dev/null | tail -6
echo "== qga =="; python3 /root/qga-sync.py "$D/qga.sock" 2>&1 | head -3
