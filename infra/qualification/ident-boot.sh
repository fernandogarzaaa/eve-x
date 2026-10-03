#!/usr/bin/env bash
# ONE foreground session: API-identical VM boot, then serial+qga+frame checks.
set -u
cd /root/evex-prod
cp /mnt/e/eve-x/infra/qualification/spawn-api-ident.mjs infra/qualification/ 2>/dev/null
node infra/qualification/spawn-api-ident.mjs > /tmp/ident.log 2>&1 &
NODEPID=$!
trap "kill -9 $NODEPID 2>/dev/null" EXIT
sleep 8
VM=$(grep -o 'VM=vm-[a-f0-9]*' /tmp/ident.log | cut -d= -f2)
echo "VM=$VM"
D=/var/lib/eve-images/qual/$VM
sleep 240
echo "== console tail =="
tr -d '\000' < "$D/console.log" 2>/dev/null | tail -4
echo "== qga =="
python3 /root/qga-sync.py "$D/qga.sock" 2>&1 | head -3
echo IDENT-DONE
