#!/usr/bin/env bash
# Show serial console tail + qga state for the newest qual workdir.
set -u
D=$(ls -dt /var/lib/eve-images/qual/vm-* 2>/dev/null | head -1)
echo "workdir=$D"
echo "== console tail =="
tr -d '\000' < "$D/console.log" 2>/dev/null | tail -8
echo "== qga =="
python3 - "$D/qga.sock" <<'EOF' 2>&1 | head -4
import socket, sys
s = socket.socket(socket.AF_UNIX); s.settimeout(8); s.connect(sys.argv[1])
s.sendall(b'{"execute":"guest-sync","arguments":{"id":5}}\n')
print(s.recv(4096).decode().strip()[:80])
EOF
echo CONSOLE-CHECK-DONE
