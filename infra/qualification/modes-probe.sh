#!/usr/bin/env bash
# ONE foreground session: spawn desktop VM, wait SSH, deep display inspection.
set -u
cd /root/evex-prod
node infra/qualification/spawn-desktop-ssh.mjs > /tmp/spawn3.log 2>&1 &
NODEPID=$!
trap "kill -9 $NODEPID 2>/dev/null" EXIT
sleep 8
VM=$(grep -o 'VM=vm-[a-f0-9]*' /tmp/spawn3.log | cut -d= -f2)
echo "VM=$VM"
SSHKEY="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -i /root/.ssh/eve-qual"
SSHPORT=""
for i in $(seq 1 40); do
  for p in 22000 22001 22002 22003 22004 22005 22006 22007 22008 22009; do
    if ssh $SSHKEY -p $p eveagent@127.0.0.1 true 2>/dev/null; then SSHPORT=$p; break 2; fi
  done
  sleep 10
done
[ -z "$SSHPORT" ] && { echo "NO-SSH"; exit 1; }
echo "SSH-UP port=$SSHPORT"
SSH="ssh $SSHKEY -p $SSHPORT eveagent@127.0.0.1"
echo "== Xorg binary =="; $SSH 'ls -la /usr/bin/Xorg /usr/bin/Xwayland 2>&1' 2>&1 | grep -v Warning | head -4
echo "== sessions =="; $SSH 'loginctl list-sessions 2>&1' 2>&1 | grep -v Warning | head -6
echo "== gdm config =="; $SSH 'grep -m2 WaylandEnable /etc/gdm3/custom.conf 2>&1; ls /usr/share/xsessions/ 2>&1; ls /usr/share/wayland-sessions/ 2>&1' 2>&1 | grep -v Warning | head -8
echo "== X sockets =="; $SSH 'ls /tmp/.X11-unix/ 2>&1; ps aux 2>/dev/null | grep -m3 -E "gdm|gnome-shell" | awk "{print \$11,\$12,\$13}"' 2>&1 | grep -v Warning | head -8
echo DEEP-DONE
