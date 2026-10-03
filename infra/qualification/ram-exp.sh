#!/usr/bin/env bash
# ONE foreground session: boot 4G + 8G twins, poll both qga channels.
set -u
cd /root/evex-prod
cp /mnt/e/eve-x/infra/qualification/ram-exp.mjs infra/qualification/ 2>/dev/null
node infra/qualification/ram-exp.mjs > /tmp/ramexp.log 2>&1 &
NODEPID=$!
trap "kill -9 $NODEPID 2>/dev/null" EXIT
sleep 10
cat /tmp/ramexp.log
VMS=$(grep -o 'VM=vm-[a-f0-9]*' /tmp/ramexp.log | cut -d= -f2 || true)
echo "vms: $VMS"
for i in $(seq 1 30); do
  for vm in $VMS; do
    D=/var/lib/eve-images/qual/$vm
    R=$(python3 /root/qga-sync.py "$D/qga.sock" 2>&1 | head -1)
    echo "t=$((i*20))s $vm :: $R"
  done
  sleep 20
done
echo RAM-EXP-DONE
