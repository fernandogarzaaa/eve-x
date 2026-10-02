#!/usr/bin/env bash
# Foreground SSH diagnostic session: spawn VM, wait, probe guest, report.
set -u
cd /root/evex/infra/qualification
node spawn-ssh-vm.mjs > spawn.log 2>&1 &
NODEPID=$!
VM=$(sleep 5; grep -o 'VM=vm-[a-f0-9]*' spawn.log | cut -d= -f2)
echo "VM=$VM nodepid=$NODEPID"
SSH="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -i /root/.ssh/eve-qual -p 22000 eveagent@127.0.0.1"
for i in $(seq 1 30); do
  if $SSH true 2>/dev/null; then echo "SSH-UP after ~$((i*10))s"; break; fi
  sleep 10
done
echo "== qga status =="; $SSH "systemctl is-active qemu-guest-agent; systemctl is-enabled qemu-guest-agent" 2>&1 | head -4
echo "== vports =="; $SSH "ls /dev/vport* 2>&1" | head -4
echo "== qga journal =="; $SSH "journalctl -u qemu-guest-agent --no-pager -n 12 2>&1" | tail -12
echo "== secret match =="; $SSH "cat /opt/eve-agent/secret 2>&1" | head -2
echo "== host secret =="; cat "/var/lib/eve-images/qual/$VM/guest-secret" 2>/dev/null
echo "== cloud-init =="; $SSH "cloud-init status 2>&1" | head -2
kill -9 $NODEPID 2>/dev/null
echo SSH-PROBE-DONE
