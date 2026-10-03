#!/usr/bin/env bash
set -u
D=/var/lib/eve-images/qual/vm-969d9500
echo "== console tail =="
tr -d '\000' < "$D/console.log" 2>/dev/null | tail -12
echo "== files =="
ls -la "$D/" | head -14
