#!/usr/bin/env bash
set -u
SSHKEY="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -i /root/.ssh/eve-qual"
SSHPORT=""
for p in $(seq 22000 22040); do
  if ssh $SSHKEY -p $p eveagent@127.0.0.1 true 2>/dev/null; then SSHPORT=$p; break; fi
done
[ -z "$SSHPORT" ] && { echo "NO-SSH"; exit 1; }
SSH="ssh $SSHKEY -p $SSHPORT eveagent@127.0.0.1"
echo "== whoami/id =="; $SSH 'id; echo DISPLAY=$DISPLAY' 2>&1 | grep -v Warning | head -3
echo "== find cookies =="; $SSH 'sudo find /run /var/lib/gdm3 -maxdepth 5 -name "Xauthority" 2>/dev/null' 2>&1 | grep -v Warning | head -5
echo "== X proc =="; $SSH 'ps aux | grep Xorg | grep -v grep' 2>&1 | grep -v Warning | head -3
echo COOKIE-DONE
