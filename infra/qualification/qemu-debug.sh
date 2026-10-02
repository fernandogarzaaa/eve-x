#!/usr/bin/env bash
# Debug: reproduce EVE-X QEMU boot with visible stderr.
set -u
D="${1:-/var/lib/eve-images/qual/vm-8aa1032a}"
echo "== workdir =="; ls -la "$D/" | head -20
echo "== qemu-img info =="; qemu-img info "$D/disk.qcow2" | head -12
echo "== foreground boot 25s =="
timeout 25 qemu-system-x86_64 \
  -accel kvm \
  -accel tcg \
  -m 2048 -smp 2 \
  -drive "file=$D/disk.qcow2,format=qcow2,if=virtio" \
  -qmp "unix:$D/qmp.sock,server=on,wait=off" \
  -display none -vnc 127.0.0.1:10 -k en-us -rtc base=utc \
  -sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny \
  -drive "file=$D/seed.iso,format=raw,if=virtio,readonly=on" \
  -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
  > "$D/boot-debug.log" 2>&1 &
QP=$!
sleep 8
echo "== sockets =="; ls -la "$D/"*.sock 2>/dev/null || echo NO-SOCK
echo "== qemu alive? =="; kill -0 $QP 2>/dev/null && echo ALIVE || echo DEAD
echo "== stderr =="; cat "$D/boot-debug.log" | head -20
echo "== qmp greeting =="; timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/1" 2>/dev/null; python3 -c "
import socket,json
s=socket.socket(socket.AF_UNIX); s.settimeout(5)
try:
  s.connect('$D/qmp.sock')
  print('GREET:', s.recv(4096)[:120])
except Exception as e:
  print('CONNECT-FAIL:', e)
"
kill -9 $QP 2>/dev/null
wait 2>/dev/null
echo DEBUG-DONE
