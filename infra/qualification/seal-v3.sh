#!/usr/bin/env bash
# ONE foreground session: overlay the sealed v2 base, enable GDM autologin
# for eveagent (+ disable screen lock/idle suspend, which would otherwise
# lock a passwordless account forever), verify a graphical session starts
# with no manual login, power off, merge+seal as eve-desktop-autologin.qcow2.
# Why: v2 boots to a GDM login no one can pass (password locked, no
# autologin) — all "desktop" qual ran at the login screen.
set -u
cd /root/evex-prod
node infra/qualification/spawn-desktop-ssh.mjs > /tmp/spawn10.log 2>&1 &
NODEPID=$!
trap "kill -9 $NODEPID 2>/dev/null" EXIT
sleep 8
VM=$(grep -o 'VM=vm-[a-f0-9]*' /tmp/spawn10.log | cut -d= -f2)
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
echo "== writing GDM autologin (keep Xorg flip) =="
$SSH 'sudo tee /etc/gdm3/custom.conf > /dev/null <<EOF
[daemon]
WaylandEnable=false
AutomaticLoginEnable=True
AutomaticLogin=eveagent
[security]
[xdmcp]
[chooser]
[debug]
EOF
grep -E "WaylandEnable|AutomaticLogin" /etc/gdm3/custom.conf' 2>&1 | grep -v Warning | head -5
echo "== disabling lock/idle/suspend for the kiosk account =="
$SSH 'sudo -u eveagent DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u eveagent)/bus gsettings set org.gnome.desktop.screensaver lock-enabled false; sudo -u eveagent DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u eveagent)/bus gsettings set org.gnome.desktop.screensaver idle-activation-enabled false; sudo -u eveagent DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u eveagent)/bus gsettings set org.gnome.desktop.session idle-delay 0; sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target 2>/dev/null; echo LOCK-OFF' 2>&1 | grep -v Warning | head -3
echo "== restarting GDM, waiting for autologin =="
$SSH 'sudo systemctl restart gdm3 && echo GDM-RESTARTED' 2>&1 | grep -v Warning | head -2
sleep 60
echo "== verifying graphical session without manual login =="
$SSH 'loginctl list-sessions --no-legend 2>/dev/null; echo ---; pgrep -u eveagent -a gnome-session-binary 2>/dev/null | head -2 || pgrep -u eveagent gnome-session | head -2; echo ---; loginctl show-user eveagent -p State 2>/dev/null' 2>&1 | grep -v Warning | head -10
echo "== powering off guest =="
$SSH 'sudo poweroff' 2>&1 | head -1
sleep 30
kill -9 $NODEPID 2>/dev/null
sleep 2
pkill -9 -f "$VM" 2>/dev/null
sleep 3
if pgrep -f "$VM" >/dev/null 2>&1; then echo "QEMU-STILL-ALIVE-ABORT"; exit 1; fi
echo "== merging overlay into autologin golden base =="
qemu-img convert -p -O qcow2 "/var/lib/eve-images/qual/$VM/disk.qcow2" /var/lib/eve-images/eve-desktop-autologin.qcow2.tmp
mv /var/lib/eve-images/eve-desktop-autologin.qcow2.tmp /var/lib/eve-images/eve-desktop-autologin.qcow2
chmod 444 /var/lib/eve-images/eve-desktop-autologin.qcow2
OUT_SHA=$(sha256sum /var/lib/eve-images/eve-desktop-autologin.qcow2 | awk '{print $1}')
OUT_SIZE=$(stat -c%s /var/lib/eve-images/eve-desktop-autologin.qcow2)
cat > /var/lib/eve-images/eve-desktop-autologin.qcow2.manifest.json <<EOF
{
  "image": "eve-desktop-autologin.qcow2",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "derived_from": "eve-desktop-xorg.qcow2 (overlay merge + GDM autologin eveagent + lock/idle/suspend off)",
  "image_sha256": "$OUT_SHA",
  "image_bytes": $OUT_SIZE,
  "contents": ["ubuntu-desktop-minimal", "qemu-guest-agent", "openssh-server", "scrot", "GDM Xorg + autologin"],
  "secrets_baked": [],
  "sealed_readonly": true
}
EOF
echo "sealed v3: sha256=$OUT_SHA bytes=$OUT_SIZE"
echo SEAL-V3-DONE
