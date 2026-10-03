#!/usr/bin/env bash
# ONE foreground session: read Xorg modes using GDM's cookie. VM stays RUNNING.
set -u
VM=$(cat /tmp/xorg-vm.txt 2>/dev/null || echo "")
[ -z "$VM" ] && { echo "NO-VM-RECORD"; exit 1; }
echo "VM=$VM"
SSHKEY="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -i /root/.ssh/eve-qual"
SSHPORT=""
for p in 22000 22001 22002 22003 22004 22005 22006 22007 22008 22009; do
  if ssh $SSHKEY -p $p eveagent@127.0.0.1 true 2>/dev/null; then SSHPORT=$p; break; fi
done
[ -z "$SSHPORT" ] && { echo "NO-SSH"; exit 1; }
SSH="ssh $SSHKEY -p $SSHPORT eveagent@127.0.0.1"
echo "== modes via gdm cookie =="
$SSH 'for c in /run/user/*/gdm/Xauthority /var/lib/gdm3/.Xauthority /run/gdm*/auth*; do [ -f "$c" ] && { echo "cookie: $c"; XAUTHORITY=$c DISPLAY=:0 xrandr 2>&1 | head -14; break; }; done' 2>&1 | grep -v Warning | head -20
echo XRANDR-DONE
