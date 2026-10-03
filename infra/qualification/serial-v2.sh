#!/usr/bin/env bash
# Boot a test overlay of the sealed v2 base with serial console visible.
set -u
IMGDIR=/var/lib/eve-images/qual
rm -rf $IMGDIR/serialtest && mkdir -p $IMGDIR/serialtest
qemu-img create -f qcow2 -F qcow2 -b $IMGDIR/eve-desktop-xorg.qcow2 $IMGDIR/serialtest/disk.qcow2
timeout 120 qemu-system-x86_64 \
  -accel kvm -accel tcg -m 2048 -smp 2 \
  -drive file=$IMGDIR/serialtest/disk.qcow2,format=qcow2,if=virtio \
  -display none -rtc base=utc \
  -serial file:$IMGDIR/serialtest/console.log \
  -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
  > $IMGDIR/serialtest/qemu.log 2>&1 &
QP=$!
sleep 100
echo "--- console tail ---"
tr -d '\000' < $IMGDIR/serialtest/console.log 2>/dev/null | tail -15
kill -9 $QP 2>/dev/null
echo SERIAL-TEST-DONE
