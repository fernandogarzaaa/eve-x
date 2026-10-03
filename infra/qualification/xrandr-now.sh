#!/usr/bin/env bash
# Query current xrandr mode on the live desktop VM (no spawn; uses open SSH).
set -u
SSHKEY="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -i /root/.ssh/eve-qual"
for p in $(seq 22000 22040); do
  if ssh $SSHKEY -p $p eveagent@127.0.0.1 true 2>/dev/null; then
    echo "SSH port=$p"
    ssh $SSHKEY -p $p eveagent@127.0.0.1 'C=$(sudo find /run -maxdepth 4 -name Xauthority -path "*gdm*" 2>/dev/null | head -1); echo "cookie=$C"; sudo XAUTHORITY=$C DISPLAY=:0 xrandr 2>&1 | head -10' 2>&1 | grep -v Warning | head -14
    exit 0
  fi
done
echo NO-SSH
