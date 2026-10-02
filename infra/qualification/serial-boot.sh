#!/usr/bin/env bash
# Boot an existing qual workdir with serial console visible, watch boot.
set -u
D="${1:?workdir}"
echo "== serial boot 240s =="
timeout 240 qemu-system-x86_64 \
  -accel kvm \
  -accel tcg \
  -m 2048 -smp 2 \
  -drive "file=$D/disk.qcow2,format=qcow2,if=virtio" \
  -drive "file=$D/seed.iso,format=raw,if=virtio,readonly=on" \
  -display none -rtc base=utc \
  -serial "file:$D/console.log" \
  -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
  > "$D/serial-debug.log" 2>&1 &
QP=$!
for i in $(seq 1 24); do
  sleep 10
  if ! kill -0 $QP 2>/dev/null; then echo "QEMU EXITED EARLY"; break; fi
  echo "--- t=${i}0s ---"
  tail -c 1500 "$D/console.log" 2>/dev/null | tr -d '\000' | tail -8
done
kill -9 $QP 2>/dev/null
echo SERIAL-DONE
