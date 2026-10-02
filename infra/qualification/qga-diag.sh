#!/usr/bin/env bash
# Decisive qga/apt diagnosis: fresh VM, wait, inspect guest package state.
set -u
cd /root/evex/infra/qualification
node spawn-ssh-vm.mjs > spawn2.log 2>&1 &
NODEPID=$!
sleep 10
VM=$(grep -o 'VM=vm-[a-f0-9]*' spawn2.log | cut -d= -f2)
echo "VM=$VM"
SSH="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -i /root/.ssh/eve-qual -p 22000 eveagent@127.0.0.1"
for i in $(seq 1 36); do
  if $SSH true 2>/dev/null; then echo "SSH-UP ~$((i*10))s"; break; fi
  sleep 10
done
sleep 240
echo "== qga =="; $SSH "systemctl is-active qemu-guest-agent; dpkg -l qemu-guest-agent 2>&1 | tail -1" 2>&1 | grep -v Warning
echo "== apt log tail =="; $SSH "tail -5 /var/log/cloud-init-output.log 2>&1; grep -i -m3 'error\|fail' /var/log/cloud-init-output.log 2>&1 | head -5" 2>&1 | grep -v Warning | head -10
echo "== net =="; $SSH "ping -c1 -W3 8.8.8.8 2>&1 | tail -2; ping -c1 -W3 archive.ubuntu.com 2>&1 | tail -2" 2>&1 | grep -v Warning | head -6
kill -9 $NODEPID 2>/dev/null
echo DIAG-DONE
