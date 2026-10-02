#!/usr/bin/env bash
# Boot, wait for SSH (guest fully up), then dump qga.sock raw bytes.
set -u
cd /root/evex/infra/qualification
node spawn-ssh-vm.mjs > spawndump.log 2>&1 &
NODEPID=$!
sleep 8
VM=$(grep -o 'VM=vm-[a-f0-9]*' spawndump.log | cut -d= -f2)
echo "VM=$VM"
SSH="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -i /root/.ssh/eve-qual -p 22000 eveagent@127.0.0.1"
for i in $(seq 1 40); do
  if $SSH true 2>/dev/null; then echo "SSH-UP ~$((i*10))s"; break; fi
  sleep 10
done
sleep 240
echo "== qga state =="; $SSH "systemctl is-active qemu-guest-agent" 2>&1 | grep -v Warning
node qga-dump.mjs
kill -9 $NODEPID 2>/dev/null
echo DUMP-SESSION-DONE
