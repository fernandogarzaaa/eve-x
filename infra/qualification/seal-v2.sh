#!/usr/bin/env bash
# ONE foreground session: overlay the sealed v1 base, flip GDM to Xorg,
# verify, power off, merge+seal as eve-desktop-xorg.qcow2 v2 golden base.
set -u
cd /root/evex-prod
node infra/qualification/spawn-desktop-ssh.mjs > /tmp/spawn9.log 2>&1 &
NODEPID=$!
trap "kill -9 $NODEPID 2>/dev/null" EXIT
sleep 8
VM=$(grep -o 'VM=vm-[a-f0-9]*' /tmp/spawn9.log | cut -d= -f2)
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
$SSH 'sudo sed -i "s/^#WaylandEnable=false/WaylandEnable=false/" /etc/gdm3/custom.conf && grep -m1 WaylandEnable /etc/gdm3/custom.conf && sudo systemctl restart gdm3 && echo GDM-RESTARTED' 2>&1 | grep -v Warning | head -3
sleep 90
$SSH 'C=$(sudo find /run -maxdepth 4 -name Xauthority -path "*gdm*" 2>/dev/null | head -1); sudo XAUTHORITY=$C DISPLAY=:0 xrandr 2>&1 | head -3' 2>&1 | grep -v Warning | head -5
echo "== powering off guest =="
$SSH 'sudo poweroff' 2>&1 | head -1
sleep 30
kill -9 $NODEPID 2>/dev/null
sleep 2
pkill -9 -f "$VM" 2>/dev/null
sleep 3
if pgrep -f "$VM" >/dev/null 2>&1; then echo "QEMU-STILL-ALIVE-ABORT"; exit 1; fi
echo "== merging overlay into v2 golden base =="
qemu-img convert -p -O qcow2 "/var/lib/eve-images/qual/$VM/disk.qcow2" /var/lib/eve-images/eve-desktop-xorg.qcow2.tmp
mv /var/lib/eve-images/eve-desktop-xorg.qcow2.tmp /var/lib/eve-images/eve-desktop-xorg.qcow2
chmod 444 /var/lib/eve-images/eve-desktop-xorg.qcow2
OUT_SHA=$(sha256sum /var/lib/eve-images/eve-desktop-xorg.qcow2 | awk '{print $1}')
OUT_SIZE=$(stat -c%s /var/lib/eve-images/eve-desktop-xorg.qcow2)
cat > /var/lib/eve-images/eve-desktop-xorg.qcow2.manifest.json <<EOF
{
  "image": "eve-desktop-xorg.qcow2",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "derived_from": "eve-desktop-noble.qcow2 (overlay merge + GDM Xorg flip)",
  "image_sha256": "$OUT_SHA",
  "image_bytes": $OUT_SIZE,
  "contents": ["ubuntu-desktop-minimal", "qemu-guest-agent", "openssh-server", "scrot", "GDM Xorg (WaylandEnable=false)"],
  "secrets_baked": [],
  "sealed_readonly": true
}
EOF
echo "sealed v2: sha256=$OUT_SHA bytes=$OUT_SIZE"
echo SEAL-V2-DONE
