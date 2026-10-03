#!/usr/bin/env bash
# Diagnose the newest qual VM: console, qga, host mem, qemu age.
set -u
D=$(ls -dt /var/lib/eve-images/qual/vm-*/ | head -1)
echo "workdir=$D"
echo "== console tail =="
tr -d '\000' < "$D/console.log" 2>/dev/null | tail -4
echo "== qga =="
python3 /root/qga-sync.py "$D/qga.sock" 2>&1 | head -2
echo "== mem =="
free -m | head -2
echo "== qemu age =="
ps -eo pid,etime,args | grep qemu-system | grep -v grep | cut -c1-60
