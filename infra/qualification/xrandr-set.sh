#!/usr/bin/env bash
# Copy GDM cookie to a readable path, set 1280x800, verify current mode.
set -u
SSHKEY="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -i /root/.ssh/eve-qual"
SSHPORT=""
for p in $(seq 22000 22040); do
  if ssh $SSHKEY -p $p eveagent@127.0.0.1 true 2>/dev/null; then SSHPORT=$p; break; fi
done
[ -z "$SSHPORT" ] && { echo "NO-SSH"; exit 1; }
SSH="ssh $SSHKEY -p $SSHPORT eveagent@127.0.0.1"
$SSH 'sudo cp /run/user/119/gdm/Xauthority /tmp/xauth-eve 2>/dev/null || sudo cp $(sudo find /run -maxdepth 4 -name Xauthority 2>/dev/null | head -1) /tmp/xauth-eve; sudo chmod 644 /tmp/xauth-eve; XAUTHORITY=/tmp/xauth-eve DISPLAY=:0 xrandr --output default --mode 1280x800 && echo MODE-SET' 2>&1 | grep -v Warning | head -3
sleep 3
$SSH 'XAUTHORITY=/tmp/xauth-eve DISPLAY=:0 xrandr 2>&1 | head -3' 2>&1 | grep -v Warning | head -4
echo XSET2-DONE
