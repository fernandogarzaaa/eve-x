#!/usr/bin/env bash
# ONE foreground session: spawn, flip GDM, xrandr with discovered cookie.
set -u
cd /root/evex-prod
node infra/qualification/spawn-desktop-ssh.mjs > /tmp/spawn8.log 2>&1 &
NODEPID=$!
trap "kill -9 $NODEPID 2>/dev/null" EXIT
sleep 8
VM=$(grep -o 'VM=vm-[a-f0-9]*' /tmp/spawn8.log | cut -d= -f2)
echo "VM=$VM"
SSHKEY="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -i /root/.ssh/eve-qual"
SSHPORT=""
for i in $(seq 1 40); do
  for p in $(seq 22000 22015); do
    if ssh $SSHKEY -p $p eveagent@127.0.0.1 true 2>/dev/null; then SSHPORT=$p; break 2; fi
  done
  sleep 10
done
[ -z "$SSHPORT" ] && { echo "NO-SSH"; exit 1; }
echo "SSH-UP port=$SSHPORT"
SSH="ssh $SSHKEY -p $SSHPORT eveagent@127.0.0.1"
$SSH 'sudo sed -i "s/^#WaylandEnable=false/WaylandEnable=false/" /etc/gdm3/custom.conf && sudo systemctl restart gdm3 && echo GDM-RESTARTED' 2>&1 | grep -v Warning | head -1
sleep 90
echo "== xrandr =="
$SSH 'C=$(sudo find /run -maxdepth 4 -name Xauthority -path "*gdm*" 2>/dev/null | head -1); echo "cookie=$C"; sudo XAUTHORITY=$C DISPLAY=:0 xrandr 2>&1 | head -18' 2>&1 | grep -v Warning | head -22
echo XRANDR3-DONE
