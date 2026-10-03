#!/usr/bin/env bash
# ONE foreground session: API-identical VM + SSH, deep guest inspection.
set -u
cd /root/evex-prod
cp /mnt/e/eve-x/infra/qualification/spawn-api-repro.mjs infra/qualification/ 2>/dev/null
node infra/qualification/spawn-api-repro.mjs > /tmp/repro.log 2>&1 &
NODEPID=$!
trap "kill -9 $NODEPID 2>/dev/null" EXIT
sleep 8
VM=$(grep -o 'VM=vm-[a-f0-9]*' /tmp/repro.log | cut -d= -f2)
echo "VM=$VM"
SSHKEY="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -i /root/.ssh/eve-qual"
SSHPORT=""
for i in $(seq 1 50); do
  for p in $(seq 22000 22025); do
    if ssh $SSHKEY -p $p eveagent@127.0.0.1 true 2>/dev/null; then SSHPORT=$p; break 2; fi
  done
  sleep 10
done
[ -z "$SSHPORT" ] && { echo "NO-SSH"; exit 1; }
echo "SSH-UP port=$SSHPORT"
SSH="ssh $SSHKEY -p $SSHPORT eveagent@127.0.0.1"
echo "== qga service =="; $SSH 'systemctl status qemu-guest-agent --no-pager 2>&1 | head -12' 2>&1 | grep -v Warning | head -13
echo "== vport =="; $SSH 'ls -la /dev/vport* 2>&1' 2>&1 | grep -v Warning | head -3
echo "== gdm/display =="; $SSH 'systemctl is-active gdm3 display-manager 2>&1; ls /tmp/.X11-unix/ 2>&1; loginctl list-sessions 2>&1 | head -5' 2>&1 | grep -v Warning | head -8
echo REPRO-DONE
